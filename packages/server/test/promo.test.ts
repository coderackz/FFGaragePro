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
});
