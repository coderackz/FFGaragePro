import { afterEach, describe, expect, it } from "vitest";
import { applyAtCloud, applyAtPc, changesFor, getState, installCapture, localChanges, setState } from "../src/index";
import { call, garageApp, setUp, twin, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("tracked stock across computers", () => {
  for (const pcFirst of [false, true]) it(`conflict: the same tyre fitted on two computers offline stays with the earlier job card (${pcFirst ? "PC" : "browser"} first)`, async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const tyre = (await call(A, "POST", "/api/parts", token, { partNo: "T-1", name: "Tyre", stocked: true, sellPriceFils: 50000, tracking: "dot" })).body.part;
    await call(A, "POST", `/api/parts/${tyre.id}/adjustments`, token, { reason: "opening", qty: 1, unitCostFils: 30000, units: ["0125"] });
    const customer = (await call(A, "POST", "/api/customers", token, { kind: "individual", name: "Ali" })).body.customer;
    const unit = (await call(A, "GET", `/api/parts/${tyre.id}/units`, token)).body.units[0];
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    const sync = () => {
      const entries = localChanges(A.db, Number(getState(A.db, "last_pushed_seq") ?? 0));
      const result = applyAtCloud(C.db, "P1", entries);
      if (entries.length) setState(A.db, "last_pushed_seq", String(entries.at(-1)!.seq));
      applyAtPc(A.db, changesFor(C.db, Number(getState(A.db, "last_pulled_seq") ?? 0), "P1"));
      return result;
    };
    const jc = (app: App) => call(app, "POST", "/api/documents", token, {
      type: "jobcard", customerId: customer.id, lines: [{ kind: "part", partId: tyre.id, description: "Tyre", qty: 1, unitPriceFils: 50000, discountPct: 0, unitIds: [unit.id] }],
    });
    // One fits it first; the other, offline, fits the same tyre a moment later.
    const first = (await jc(pcFirst ? A : C)).body.document;
    await tick();
    const second = (await jc(pcFirst ? C : A)).body.document;
    const result = sync();
    sync();
    const where = (app: App) => app.db.get<{ status: string; document_id: string }>("SELECT status, document_id FROM stock_units WHERE id = ?", [unit.id]);
    expect(where(C)).toEqual({ status: "fitted", document_id: first.id });
    expect(where(A)).toEqual(where(C));
    expect(result.issues).toEqual([expect.objectContaining({ kind: "unit_taken", rowId: second.id, message: expect.stringMatching(/T-1 0125 was fitted on .* first/) })]);
  });
});
