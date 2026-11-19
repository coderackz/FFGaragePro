import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { addUser, call, createPart, makeApp, onHand, setUp, tempDir, type App } from "./helpers";

async function garage(app?: App) {
  const a = app ?? (await makeApp());
  const owner = await setUp(a);
  const customer = (await call(a, "POST", "/api/customers", owner, { name: "Fleet LLC", kind: "company", creditAllowed: true })).body.customer;
  const invoice = async (lines: Record<string, unknown>[]) => {
    const doc = (await call(a, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines })).body.document;
    return (await call(a, "POST", `/api/documents/${doc.id}/issue`, owner)).body.document;
  };
  const credit = (invId: string, body: Record<string, unknown>, token = owner) => call(a, "POST", `/api/documents/${invId}/credit-notes`, token, body);
  const doc = async (id: string) => (await call(a, "GET", `/api/documents/${id}`, owner)).body.document;
  return { app: a, owner, customer, invoice, credit, doc };
}
const PART_A = { kind: "part", description: "Brake pads", qty: 2, unitPriceFils: 5000, discountPct: 0 };
const LABOUR = { kind: "labour", description: "Fitting", qty: 1, unitPriceFils: 10000, discountPct: 0 };

describe("credit notes", () => {
  it("credit part of an invoice", async () => {
    const { invoice, credit, doc } = await garage();
    const inv = await invoice([PART_A, LABOUR]);
    const res = await credit(inv.id, { reason: "Wrong part", lines: [{ lineId: inv.lines[0].id, qty: 1 }] });
    expect(res.status).toBe(200);
    const cn = res.body.document;
    expect(cn).toMatchObject({ type: "credit_note", number: "CN-00001", status: "issued", reason: "Wrong part", totals: { grossFils: 5250 } });
    expect(cn.source).toMatchObject({ id: inv.id, number: inv.number });
    const after = await doc(inv.id);
    expect(after).toMatchObject({ creditedFils: 5250, owedFils: 21000 - 5250, status: "part_paid" });
    expect(after.creditNotes).toEqual([{ id: cn.id, number: "CN-00001", grossFils: 5250 }]);
    expect(after.derived).toBeNull();
  });

  it("can't credit more than is left", async () => {
    const { invoice, credit } = await garage();
    const inv = await invoice([PART_A, LABOUR]);
    await credit(inv.id, { reason: "Wrong part", lines: [{ lineId: inv.lines[0].id, qty: 1 }] });
    const res = await credit(inv.id, { reason: "Again", lines: [{ lineId: inv.lines[0].id, qty: 2 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Only 1 left to credit on line 1");
    // Everything still uncredited: the other pad and the labour.
    const rest = await credit(inv.id, { reason: "Job cancelled" });
    expect(rest.body.document.totals.grossFils).toBe(5250 + 10500);
    expect((await credit(inv.id, { reason: "Once more" })).body.error).toBe(`Everything on ${inv.number} has already been credited`);
  });

  it("crediting a paid invoice gives the customer credit", async () => {
    const { app, owner, customer, invoice, credit, doc } = await garage();
    const inv = await invoice([PART_A, LABOUR]);
    await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 21000, method: "cash" });
    expect((await doc(inv.id)).status).toBe("paid");
    await credit(inv.id, { reason: "Goodwill" });
    expect(await doc(inv.id)).toMatchObject({ status: "paid", owedFils: 0, creditedFils: 21000, paidFils: 0 });
    expect(app.db.get("SELECT 1 FROM receipt_allocations WHERE document_id = ? AND amount_fils < 0", [inv.id])).toBeTruthy();
    const c = (await call(app, "GET", `/api/customers/${customer.id}`, owner)).body.customer;
    expect(c).toMatchObject({ creditFils: 21000, balanceFils: -21000 });
  });

  it("returned parts go back on the shelf", async () => {
    const { app, owner, invoice, credit } = await garage();
    const part = await createPart(app, owner, {}, { qty: 5, unitCostFils: 2000 });
    const line = { kind: "part", description: "Oil filter", qty: 2, unitPriceFils: 3500, discountPct: 0, partId: part.id };
    const inv = await invoice([line]);
    expect(await onHand(app, owner, part.id)).toBe(3);
    await credit(inv.id, { reason: "Returned unused", lines: [{ lineId: inv.lines[0].id, qty: 1 }] });
    expect(await onHand(app, owner, part.id)).toBe(4);
    await credit(inv.id, { reason: "Kept by customer", returnToStock: false });
    expect(await onHand(app, owner, part.id)).toBe(4);
    const back = app.db.get<{ unit_cost_fils: number; note: string }>("SELECT unit_cost_fils, note FROM stock_movements WHERE qty > 0 AND document_id IS NOT NULL");
    expect(back).toEqual({ unit_cost_fils: 2000, note: "Returned on CN-00001" });
  });

  it("only issued invoices, only Owner and Accountant, and a credit note never changes", async () => {
    const { app, owner, customer, invoice, credit } = await garage();
    const draft = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [LABOUR] })).body.document;
    expect((await credit(draft.id, { reason: "Nope" })).body.error).toBe("Only issued invoices can have a credit note");
    const inv = await invoice([LABOUR]);
    const advisor = await addUser(app, owner, "advisor");
    expect((await credit(inv.id, { reason: "Nope" }, advisor)).status).toBe(403);
    const accountant = await addUser(app, owner, "accountant");
    const cn = (await credit(inv.id, { reason: "Fine" }, accountant)).body.document;
    expect((await call(app, "PATCH", `/api/documents/${cn.id}`, owner, { notes: "edit" })).status).toBe(409);
    expect((await call(app, "PUT", `/api/documents/${cn.id}/lines`, owner, { lines: [LABOUR] })).status).toBe(409);
    expect((await call(app, "POST", `/api/documents/${cn.id}/convert`, owner)).status).toBe(400);
    const log = (await call(app, "GET", "/api/audit?action=credit_note.issue", owner)).body.entries;
    expect(log[0].after).toMatchObject({ creditNote: cn.number, invoice: inv.number, reason: "Fine", amountFils: 10500 });
  });

  it("a refused credit note takes no number", async () => {
    let asked = 0;
    const app = await buildApp({ dataDir: tempDir(), numbers: { next: async () => (asked++, null), offlineSeries: "P1" } });
    try {
      const { invoice, credit } = await garage(app);
      const inv = await invoice([LABOUR]);
      const before = asked;
      expect((await credit(inv.id, { reason: "Too much", lines: [{ lineId: inv.lines[0].id, qty: 5 }] })).status).toBe(400);
      expect(asked).toBe(before);
    } finally {
      await app.close();
    }
  });
});
