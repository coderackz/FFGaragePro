import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

const line = (description: string, discountPct: number) => ({ kind: "labour", description, qty: 1, unitPriceFils: 10000, discountPct });
const OWNER_OK = { username: "owner", password: "owner-pass-1" };

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const advisor = await addUser(app, owner, "advisor");
  await call(app, "PUT", "/api/settings/pricing", owner, { maxDiscountAdvisorPct: 10 });
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
  const audits = async () => (await call(app, "GET", "/api/audit?action=discount.approve", owner)).body.entries;
  return { app, owner, advisor, customer, audits };
}

describe("discount limits", () => {
  it("advisors stay within their limit", async () => {
    const { app, advisor, customer, audits } = await garage();
    const body = { type: "estimate", customerId: customer.id, lines: [line("Service", 15)] };
    const refused = await call(app, "POST", "/api/documents", advisor, body);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "discount_approval", error: "A discount over 10% needs the Owner's approval" });
    const ok = await call(app, "POST", "/api/documents", advisor, { ...body, approval: OWNER_OK });
    expect(ok.status).toBe(200);
    const [entry] = await audits();
    expect(entry.after).toMatchObject({ document: ok.body.document.number, approvedBy: "Owner One", lines: [{ description: "Service", discountPct: 15 }] });
  });

  it("a wrong owner password doesn't approve", async () => {
    const { app, owner, advisor, customer } = await garage();
    await addUser(app, owner, "accountant");
    const body = { type: "estimate", customerId: customer.id, lines: [line("Service", 15)] };
    expect((await call(app, "POST", "/api/documents", advisor, { ...body, approval: { username: "owner", password: "nope" } })).body.code).toBe("discount_approval");
    expect((await call(app, "POST", "/api/documents", advisor, { ...body, approval: { username: "accountant", password: "accountant-pass-1" } })).body.code)
      .toBe("discount_approval");
  });

  it("an approved discount isn't asked again", async () => {
    const { app, advisor, customer } = await garage();
    const doc = (await call(app, "POST", "/api/documents", advisor, { type: "estimate", customerId: customer.id, lines: [line("Service", 15), line("Wash", 0)], approval: OWNER_OK })).body.document;
    const res = await call(app, "PUT", `/api/documents/${doc.id}/lines`, advisor, { lines: [line("Service", 15), line("Wash and vacuum", 0)] });
    expect(res.status).toBe(200);
    const more = await call(app, "PUT", `/api/documents/${doc.id}/lines`, advisor, { lines: [line("Service", 20), line("Wash and vacuum", 0)] });
    expect(more.body.code).toBe("discount_approval");
  });

  it("the owner needs no approval", async () => {
    const { app, owner, customer, audits } = await garage();
    expect((await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: [line("Service", 50)] })).status).toBe(200);
    expect(await audits()).toHaveLength(0);
  });

  it("an approval covers that line only, not a different line put in its place", async () => {
    const { app, advisor, customer } = await garage();
    const wiper = { kind: "part", description: "Wiper blade", qty: 1, unitPriceFils: 2000, discountPct: 50 };
    const doc = (await call(app, "POST", "/api/documents", advisor, { type: "estimate", customerId: customer.id, lines: [wiper], approval: OWNER_OK })).body.document;
    const overhaul = { kind: "labour", description: "Engine overhaul", qty: 1, unitPriceFils: 800000, discountPct: 50 };
    expect((await call(app, "PUT", `/api/documents/${doc.id}/lines`, advisor, { lines: [overhaul] })).body.code).toBe("discount_approval");
    expect((await call(app, "PUT", `/api/documents/${doc.id}/lines`, advisor, { lines: [{ ...wiper, qty: 10 }] })).body.code).toBe("discount_approval");
    expect((await call(app, "PUT", `/api/documents/${doc.id}/lines`, advisor, { lines: [{ ...wiper, discountPct: 40 }] })).status).toBe(200);
  });
});

