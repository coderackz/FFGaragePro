import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

const line = (unitPriceFils: number, description = "Service") => ({ kind: "labour", description, qty: 1, unitPriceFils, discountPct: 0 });

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const advisor = await addUser(app, owner, "advisor");
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC" })).body.customer;
  const doc = async (type: string, lines: unknown[]) => (await call(app, "POST", "/api/documents", owner, { type, customerId: customer.id, lines })).body.document;
  const discount = (id: string, body: unknown, token = owner) => call(app, "PUT", `/api/documents/${id}/discount`, token, body);
  return { app, owner, advisor, customer, doc, discount };
}

describe("overall discount", () => {
  it("10% off: spread over the lines, VAT after the discount", async () => {
    const g = await garage();
    const est = await g.doc("estimate", [line(50000)]);
    const res = await g.discount(est.id, { kind: "percent", value: 10 });
    expect(res.status).toBe(200);
    expect(res.body.document.totals).toEqual({ netFils: 45000, vatFils: 2250, grossFils: 47250 });
    expect(res.body.document.discount).toMatchObject({ kind: "percent", value: 10, discountFils: 5000, pct: 10, applied: true, needsConfirmation: false, confirmedBy: null });
    expect(res.body.document.lines.reduce((s: number, l: { promoFils: number }) => s + l.promoFils, 0)).toBe(5000);
  });

  it("AED 50 off the whole bill across two lines", async () => {
    const g = await garage();
    const est = await g.doc("estimate", [line(30000), line(20000, "Other")]);
    const res = await g.discount(est.id, { kind: "amount", value: 5000 });
    expect(res.body.document.lines.map((l: { promoFils: number }) => l.promoFils)).toEqual([3000, 2000]);
    expect(res.body.document.totals.netFils).toBe(45000);
  });

  it("an advisor can give it; above 25% it needs the tick and a remark", async () => {
    const g = await garage();
    const est = await g.doc("estimate", [line(50000)]);
    const none = await g.discount(est.id, { kind: "percent", value: 30 }, g.advisor);
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/remark/i);
    expect((await g.discount(est.id, { kind: "percent", value: 30, confirmed: true, remark: "ok" }, g.advisor)).status).toBe(400);
    expect((await g.discount(est.id, { kind: "percent", value: 30, remark: "Fleet customer, agreed" }, g.advisor)).status).toBe(400);
    const ok = await g.discount(est.id, { kind: "percent", value: 30, confirmed: true, remark: "Fleet customer, agreed" }, g.advisor);
    expect(ok.status).toBe(200);
    expect(ok.body.document.discount).toMatchObject({ pct: 30, confirmedBy: "advisor user", remark: "Fleet customer, agreed", needsConfirmation: false });
    expect(ok.body.document.discount.confirmedAt).toBeTruthy();
    expect(g.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'discount.confirm' AND entity_id = ?", [est.id])!.n).toBe(1);
    // Exactly at the limit needs nothing.
    const at = await g.discount(est.id, { kind: "percent", value: 25 }, g.advisor);
    expect(at.status).toBe(200);
    expect(at.body.document.discount).toMatchObject({ pct: 25, confirmedBy: null, remark: null });
  });

  it("the limit follows Settings → Pricing", async () => {
    const g = await garage();
    await call(g.app, "PUT", "/api/settings/pricing", g.owner, { discountConfirmAbovePct: 10 });
    const est = await g.doc("estimate", [line(50000)]);
    expect((await g.discount(est.id, { kind: "percent", value: 15 })).status).toBe(400);
  });

  it("an amount discount that grows past the limit asks again; an invoice won't issue until confirmed", async () => {
    const g = await garage();
    const inv = await g.doc("invoice", [line(30000), line(20000, "Other")]);
    expect((await g.discount(inv.id, { kind: "amount", value: 10000 })).body.document.discount.pct).toBe(20);
    const smaller = await call(g.app, "PATCH", `/api/documents/${inv.id}`, g.owner, { lines: [line(20000, "Other")] });
    expect(smaller.body.document.discount).toMatchObject({ pct: 50, needsConfirmation: true });
    const issue = await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner, {});
    expect(issue.status).toBe(409);
    expect(issue.body.error).toMatch(/discount/i);
    expect((await g.discount(inv.id, { kind: "amount", value: 10000, confirmed: true, remark: "Agreed with owner" })).status).toBe(200);
    expect((await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner, {})).status).toBe(200);
  });

  it("promo or discount, not both", async () => {
    const g = await garage();
    await call(g.app, "POST", "/api/promo-codes", g.owner, { code: "TEN", kind: "percent", value: 10, appliesTo: "all", oncePerCustomer: false, active: true });
    const a = await g.doc("estimate", [line(50000)]);
    await call(g.app, "POST", `/api/documents/${a.id}/promo`, g.owner, { code: "TEN" });
    const refused = await g.discount(a.id, { kind: "percent", value: 5 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Remove the promo code first/);
    const b = await g.doc("estimate", [line(50000)]);
    await g.discount(b.id, { kind: "percent", value: 5 });
    const promo = await call(g.app, "POST", `/api/documents/${b.id}/promo`, g.owner, { code: "TEN" });
    expect(promo.status).toBe(409);
    expect(promo.body.error).toMatch(/Remove the discount first/);
  });

  it("the discount and its confirmation go with the work", async () => {
    const g = await garage();
    const est = await g.doc("estimate", [line(50000)]);
    await g.discount(est.id, { kind: "percent", value: 30, confirmed: true, remark: "Fleet customer, agreed" });
    const jc = (await call(g.app, "POST", `/api/documents/${est.id}/convert`, g.owner, {})).body.document;
    const inv = (await call(g.app, "POST", `/api/documents/${jc.id}/convert`, g.owner, {})).body.document;
    for (const d of [jc, inv]) {
      expect(d.discount).toMatchObject({ kind: "percent", value: 30, confirmedBy: "Owner One", remark: "Fleet customer, agreed", needsConfirmation: false });
      expect(d.totals).toEqual({ netFils: 35000, vatFils: 1750, grossFils: 36750 });
    }
  });

  it("a credit note returns each line's share", async () => {
    const g = await garage();
    const inv = await g.doc("invoice", [line(30000), line(20001, "Other")]);
    const d = (await g.discount(inv.id, { kind: "percent", value: 10 })).body.document;
    await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner, {});
    const cn = await call(g.app, "POST", `/api/documents/${inv.id}/credit-notes`, g.owner, { reason: "Goodwill", returnToStock: false, lines: [{ lineId: d.lines[0].id, qty: 1 }] });
    expect(cn.status).toBe(200);
    expect(cn.body.document.totals.netFils).toBe(d.lines[0].netFils);
  });

  it("DELETE removes it and the totals go back", async () => {
    const g = await garage();
    const est = await g.doc("estimate", [line(50000)]);
    await g.discount(est.id, { kind: "percent", value: 10 });
    const res = await call(g.app, "DELETE", `/api/documents/${est.id}/discount`, g.owner);
    expect(res.body.document.discount).toBeNull();
    expect(res.body.document.totals.netFils).toBe(50000);
  });

  it("a promo and a discount that both arrive (sync) — the promo applies, the discount waits", async () => {
    const g = await garage();
    const est = await g.doc("estimate", [line(50000)]);
    g.app.db.run("UPDATE documents SET promo_code = 'TEN', promo_kind = 'percent', promo_value = 10, promo_applies = 'all', discount_kind = 'percent', discount_value = 30 WHERE id = ?", [est.id]);
    const res = await call(g.app, "PATCH", `/api/documents/${est.id}`, g.owner, { lines: [line(50000)] });
    expect(res.body.document.totals.netFils).toBe(45000);
    expect(res.body.document.discount).toMatchObject({ discountFils: 0, applied: false });
  });
});
