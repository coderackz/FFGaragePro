import { afterEach, describe, expect, it } from "vitest";
import { applyAtCloud, applyAtPc, changesFor, getState, installCapture, localChanges, maxSeq, setState } from "../src/index";
import { call, createPart, garageApp, onHand, setUp, twin, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

/** A PC garage (A) and its cloud copy (C), as right after a link: same data, capture on both. */
async function pair(seed?: (app: App, token: string) => Promise<void>) {
  const A = await garageApp();
  apps.push(A);
  const token = await setUp(A);
  await seed?.(A, token);
  const C = await garageApp(twin(A.db));
  apps.push(C);
  installCapture(A.db, "local");
  installCapture(C.db, "cloud");
  const push = () => {
    const entries = localChanges(A.db, Number(getState(A.db, "last_pushed_seq") ?? 0));
    const result = applyAtCloud(C.db, "P1", entries);
    if (entries.length) setState(A.db, "last_pushed_seq", String(entries.at(-1)!.seq));
    return { entries, result };
  };
  const pull = () => applyAtPc(A.db, changesFor(C.db, Number(getState(A.db, "last_pulled_seq") ?? 0), "P1"));
  const sync = () => {
    const pushed = push();
    return { pushed, pulled: pull() };
  };
  return { A, C, token, push, pull, sync };
}

const customer = async (app: App, token: string, name = "Ahmed") => (await call(app, "POST", "/api/customers", token, { name, phone: "050 1" })).body.customer;
const getCustomer = (app: App, id: string) => app.db.get<{ name: string; phone: string }>("SELECT name, phone FROM customers WHERE id = ?", [id])!;
const tick = () => new Promise((r) => setTimeout(r, 3));

describe("merge engine", () => {
  it("different fields of one customer both survive", async () => {
    let id = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      id = (await customer(app, t)).id;
    });
    await call(A, "PATCH", `/api/customers/${id}`, token, { phone: "050 9" });
    await call(C, "PATCH", `/api/customers/${id}`, token, { name: "Ahmed Ali" });
    sync();
    expect(getCustomer(C, id)).toMatchObject({ name: "Ahmed Ali", phone: "050 9" });
    expect(getCustomer(A, id)).toMatchObject({ name: "Ahmed Ali", phone: "050 9" });
  });

  it("same field: the later push wins at the cloud; the PC keeps an unpushed local edit", async () => {
    let id = "";
    const { A, C, token, pull, sync } = await pair(async (app, t) => {
      id = (await customer(app, t)).id;
    });
    await call(C, "PATCH", `/api/customers/${id}`, token, { name: "From browser" });
    await tick();
    await call(A, "PATCH", `/api/customers/${id}`, token, { name: "From PC" });
    pull();
    expect(getCustomer(A, id).name).toBe("From PC");
    sync();
    expect(getCustomer(C, id).name).toBe("From PC");
    expect(getCustomer(A, id).name).toBe("From PC");
    // The browser edits again later: that one now wins everywhere.
    await call(C, "PATCH", `/api/customers/${id}`, token, { name: "Browser again" });
    sync();
    expect(getCustomer(A, id).name).toBe("Browser again");
  });

  it("same plate added on both sides offline → (2) on the incoming one, one sync issue, the rename logged as the cloud's own change", async () => {
    let cid = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      cid = (await customer(app, t)).id;
    });
    const atCloud = (await call(C, "POST", "/api/vehicles", token, { customerId: cid, plate: "DXB A 1" })).body.vehicle;
    const atPc = (await call(A, "POST", "/api/vehicles", token, { customerId: cid, plate: "dxb a 1" })).body.vehicle;
    const { pushed } = sync();
    const plates = (app: App) => app.db.all<{ id: string; plate: string }>("SELECT id, plate FROM vehicles ORDER BY plate");
    expect(plates(C)).toEqual([{ id: atCloud.id, plate: "DXB A 1" }, { id: atPc.id, plate: "DXB A 1 (2)" }]);
    expect(plates(A)).toEqual(plates(C));
    expect(pushed.result.issues).toHaveLength(1);
    expect(pushed.result.issues[0]).toMatchObject({ kind: "unique_rename", table: "vehicles", rowId: atPc.id });
    expect(C.db.all("SELECT 1 FROM sync_issues")).toHaveLength(1);
    expect(A.db.all("SELECT 1 FROM sync_issues")).toHaveLength(0);
    const echo = C.db.get<{ changed: string }>("SELECT changed FROM change_log WHERE origin = 'cloud' AND table_name = 'vehicles' AND row_id = ?", [atPc.id]);
    expect(JSON.parse(echo!.changed)).toEqual(["plate"]);
  });

  it("lines of an invoice issued at the cloud are not replaced by an offline PC's edit; a sync issue is recorded", async () => {
    let inv = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      const c = await customer(app, t);
      inv = (await call(app, "POST", "/api/documents", t, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.id;
    });
    expect((await call(C, "POST", `/api/documents/${inv}/issue`, token)).status).toBe(200);
    await call(A, "PUT", `/api/documents/${inv}/lines`, token, { lines: [{ ...LINE, description: "Changed offline", unitPriceFils: 99900 }] });
    const { pushed } = sync();
    expect(pushed.result.issues.map((i) => i.kind)).toEqual(["frozen_invoice"]);
    const lines = (app: App) => app.db.all<{ description: string }>("SELECT description FROM document_lines WHERE document_id = ?", [inv]);
    const doc = (app: App) => app.db.get<{ status: string; gross_fils: number }>("SELECT status, gross_fils FROM documents WHERE id = ?", [inv]);
    expect(lines(C)).toEqual([{ description: "Service" }]);
    expect(lines(A)).toEqual([{ description: "Service" }]);
    expect(doc(A)).toEqual(doc(C));
    expect(doc(A)!.status).toBe("issued");
    expect(doc(A)!.gross_fils).toBe(10500);
  });

  it("stock: movements from both sides → on_hand and avg_cost recomputed identically on both", async () => {
    let partId = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      partId = (await createPart(app, t, {}, { qty: 4, unitCostFils: 2000 })).id;
    });
    await call(A, "POST", `/api/parts/${partId}/adjustments`, token, { reason: "damaged", qty: -2 });
    await tick();
    await call(C, "POST", `/api/parts/${partId}/adjustments`, token, { reason: "other", qty: 5, unitCostFils: 3000 });
    sync();
    const part = (app: App) => app.db.get<{ on_hand: number; avg_cost_fils: number }>("SELECT on_hand, avg_cost_fils FROM parts WHERE id = ?", [partId]);
    expect(part(C)).toEqual({ on_hand: 7, avg_cost_fils: 2714 });
    expect(part(A)).toEqual(part(C));
    expect(await onHand(A, token, partId)).toBe(7);
  });

  it("an invoice issued on the offline PC keeps the PC's lines even if the browser edited the draft", async () => {
    let inv = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      const c = await customer(app, t);
      inv = (await call(app, "POST", "/api/documents", t, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.id;
    });
    await call(C, "PUT", `/api/documents/${inv}/lines`, token, { lines: [{ ...LINE, description: "Browser edit" }] });
    expect((await call(A, "POST", `/api/documents/${inv}/issue`, token)).status).toBe(200);
    sync();
    const lines = (app: App) => app.db.all<{ description: string }>("SELECT description FROM document_lines WHERE document_id = ?", [inv]);
    expect(lines(A)).toEqual([{ description: "Service" }]);
    expect(lines(C)).toEqual([{ description: "Service" }]);
    expect(C.db.get("SELECT status FROM documents WHERE id = ?", [inv])).toEqual({ status: "issued" });
  });

  it("payments from both sides add up; the invoice status becomes paid", async () => {
    let inv = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      const c = await customer(app, t);
      inv = (await call(app, "POST", "/api/documents", t, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.id;
      await call(app, "POST", `/api/documents/${inv}/issue`, t);
    });
    await call(A, "POST", `/api/documents/${inv}/payments`, token, { amountFils: 5000, method: "cash" });
    await call(C, "POST", `/api/documents/${inv}/payments`, token, { amountFils: 5500, method: "card" });
    sync();
    const doc = (app: App) => app.db.get("SELECT status, paid_fils FROM documents WHERE id = ?", [inv]);
    expect(doc(C)).toEqual({ status: "paid", paid_fils: 10500 });
    expect(doc(A)).toEqual(doc(C));
  });

  it("applying the same batch twice changes nothing", async () => {
    const { A, C, token } = await pair();
    await customer(A, token, "Once");
    const entries = localChanges(A.db, 0);
    const first = applyAtCloud(C.db, "P1", entries);
    const logged = maxSeq(C.db);
    const again = applyAtCloud(C.db, "P1", entries);
    expect(first.applied).toBeGreaterThan(0);
    expect(again.applied).toBe(0);
    expect(again.lastOriginSeq).toBe(first.lastOriginSeq);
    expect(maxSeq(C.db)).toBe(logged);
    expect(C.db.all("SELECT 1 FROM customers WHERE name = 'Once'")).toHaveLength(1);
    // The PC side is idempotent through last_pulled_seq.
    const fromCloud = changesFor(C.db, 0, "P9");
    applyAtPc(A.db, fromCloud);
    expect(applyAtPc(A.db, changesFor(C.db, Number(getState(A.db, "last_pulled_seq")), "P9")).applied).toBe(0);
  });

  it("a line whose part never arrived is skipped as apply_failed and the rest applies", async () => {
    const { A, C, token } = await pair();
    const part = await createPart(A, token, { partNo: "X-1" });
    const c = await customer(A, token, "Fatima");
    const doc = (await call(A, "POST", "/api/documents", token, { type: "estimate", customerId: c.id, lines: [{ kind: "part", partId: part.id, description: "X", qty: 1, unitPriceFils: 100, discountPct: 0 }] })).body.document;
    const entries = localChanges(A.db, 0).filter((e) => e.table !== "parts");
    const result = applyAtCloud(C.db, "P1", entries);
    expect(result.issues.map((i) => i.kind)).toEqual(["apply_failed"]);
    expect(C.db.get("SELECT name FROM customers WHERE id = ?", [c.id])).toEqual({ name: "Fatima" });
    expect(C.db.get("SELECT number FROM documents WHERE id = ?", [doc.id])).toEqual({ number: "EST-00001" });
    expect(C.db.all("SELECT 1 FROM document_lines WHERE document_id = ?", [doc.id])).toHaveLength(0);
  });
});
