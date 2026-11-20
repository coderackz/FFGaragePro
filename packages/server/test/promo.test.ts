import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp, type App } from "./helpers";
import { postPending } from "../src/books/pending";

const LABOUR = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };
const PART = { kind: "part", description: "Filter", qty: 1, unitPriceFils: 5000, discountPct: 0 };
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

async function garage() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC" })).body.customer;
  const code = (body: Record<string, unknown>) => call(app, "POST", "/api/promo-codes", owner, { kind: "percent", value: 10, appliesTo: "all", oncePerCustomer: false, active: true, ...body });
  const doc = async (type: string, lines: unknown[], customerId = customer.id) => (await call(app, "POST", "/api/documents", owner, { type, customerId, lines })).body.document;
  const apply = (id: string, c: string, token = owner) => call(app, "POST", `/api/documents/${id}/promo`, token, { code: c });
  const issue = (id: string, token = owner, extra: Record<string, unknown> = {}) => call(app, "POST", `/api/documents/${id}/issue`, token, extra);
  return { app, owner, customer, code, doc, apply, issue };
}
const money = (d: { netFils: number; vatFils: number; grossFils: number }) => [d.netFils, d.vatFils, d.grossFils];
const docMoney = (app: App, id: string) => app.db.get<{ net_fils: number; vat_fils: number; gross_fils: number }>("SELECT net_fils, vat_fils, gross_fils FROM documents WHERE id = ?", [id])!;

