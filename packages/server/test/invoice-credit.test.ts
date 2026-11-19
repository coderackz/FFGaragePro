import { addDays, dubaiDate } from "@ffgp/shared";
import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

const LINE = (fils: number) => ({ kind: "labour", description: "Service", qty: 1, unitPriceFils: fils, discountPct: 0 });
const OWNER_OK = { username: "owner", password: "owner-pass-1" };

async function garage(customer: Record<string, unknown> = {}) {
  const app = await makeApp();
  const owner = await setUp(app);
  const c = (await call(app, "POST", "/api/customers", owner, { name: "Fleet LLC", kind: "company", ...customer })).body.customer;
  const draft = async (net = 5000, type = "invoice", token = owner) =>
    (await call(app, "POST", "/api/documents", token, { type, customerId: c.id, lines: [LINE(net)] })).body;
  const issue = (id: string, body: Record<string, unknown> = {}, token = owner) => call(app, "POST", `/api/documents/${id}/issue`, token, body);
  return { app, owner, c, draft, issue };
}
const today = () => dubaiDate(new Date().toISOString());

describe("invoices for credit customers", () => {
  it("due dates follow the customer's terms", async () => {
    const cash = await garage();
    const a = (await cash.issue((await cash.draft()).document.id)).body.document;
    expect(a.dueDate).toBe(today());

    const credit = await garage({ creditAllowed: true, termsDays: 45 });
    expect((await credit.issue((await credit.draft()).document.id)).body.document.dueDate).toBe(addDays(today(), 45));

    const defaults = await garage({ creditAllowed: true });
    expect((await defaults.issue((await defaults.draft()).document.id)).body.document.dueDate).toBe(addDays(today(), 30));
  });

  it("a customer that needs an LPO can't have an invoice issued without one", async () => {
    const { draft, issue, app, owner } = await garage({ lpoRequired: true });
    const id = (await draft()).document.id;
    const refused = await issue(id);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("This customer needs an LPO number on the invoice");
    const ok = await issue(id, { lpoNumber: "LPO-7781" });
    expect(ok.status).toBe(200);
    expect(ok.body.document.lpoNumber).toBe("LPO-7781");
    // While a draft, the LPO can be typed on the invoice itself.
    const other = (await draft()).document.id;
    expect((await call(app, "PATCH", `/api/documents/${other}`, owner, { lpoNumber: "LPO-1" })).body.document.lpoNumber).toBe("LPO-1");
    expect((await issue(other)).status).toBe(200);
  });

  it("over the credit limit: warn, block, or the Owner approves", async () => {
    const setUpLimit = async (overLimit: string) => {
      const g = await garage({ creditAllowed: true, creditLimitFils: 10000, openingBalanceFils: 8000 });
      await call(g.app, "PUT", "/api/settings/credit", g.owner, { overLimit });
      return g;
    };
    const warn = await setUpLimit("warn");
    const w = await warn.issue((await warn.draft()).document.id);
    expect(w.status).toBe(200);
    expect(w.body.warning).toBe("Over the credit limit by AED 32.50");

    const block = await setUpLimit("block");
    const b = await block.issue((await block.draft()).document.id);
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ code: "over_limit", error: "Over the credit limit by AED 32.50" });

    const approve = await setUpLimit("approve");
    const accountant = await addUser(approve.app, approve.owner, "accountant");
    const id = (await approve.draft()).document.id;
    const asked = await approve.issue(id, {}, accountant);
    expect(asked.status).toBe(403);
    expect(asked.body.code).toBe("credit_approval");
    const approved = await approve.issue(id, { approval: OWNER_OK }, accountant);
    expect(approved.status).toBe(200);
    const log = (await call(approve.app, "GET", "/api/audit?action=credit.override", approve.owner)).body.entries;
    expect(log[0].after).toMatchObject({ document: approved.body.document.number, approvedBy: "Owner One" });
  });

  it("a job card over the limit is checked too, before it takes a number", async () => {
    const g = await garage({ creditAllowed: true, creditLimitFils: 10000, openingBalanceFils: 8000 });
    await call(g.app, "PUT", "/api/settings/credit", g.owner, { overLimit: "block" });
    const res = await g.draft(5000, "jobcard");
    expect(res.code).toBe("over_limit");
    expect(g.app.db.get("SELECT 1 FROM documents WHERE type = 'jobcard'")).toBeUndefined();
  });

  it("no limit set: never checked", async () => {
    const g = await garage({ creditAllowed: true, openingBalanceFils: 999999 });
    await call(g.app, "PUT", "/api/settings/credit", g.owner, { overLimit: "block" });
    const r = await g.issue((await g.draft()).document.id);
    expect(r.status).toBe(200);
    expect(r.body.warning).toBeUndefined();
  });
});
