import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { addUser, call, makeApp, setUp } from "./helpers";

const today = () => dubaiDate(new Date().toISOString());

async function garage() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  expect((await call(app, "PUT", "/api/settings/books", owner, { startDate: today() })).status).toBe(200);
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Battery House" })).body.supplier;
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "individual", name: "Ali" })).body.customer;
  const part = async (body: Record<string, unknown>, opening?: Record<string, unknown>) => {
    const r = await call(app, "POST", "/api/parts", owner, { stocked: true, sellPriceFils: 40000, ...body });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    if (opening) {
      const a = await call(app, "POST", `/api/parts/${r.body.part.id}/adjustments`, owner, { reason: "opening", ...opening });
      if (a.status !== 200) throw new Error(JSON.stringify(a.body));
    }
    return r.body.part;
  };
  const units = async (partId: string, status: string) => (await call(app, "GET", `/api/parts/${partId}/units?status=${status}`, owner)).body.units as { id: string; code: string; unitCostFils: number }[];
  const claim = (body: Record<string, unknown>) => call(app, "POST", "/api/warranty-claims", owner, { supplierId: supplier.id, ...body });
  const resolve = (id: string, body: Record<string, unknown>) => call(app, "POST", `/api/warranty-claims/${id}/resolve`, owner, body);
  const onHand = async (id: string) => (await call(app, "GET", `/api/parts/${id}`, owner)).body.part.onHand;
  return { app, owner, supplier, customer, part, units, claim, resolve, onHand };
}

describe("warranty claims", () => {
  it("a battery replaced", async () => {
    const g = await garage();
    const battery = await g.part({ partNo: "AMR-70", name: "Amaron 70Ah", tracking: "serial", warrantyMonths: 24 }, { qty: 1, unitCostFils: 25000, units: ["SN-1"] });
    const [u] = await g.units(battery.id, "in_stock");
    // On the shelf: that's a return, not a claim.
    expect((await g.claim({ partId: battery.id, unitId: u!.id, reason: "Won't hold charge" })).body.error).toMatch(/return it/);
    const jc = (await call(g.app, "POST", "/api/documents", g.owner, { type: "jobcard", customerId: g.customer.id, lines: [{ kind: "part", partId: battery.id, description: "Battery", qty: 1, unitPriceFils: 40000, discountPct: 0, unitIds: [u!.id] }] })).body.document;
    const made = await g.claim({ partId: battery.id, unitId: u!.id, documentId: jc.id, reason: "Won't hold charge" });
    expect(made.status).toBe(200);
    expect(made.body.warrantyClaim).toMatchObject({ number: "WC-00001", status: "open", unit: { code: "SN-1" }, documentNumber: jc.number });
    // Replaced: the new battery (serial SN-2) comes onto the shelf at no cost; the failed one went back.
    expect((await g.resolve(made.body.warrantyClaim.id, { outcome: "replaced" })).body.error).toMatch(/serial/);
    const done = await g.resolve(made.body.warrantyClaim.id, { outcome: "replaced", replacementCodes: ["SN-2"], note: "Swapped at the counter" });
    expect(done.body.warrantyClaim).toMatchObject({ status: "replaced", outcomeNote: "Swapped at the counter" });
    expect((await g.units(battery.id, "in_stock")).map((x) => [x.code, x.unitCostFils])).toEqual([["SN-2", 0]]);
    expect((await g.units(battery.id, "returned")).map((x) => x.code)).toEqual(["SN-1"]);
    expect(await g.onHand(battery.id)).toBe(1);
    // The job card that fitted it can still be saved (its line keeps the old serial).
    const saved = await call(g.app, "PATCH", `/api/documents/${jc.id}`, g.owner, { notes: "Battery claimed", lines: [{ kind: "part", partId: battery.id, description: "Battery", qty: 1, unitPriceFils: 40000, discountPct: 0, unitIds: [u!.id] }] });
    expect(saved.status).toBe(200);
    expect(await g.onHand(battery.id)).toBe(1);
    // Closed claims stay closed.
    expect((await g.resolve(made.body.warrantyClaim.id, { outcome: "rejected" })).status).toBe(409);
  });

  it("credited and rejected", async () => {
    const g = await garage();
    const pump = await g.part({ partNo: "WP-1", name: "Water pump" });
    const c1 = (await g.claim({ partId: pump.id, qty: 2, reason: "Leaking seal" })).body.warrantyClaim;
    const credited = await g.resolve(c1.id, { outcome: "credited", creditFils: 40000 });
    expect(credited.body.warrantyClaim).toMatchObject({ status: "credited", debitNote: { number: "RTS-00001", grossFils: 42000 } });
    expect((await call(g.app, "GET", `/api/suppliers/${g.supplier.id}`, g.owner)).body.supplier.balanceFils).toBe(-42000);
    postPending(g.app.db);
    const A = SYSTEM_ACCOUNTS;
    const lines = Object.fromEntries(g.app.db.all<{ code: string; n: number }>(
      `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS n FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_type = 'supplier_return' GROUP BY a.code`,
    ).map((r) => [r.code, r.n]));
    expect(lines).toEqual({ [A.payables.code]: 42000, [A.vat_input.code]: -2000, [A.cogs_parts.code]: -40000 });
    const c2 = (await g.claim({ partId: pump.id, reason: "Noisy bearing" })).body.warrantyClaim;
    expect((await g.resolve(c2.id, { outcome: "rejected", note: "Fitted wrongly" })).body.warrantyClaim).toMatchObject({ status: "rejected" });
    const list = (await call(g.app, "GET", "/api/warranty-claims?status=open", g.owner)).body.warrantyClaims;
    expect(list).toEqual([]);
    expect((await call(g.app, "GET", "/api/warranty-claims", g.owner)).body.warrantyClaims.map((c: { number: string }) => c.number)).toEqual(["WC-00002", "WC-00001"]);
    const advisor = await addUser(g.app, g.owner, "advisor");
    expect((await call(g.app, "POST", "/api/warranty-claims", advisor, { supplierId: g.supplier.id, partId: pump.id, reason: "x y z" })).status).toBe(403);
  });
});