describe("promo codes", () => {
  it("apply and totals", async () => {
    const g = await garage();
    expect((await g.code({ code: "service10", appliesTo: "labour" })).status).toBe(200);
    const est = await g.doc("estimate", [LABOUR, PART]);
    const applied = await g.apply(est.id, "SERVICE10");
    expect(applied.status).toBe(200);
    expect(applied.body.document).toMatchObject({ promo: { code: "SERVICE10", discountFils: 1000 } });
    expect(Object.values(docMoney(g.app, est.id))).toEqual([14000, 700, 14700]);
    // Editing the lines keeps the promo spread over them.
    await call(g.app, "PUT", `/api/documents/${est.id}/lines`, g.owner, { lines: [{ ...LABOUR, unitPriceFils: 20000 }, PART] });
    expect(Object.values(docMoney(g.app, est.id))).toEqual([23000, 1150, 24150]);
    const removed = await call(g.app, "DELETE", `/api/documents/${est.id}/promo`, g.owner);
    expect(removed.body.document.promo).toBeNull();
    expect(docMoney(g.app, est.id).net_fils).toBe(25000);
    expect((await g.apply(est.id, "NOPE")).body.error).toMatch(/No such code/);
  });

  it("promo limits at issue", async () => {
    const g = await garage();
    await g.code({ code: "ONCE", maxUses: 1, oncePerCustomer: true });
    const a = await g.doc("invoice", [LABOUR]);
    const b = await g.doc("invoice", [LABOUR]);
    await g.apply(a.id, "ONCE");
    await g.apply(b.id, "ONCE");
    expect((await g.issue(a.id)).status).toBe(200);
    const c = await g.doc("invoice", [LABOUR]);
    expect((await g.apply(c.id, "ONCE")).body.error).toMatch(/Used up/);
    const accountant = await addUser(g.app, g.owner, "accountant");
    const refused = await g.issue(b.id, accountant);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Used up/);
    expect((await g.issue(b.id, g.owner, { promoOverride: true })).status).toBe(200);
    expect(g.app.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'promo.override'")).toEqual({ n: 1 });
    // A full credit note on A frees its use.
    await g.code({ code: "TWICE", maxUses: 1 });
    const d = await g.doc("invoice", [LABOUR]);
    await g.apply(d.id, "TWICE");
    await g.issue(d.id);
    await call(g.app, "POST", `/api/documents/${d.id}/credit-notes`, g.owner, { reason: "Cancelled" });
    const e = await g.doc("invoice", [LABOUR]);
    expect((await g.apply(e.id, "TWICE")).status).toBe(200);
    // Expired between apply and issue.
    await g.code({ code: "OLD", validTo: today() });
    const f = await g.doc("invoice", [LABOUR]);
    await g.apply(f.id, "OLD");
    g.app.db.run("UPDATE promo_codes SET valid_to = '2020-01-01' WHERE code = 'OLD'");
    const expired = await g.issue(f.id);
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatch(/Ended on/);
  });

  it("credit note follows the promo", async () => {
    const g = await garage();
    await g.code({ code: "ALL10" });
    const inv = await g.doc("invoice", [{ ...PART, qty: 2, unitPriceFils: 10000 }]);
    await g.apply(inv.id, "ALL10");
    const issued = (await g.issue(inv.id)).body.document;
    expect(issued.lines[0].netFils).toBe(18000);
    const cn = (await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "One returned", lines: [{ lineId: issued.lines[0].id, qty: 1 }], returnToStock: false })).body.document;
    expect(money(cn.lines[0])).toEqual([9000, 450, 9450]);
  });

  it("books and report", async () => {
    const g = await garage();
    await call(g.app, "PUT", "/api/settings/books", g.owner, { startDate: today() });
    await g.code({ code: "SERVICE10", appliesTo: "labour" });
    const inv = await g.doc("invoice", [LABOUR, PART]);
    await g.apply(inv.id, "SERVICE10");
    await g.issue(inv.id);
    postPending(g.app.db);
    const health = (await call(g.app, "GET", "/api/books/health", g.owner)).body.checks;
    expect(health.find((c: { key: string }) => c.key === "output_vat")).toMatchObject({ ok: true });
    expect(g.app.db.get("SELECT SUM(credit_fils - debit_fils) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '4000'")).toEqual({ v: 9000 });
    const report = (await call(g.app, "GET", "/api/reports/promo-codes", g.owner)).body.codes;
    expect(report.find((r: { code: string }) => r.code === "SERVICE10")).toMatchObject({ uses: 1, discountFils: 1000, overLimit: false });
    // A second use arriving past the limit (from an offline PC) is flagged.
    g.app.db.run("UPDATE promo_codes SET max_uses = 1 WHERE code = 'SERVICE10'");
    const again = await g.doc("invoice", [LABOUR]);
    g.app.db.run("UPDATE documents SET status = 'issued', issued_at = ?, promo_code = 'SERVICE10' WHERE id = ?", [new Date().toISOString(), again.id]);
    const flagged = (await call(g.app, "GET", "/api/reports/promo-codes", g.owner)).body.codes;
    expect(flagged.find((r: { code: string }) => r.code === "SERVICE10")).toMatchObject({ uses: 2, overLimit: true });
  });

  it("a promo that takes the whole bill is refused at issue with the reason", async () => {
    const g = await garage();
    await g.code({ code: "FREE", value: 100 });
    const inv = await g.doc("invoice", [LABOUR]);
    expect((await g.apply(inv.id, "FREE")).status).toBe(200);
    const refused = await g.issue(inv.id);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/FREE takes the whole bill/);
  });

  it("a code on documents can't be renamed (its uses would be lost)", async () => {
    const g = await garage();
    const made = (await g.code({ code: "ONE", maxUses: 1 })).body.code;
    const inv = await g.doc("invoice", [LABOUR]);
    await g.apply(inv.id, "ONE");
    await g.issue(inv.id);
    const renamed = await call(g.app, "PATCH", `/api/promo-codes/${made.id}`, g.owner, { code: "ONE2" });
    expect(renamed.status).toBe(409);
    expect(renamed.body.error).toMatch(/can't change/);
    expect((await call(g.app, "PATCH", `/api/promo-codes/${made.id}`, g.owner, { active: false })).status).toBe(200);
    const unused = (await g.code({ code: "TWO" })).body.code;
    expect((await call(g.app, "PATCH", `/api/promo-codes/${unused.id}`, g.owner, { code: "TWO2" })).body.code.code).toBe("TWO2");
  });

  it("credit notes in steps credit exactly what the promo line came to", async () => {
    const g = await garage();
    await g.code({ code: "SEVEN", value: 7 });
    const inv = await g.doc("invoice", [{ ...PART, qty: 3, unitPriceFils: 3838 }]);
    await g.apply(inv.id, "SEVEN");
    const issued = (await g.issue(inv.id)).body.document;
    for (let i = 0; i < 3; i++) {
      await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "Returned", lines: [{ lineId: issued.lines[0].id, qty: 1 }], returnToStock: false });
    }
    const after = g.app.db.get<{ gross_fils: number; credited_fils: number }>("SELECT gross_fils, credited_fils FROM documents WHERE id = ?", [inv.id])!;
    expect(after.credited_fils).toBe(after.gross_fils);
  });

  it("prices including VAT: the minimum is the net; the report gives the discount before VAT", async () => {
    const g = await garage();
    await g.code({ code: "MIN100", value: 10, minNetFils: 10000 });
    const d = await g.doc("invoice", [{ ...LABOUR, unitPriceFils: 10000 }]);
    g.app.db.run("UPDATE documents SET prices_include_vat = 1 WHERE id = ?", [d.id]);
    await call(g.app, "PUT", `/api/documents/${d.id}/lines`, g.owner, { lines: [{ ...LABOUR, unitPriceFils: 10000 }] });
    expect((await g.apply(d.id, "MIN100")).body.error).toMatch(/at least AED 100.00/);
    await call(g.app, "PUT", `/api/documents/${d.id}/lines`, g.owner, { lines: [{ ...LABOUR, unitPriceFils: 21000 }] });
    expect((await g.apply(d.id, "MIN100")).status).toBe(200);
    expect((await g.issue(d.id)).status).toBe(200);
    const report = (await call(g.app, "GET", "/api/reports/promo-codes", g.owner)).body.codes;
    // 10% of 210.00 typed with VAT = 21.00 off; before VAT that's 20.00.
    expect(report.find((r: { code: string }) => r.code === "MIN100")).toMatchObject({ uses: 1, discountFils: 2000 });
  });
});

