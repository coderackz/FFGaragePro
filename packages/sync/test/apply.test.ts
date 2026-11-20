import { afterEach, describe, expect, it } from "vitest";
import { applyAtCloud, applyAtPc, changesFor, forgetPushed, getState, installCapture, localChanges, maxSeq, PUSH_PAGE_BYTES, setState } from "../src/index";
import { customerBalance, Db, legacyPaymentReceipt } from "@ffgp/server";
import { call, createPart, garageApp, onHand, setUp, twin, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

/** A PC garage (A) and its cloud copy (C), as right after a link: same data, capture on both. */
async function pair(seed?: (app: App, token: string) => Promise<void>) {
  // A linked PC that's offline: its numbers come from its own series.
  const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
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

  it("an estimate converted on both sides offline: both job cards exist on both sides, one keeps the link, one readable issue", async () => {
    let est = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      const c = await customer(app, t);
      est = (await call(app, "POST", "/api/documents", t, { type: "estimate", customerId: c.id, lines: [LINE] })).body.document.id;
    });
    const atCloud = (await call(C, "POST", `/api/documents/${est}/convert`, token)).body.document;
    const atPc = (await call(A, "POST", `/api/documents/${est}/convert`, token)).body.document;
    const { pushed } = sync();
    const jobs = (app: App) => app.db.all<{ id: string; source_id: string | null }>("SELECT id, source_id FROM documents WHERE type = 'jobcard' ORDER BY id");
    expect(jobs(C)).toHaveLength(2);
    expect(jobs(A)).toEqual(jobs(C));
    expect(C.db.get("SELECT source_id FROM documents WHERE id = ?", [atCloud.id])).toEqual({ source_id: est });
    expect(C.db.get("SELECT source_id FROM documents WHERE id = ?", [atPc.id])).toEqual({ source_id: null });
    expect(A.db.all("SELECT 1 FROM document_lines WHERE document_id = ?", [atPc.id])).toHaveLength(1);
    expect(C.db.all("SELECT 1 FROM document_lines WHERE document_id = ?", [atPc.id])).toHaveLength(1);
    expect(pushed.result.issues.map((i) => i.kind)).toEqual(["unique_rename"]);
    expect(pushed.result.issues[0]!.message).toMatch(/converted in two places/);
    expect(A.db.all("SELECT 1 FROM sync_issues WHERE kind = 'apply_failed'")).toHaveLength(0);
  });

  it("the same draft invoice issued on both sides takes the stock once", async () => {
    let inv = "";
    let partId = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      partId = (await createPart(app, t, {}, { qty: 10, unitCostFils: 2000 })).id;
      const c = await customer(app, t);
      inv = (await call(app, "POST", "/api/documents", t, {
        type: "invoice", customerId: c.id, lines: [{ kind: "part", partId, description: "Oil filter", qty: 1, unitPriceFils: 3500, discountPct: 0 }],
      })).body.document.id;
    });
    expect((await call(C, "POST", `/api/documents/${inv}/issue`, token)).status).toBe(200);
    expect((await call(A, "POST", `/api/documents/${inv}/issue`, token)).status).toBe(200);
    sync();
    sync();
    const part = (app: App) => app.db.get<{ on_hand: number }>("SELECT on_hand FROM parts WHERE id = ?", [partId])!.on_hand;
    expect(part(C)).toBe(9);
    expect(part(A)).toBe(9);
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

  it("allocations made on two PCs to the same invoice add up on both sides", async () => {
    let inv = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      const c = await customer(app, t);
      inv = (await call(app, "POST", "/api/documents", t, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.id;
      await call(app, "POST", `/api/documents/${inv}/issue`, t);
    });
    await call(A, "POST", `/api/documents/${inv}/payments`, token, { amountFils: 6000, method: "cash" });
    await call(C, "POST", `/api/documents/${inv}/payments`, token, { amountFils: 6000, method: "card" });
    sync();
    sync();
    // The cloud takes the excess back off the invoice, so it becomes credit the garage can use or refund.
    const doc = (app: App) => app.db.get("SELECT status, paid_fils FROM documents WHERE id = ?", [inv]);
    expect(doc(C)).toEqual({ status: "paid", paid_fils: 10500 });
    expect(doc(A)).toEqual(doc(C));
    const cid = C.db.get<{ customer_id: string }>("SELECT customer_id FROM documents WHERE id = ?", [inv])!.customer_id;
    expect(customerBalance(C.db, cid)).toMatchObject({ balanceFils: -1500, creditFils: 1500 });
    expect(customerBalance(A.db, cid)).toEqual(customerBalance(C.db, cid));
    expect(A.db.get("SELECT SUM(amount_fils) AS s FROM receipt_allocations")).toEqual({ s: 10500 });
  });

  it("a payment recorded before the upgrade (on either side) becomes the same receipt everywhere", async () => {
    let inv = "";
    let customerId = "";
    const { A, C, sync } = await pair(async (app, t) => {
      const c = await customer(app, t);
      customerId = c.id;
      inv = (await call(app, "POST", "/api/documents", t, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.id;
      await call(app, "POST", `/api/documents/${inv}/issue`, t);
    });
    // As if each side had an old-style payment still waiting to sync when the update arrived: the payment is in its
    // change log, and its own upgrade already turned it into a receipt (which the upgrade doesn't log).
    const legacy = (app: App, id: string, amount: number) => {
      const row = { id, document_id: inv, amount_fils: amount, method: "cash", reference: null, paid_at: "2026-11-18T10:00:00.000Z", created_by: null, created_at: "2026-11-18T10:00:00.000Z" };
      app.db.run("INSERT INTO payments (id, document_id, amount_fils, method, reference, paid_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [row.id, row.document_id, row.amount_fils, row.method, row.reference, row.paid_at, row.created_by, row.created_at]);
      legacyPaymentReceipt(app.db, row);
      app.db.run("DELETE FROM change_log WHERE table_name IN ('receipts', 'receipt_allocations')");
    };
    legacy(A, "aaaaaaaa-1111-4111-8111-111111111111", 4000);
    legacy(C, "cccccccc-2222-4222-8222-222222222222", 3000);
    sync();
    const receipts = (app: App) => app.db.all("SELECT id, number, customer_id, amount_fils FROM receipts ORDER BY id");
    expect(receipts(C)).toEqual([
      { id: "aaaaaaaa-1111-4111-8111-111111111111", number: "RCT-AAAAAAAA11", customer_id: customerId, amount_fils: 4000 },
      { id: "cccccccc-2222-4222-8222-222222222222", number: "RCT-CCCCCCCC22", customer_id: customerId, amount_fils: 3000 },
    ]);
    expect(receipts(A)).toEqual(receipts(C));
    const doc = (app: App) => app.db.get("SELECT status, paid_fils FROM documents WHERE id = ?", [inv]);
    expect(doc(C)).toEqual({ status: "part_paid", paid_fils: 7000 });
    expect(doc(A)).toEqual(doc(C));
    expect(C.db.all("SELECT kind FROM sync_issues")).toEqual([]);
    expect(A.db.all("SELECT kind FROM sync_issues")).toEqual([]);
  });

  it("an issued invoice with no lines at the cloud still refuses lines from a PC", async () => {
    let inv = "";
    const { A, C, sync } = await pair(async (app, t) => {
      const c = await customer(app, t);
      inv = (await call(app, "POST", "/api/documents", t, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.id;
      await call(app, "POST", `/api/documents/${inv}/issue`, t);
    });
    C.db.run("DELETE FROM document_lines WHERE document_id = ?", [inv]); // as if an earlier apply had failed
    A.db.run("UPDATE document_lines SET description = 'Changed offline' WHERE document_id = ?", [inv]);
    sync();
    expect(C.db.get("SELECT COUNT(*) AS n FROM document_lines WHERE document_id = ?", [inv])).toEqual({ n: 0 });
  });

  it("two credit notes over the same line both stand after sync", async () => {
    let inv = "";
    const { A, C, sync } = await pair(async (app, t) => {
      const c = await customer(app, t);
      inv = (await call(app, "POST", "/api/documents", t, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.id;
      await call(app, "POST", `/api/documents/${inv}/issue`, t);
    });
    // As if each side issued a credit note for the whole line while offline.
    const creditNote = (app: App, id: string, series: string) => {
      const t = new Date().toISOString();
      const inv0 = app.db.get<{ customer_id: string }>("SELECT customer_id FROM documents WHERE id = ?", [inv])!;
      app.db.tx(() => {
        app.db.run(
          `INSERT INTO documents (id, type, series, seq, number, status, customer_id, source_id, reason, issued_at, net_fils, vat_fils, gross_fils, created_at, updated_at)
           VALUES (?, 'credit_note', ?, 1, ?, 'issued', ?, ?, 'Wrong', ?, 10000, 500, 10500, ?, ?)`,
          [id, series, `CN-${series}-1`, inv0.customer_id, inv, t, t, t],
        );
        app.db.run(
          `INSERT INTO document_lines (id, document_id, position, kind, description, qty, unit_price_fils, discount_pct, net_fils, vat_fils, gross_fils, supplied_by)
           VALUES (?, ?, 0, 'labour', 'Service', 1, 10000, 0, 10000, 500, 10500, 'garage')`,
          [`${id}-l`, id],
        );
      });
    };
    creditNote(A, "cn-a", "P1");
    creditNote(C, "cn-c", "");
    sync();
    expect(C.db.all("SELECT kind, message FROM sync_issues")).toEqual([]);
    const doc = (app: App) => app.db.get("SELECT credited_fils, status FROM documents WHERE id = ?", [inv]);
    expect(doc(C)).toEqual({ credited_fils: 21000, status: "paid" });
    expect(doc(A)).toEqual(doc(C));
  });

  it("figures a PC recalculates from the cloud's changes aren't sent back as its own", async () => {
    let inv = "";
    const { A, C, token } = await pair(async (app, t) => {
      const c = await customer(app, t);
      inv = (await call(app, "POST", "/api/documents", t, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.id;
      await call(app, "POST", `/api/documents/${inv}/issue`, t);
    });
    await call(C, "POST", `/api/documents/${inv}/payments`, token, { amountFils: 10500, method: "card" });
    // Only the payment arrives (the invoice's own update was superseded or is in a later page).
    applyAtPc(A.db, changesFor(C.db, 0, "P1").filter((e) => e.table === "receipts" || e.table === "receipt_allocations"));
    expect(A.db.get("SELECT status FROM documents WHERE id = ?", [inv])).toEqual({ status: "paid" });
    expect(localChanges(A.db, 0)).toEqual([]);
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
    expect(result.issues[0]!.message).not.toMatch(/constraint/i);
    expect(result.issues[0]!.message).toMatch(/hasn't arrived/);
    expect(C.db.get("SELECT name FROM customers WHERE id = ?", [c.id])).toEqual({ name: "Fatima" });
    expect(C.db.get("SELECT number FROM documents WHERE id = ?", [doc.id])).toEqual({ number: "EST-P1-00001" });
    expect(C.db.all("SELECT 1 FROM document_lines WHERE document_id = ?", [doc.id])).toHaveLength(0);
  });
});

describe("English + Arabic (Part 3a)", () => {
  it("sync carries language and Arabic names", async () => {
    const { A, C, token, sync } = await pair();
    const c = (await call(A, "POST", "/api/customers", token, { name: "Mohammed", nameAr: "محمد", addressAr: "دبي", docLanguage: "en_ar" })).body.customer;
    const part = await createPart(A, token, { nameAr: "فلتر زيت", stocked: false });
    const doc = (await call(A, "POST", "/api/documents", token, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document;
    sync();
    expect(C.db.get("SELECT name_ar, address_ar, doc_language FROM customers WHERE id = ?", [c.id])).toEqual({ name_ar: "محمد", address_ar: "دبي", doc_language: "en_ar" });
    expect(C.db.get("SELECT name_ar FROM parts WHERE id = ?", [part.id])).toEqual({ name_ar: "فلتر زيت" });
    expect(C.db.get("SELECT language FROM documents WHERE id = ?", [doc.id])).toEqual({ language: "en_ar" });
  });
  it("sync carries contacts and messages", async () => {
    const { A, C, token, sync } = await pair();
    const c = (await call(A, "POST", "/api/customers", token, { name: "Gulf Fleet", kind: "company" })).body.customer;
    const contact = (await call(A, "POST", `/api/customers/${c.id}/contacts`, token, { name: "Accounts", email: "a@gulf.ae", getsInvoices: true })).body.contact;
    const t = new Date().toISOString();
    A.db.run(
      `INSERT INTO messages (id, customer_id, contact_id, event, channel, recipient, subject, body, status, created_at, updated_at)
       VALUES ('m1', ?, ?, 'invoice_issued', 'email', 'a@gulf.ae', 'Invoice', 'Hello', 'queued', ?, ?)`,
      [c.id, contact.id, t, t],
    );
    A.db.run("INSERT INTO message_files (id, message_id, file_name, data_base64, created_at) VALUES ('f1', 'm1', 'INV.pdf', 'JVBERi0=', ?)", [t]);
    sync();
    expect(C.db.get("SELECT name, gets_invoices FROM customer_contacts WHERE id = ?", [contact.id])).toEqual({ name: "Accounts", gets_invoices: 1 });
    expect(C.db.get("SELECT status, recipient FROM messages WHERE id = 'm1'")).toEqual({ status: "queued", recipient: "a@gulf.ae" });
    expect(C.db.get("SELECT file_name, data_base64 FROM message_files WHERE id = 'f1'")).toEqual({ file_name: "INV.pdf", data_base64: "JVBERi0=" });
  });
});

describe("review fixes: attachments and secrets", () => {
  const big = "A".repeat(1024 * 1024);
  const addMessage = (db: Db, id: string) => {
    const t = new Date().toISOString();
    db.run(`INSERT INTO messages (id, event, channel, recipient, subject, body, status, created_at, updated_at)
            VALUES (?, 'test', 'email', 'a@b.ae', 'S', 'B', 'queued', ?, ?)`, [id, t, t]);
  };
  const addFile = (db: Db, id: string, messageId: string, data = "JVBERi0=") =>
    db.run("INSERT INTO message_files (id, message_id, file_name, data_base64, created_at) VALUES (?, ?, 'x.pdf', ?, ?)", [id, messageId, data, new Date().toISOString()]);

  it("I6/I7: the cloud never sends attachments or secrets down to PCs, however many there are", async () => {
    const { C } = await pair();
    addMessage(C.db, "m1");
    for (let i = 0; i < 600; i++) addFile(C.db, `f${i}`, "m1");
    C.db.run("INSERT INTO settings (key, value) VALUES ('secret.smtp.password', '\"pw\"')");
    const t = new Date().toISOString();
    C.db.run("INSERT INTO customers (id, kind, name, created_at, updated_at) VALUES ('c-after', 'individual', 'After', ?, ?)", [t, t]);
    const down = changesFor(C.db, 0, "P1");
    expect(down.some((e) => e.table === "message_files")).toBe(false);
    expect(down.some((e) => e.table === "settings" && String(e.rowId).startsWith("secret."))).toBe(false);
    expect(down.some((e) => e.table === "customers" && e.rowId === "c-after")).toBe(true);
    expect(down.some((e) => e.table === "messages" && e.rowId === "m1")).toBe(true);
  });

  it("I6: a push page stays under the size cap and never splits one change", async () => {
    const { A } = await pair();
    addMessage(A.db, "m1");
    for (let i = 0; i < 30; i++) addFile(A.db, `f${i}`, "m1", big);
    let after = Number(getState(A.db, "last_pushed_seq") ?? 0);
    let pages = 0;
    let files = 0;
    for (;;) {
      const page = localChanges(A.db, after);
      if (!page.length) break;
      pages++;
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(PUSH_PAGE_BYTES + 2 * big.length);
      files += page.filter((e) => e.table === "message_files").length;
      after = page.at(-1)!.seq;
    }
    expect(files).toBe(30);
    expect(pages).toBeGreaterThan(2);
  });

  it("I6/I7: after pushing, a PC's log keeps no attachments or secrets; the cloud's log neither", async () => {
    const { A, C, push } = await pair();
    addMessage(A.db, "m1");
    addFile(A.db, "f1", "m1");
    A.db.run("INSERT INTO settings (key, value) VALUES ('secret.smtp.password', '\"pw\"')");
    const { entries } = push();
    forgetPushed(A.db, entries.at(-1)!.seq);
    const heavy = "SELECT COUNT(*) AS n FROM change_log WHERE table_name = 'message_files' OR (table_name = 'settings' AND row_id LIKE 'secret.%')";
    expect(A.db.get(heavy)).toEqual({ n: 0 });
    expect(C.db.get("SELECT data_base64 FROM message_files WHERE id = 'f1'")).toEqual({ data_base64: "JVBERi0=" });
    forgetPushed(C.db);
    expect(C.db.get(heavy)).toEqual({ n: 0 });
  });
});

describe("Part 2 review fixes: the same thing done in two places", () => {
  it("I6: the same statement imported on a PC and at the cloud merges into one set of lines", async () => {
    const { A, C, token, sync } = await pair();
    const bank = "00000000-0000-4000-8000-0000000a1020";
    const mapping = { date: 0, description: 1, amount: 2, dateFormat: "yyyy-mm-dd", hasHeader: false };
    const csv = "2026-11-05,Transfer,-100.00\n2026-11-06,Fee,-1.50\n";
    for (const app of [A, C]) {
      await call(app, "PUT", `/api/money-accounts/${bank}/mapping`, token, mapping);
      expect((await call(app, "POST", `/api/money-accounts/${bank}/imports`, token, { fileName: "s.csv", csv, openingBalanceFils: 0 })).body.added).toBe(2);
    }
    const { pushed } = sync();
    expect(pushed.result.issues).toEqual([]);
    expect(C.db.get("SELECT COUNT(*) AS n FROM bank_lines")).toEqual({ n: 2 });
    expect(A.db.get("SELECT COUNT(*) AS n FROM bank_lines")).toEqual({ n: 2 });
  });
});

describe("payroll across places (review fixes)", () => {
  const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30", establishmentId: "1234567890123", employerRoutingCode: "803320101" };
  const now = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  const month = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const seed = async (app: App, t: string) => {
    await call(app, "PUT", "/api/settings/books", t, { startDate: `${month}-01` });
    await call(app, "PUT", "/api/settings/payroll", t, RULES);
    await call(app, "POST", "/api/employees", t, { name: "Ravi", job: "Mechanic", joinDate: `${month}-01`, basicFils: 300000, iban: "AE070331234567890123456", routingCode: "803320101", personId: "10012345678901" });
  };
  const open = async (app: App, token: string) => (await call(app, "POST", "/api/payroll/runs", token, { month })).body.run;
  const sif = async (app: App, token: string, runId: string) => (await call(app, "GET", `/api/payroll/runs/${runId}/wps`, token)).body.text as string;

  it("C1: an approved payroll can't be changed by a PC's late edit", async () => {
    const { A, C, token, sync } = await pair(seed);
    const run = await open(A, token);
    sync();
    expect((await call(C, "GET", `/api/payroll/runs/${run.id}/wps`, token)).status).toBe(409);
    await call(A, "PATCH", `/api/payroll/runs/${run.id}/lines/${run.lines[0].employeeId}`, token, { extrasFils: 50000, extrasNote: "Late" });
    expect((await call(C, "POST", `/api/payroll/runs/${run.id}/approve`, token, {})).status).toBe(200);
    const approvedSif = await sif(C, token, run.id);
    const { pushed } = sync();
    expect(pushed.result.issues.map((i: { kind: string }) => i.kind)).toContain("frozen_payroll");
    expect(await sif(C, token, run.id)).toBe(approvedSif);
    expect((await call(C, "GET", `/api/payroll/runs/${run.id}`, token)).body.run.lines[0].extrasFils).toBe(0);
  });

  it("I1: the same month opened in two places is one payroll; paid is marked once", async () => {
    const { A, C, token, sync } = await pair(seed);
    const a = await open(A, token);
    const c = await open(C, token);
    expect(a.id).toBe(c.id);
    const first = sync();
    expect(first.pushed.result.issues).toEqual([]);
    expect(C.db.get("SELECT COUNT(*) AS n FROM payroll_lines")).toEqual({ n: 1 });
    expect((await call(C, "POST", `/api/payroll/runs/${c.id}/approve`, token, {})).status).toBe(200);
    sync();
    const bank = "00000000-0000-4000-8000-0000000a1020";
    expect((await call(C, "POST", `/api/payroll/runs/${c.id}/wps-paid`, token, { date: now, bankAccountId: bank })).status).toBe(200);
    expect((await call(A, "POST", `/api/payroll/runs/${a.id}/wps-paid`, token, { date: now, bankAccountId: bank })).status).toBe(200);
    const second = sync();
    expect(second.pushed.result.issues.length).toBe(1);
    expect(C.db.get("SELECT COUNT(*) AS n FROM payroll_payments")).toEqual({ n: 1 });
  });
});

describe("final settlements across places (review fixes)", () => {
  const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30" };
  const now = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  const month = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const lastDay = `${month}-12`;
  let employeeId = "";
  const seed = async (app: App, t: string) => {
    await call(app, "PUT", "/api/settings/books", t, { startDate: `${month}-01` });
    await call(app, "PUT", "/api/settings/payroll", t, RULES);
    employeeId = (await call(app, "POST", "/api/employees", t, { name: "Ravi", job: "Mechanic", joinDate: `${month}-01`, basicFils: 300000 })).body.employee.id;
  };

  it("6: the leaving month's salary isn't paid by both a payroll and a settlement", async () => {
    const { A, C, token, sync } = await pair(seed);
    await call(C, "PATCH", `/api/employees/${employeeId}`, token, { leftDate: lastDay });
    sync();
    // The PC runs the leaving month with Ravi in it (it hasn't seen the settlement); the cloud settles him.
    const run = (await call(A, "POST", "/api/payroll/runs", token, { month })).body.run;
    expect(run.lines).toHaveLength(1);
    expect((await call(A, "POST", `/api/payroll/runs/${run.id}/approve`, token, {})).status).toBe(200);
    const s = (await call(C, "POST", `/api/employees/${employeeId}/settlement`, token, {})).body.settlement;
    expect(s.items.find((i: { key: string }) => i.key === "salary").amountFils).toBeGreaterThan(0);
    expect((await call(C, "POST", `/api/settlements/${s.id}/approve`, token, { totalFils: s.totalFils })).status).toBe(200);
    const { pushed } = sync();
    expect(pushed.result.issues.map((i: { kind: string }) => i.kind)).toContain("frozen_payroll");
    expect(C.db.get("SELECT COUNT(*) AS n FROM payroll_approvals")).toEqual({ n: 0 });
  });
});

describe("fixed assets across places (review fixes)", () => {
  it("I5: a sold asset doesn't take changes from another place, nor more depreciation", async () => {
    const now = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
    const start = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 4, 1)).toISOString().slice(0, 10);
    let assetId = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      await call(app, "PUT", "/api/settings/books", t, { startDate: start });
      assetId = (await call(app, "POST", "/api/assets", t, { name: "Lift", category: "equipment", accountId: "00000000-0000-4000-8000-0000000a1500", costFils: 1200000, inUseFrom: start, lifeMonths: 36 })).body.asset.id;
    });
    await call(A, "PATCH", `/api/assets/${assetId}`, token, { lifeMonths: 12 });
    expect((await call(C, "POST", `/api/assets/${assetId}/dispose`, token, { date: now, proceedsFils: 0 })).status).toBe(200);
    const before = C.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal_lines WHERE asset_id = ?", [assetId])!.n;
    const { pushed } = sync();
    expect(pushed.result.issues.map((i: { kind: string }) => i.kind)).toContain("frozen_asset");
    expect(C.db.get("SELECT life_months FROM fixed_assets WHERE id = ?", [assetId])).toEqual({ life_months: 36 });
    expect(C.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal_lines WHERE asset_id = ?", [assetId])!.n).toBe(before);
  });
});

describe("settlement edits across places (minor fixes)", () => {
  it("two places changing different amounts both keep their change", async () => {
    const now = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
    const start = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 3, 1)).toISOString().slice(0, 10);
    let employeeId = "";
    const { A, C, token, sync } = await pair(async (app, t) => {
      await call(app, "PUT", "/api/settings/books", t, { startDate: start });
      await call(app, "PUT", "/api/settings/payroll", t, { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30" });
      employeeId = (await call(app, "POST", "/api/employees", t, { name: "Ravi", job: "Mechanic", joinDate: start, leftDate: `${start.slice(0, 8)}20`, basicFils: 300000 })).body.employee.id;
    });
    const s = (await call(A, "POST", `/api/employees/${employeeId}/settlement`, token, {})).body.settlement;
    sync();
    await call(A, "PATCH", `/api/settlements/${s.id}`, token, { key: "leave", amountFils: 1000, reason: "Agreed" });
    await call(C, "PATCH", `/api/settlements/${s.id}`, token, { key: "salary", amountFils: 2000, reason: "Checked" });
    sync();
    const items = (await call(C, "GET", `/api/employees/${employeeId}/settlement`, token)).body.settlement.items;
    expect(items.find((i: { key: string }) => i.key === "leave").amountFils).toBe(1000);
    expect(items.find((i: { key: string }) => i.key === "salary").amountFils).toBe(2000);
  });
});

