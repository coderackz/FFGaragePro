import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { call, EMPLOYEE, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const TOOLS = "00000000-0000-4000-8000-0000000a1500";
const PREPAY = "00000000-0000-4000-8000-0000000a1400";
afterEach(() => vi.useRealTimers());
const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30", establishmentId: "1234567890123", employerRoutingCode: "803320101" };
const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
const balance = (app: App, accountId: string) => app.db.get<{ b: number }>("SELECT COALESCE(SUM(debit_fils - credit_fils), 0) AS b FROM journal_lines WHERE account_id = ?", [accountId])!.b;
const byKey = (app: App, key: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [key]).map((r) => [r.code, r.d]));

async function garage(start = "2026-09-01") {
  at("2026-11-20T08:00:00Z");
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: start });
  await call(app, "PUT", "/api/settings/payroll", owner, RULES);
  const employee = async (extra: Record<string, unknown> = {}) => (await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE, ...extra })).body.employee;
  return { app, owner, employee };
}

describe("payroll minors", () => {
  it("4a: the SIF covers a joiner's own days; payslip allowances never go below zero; approvals and payments are in the activity log", async () => {
    const g = await garage();
    const joiner = await g.employee({ name: "Joiner", joinDate: "2026-10-22", personId: "10012345678902", housingFils: 10001, transportFils: 10001 });
    const run = (await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-10" })).body.run;
    expect((await call(g.app, "POST", `/api/payroll/runs/${run.id}/approve`, g.owner, {})).status).toBe(200);
    const sif = (await call(g.app, "GET", `/api/payroll/runs/${run.id}/wps`, g.owner)).body.text as string;
    expect(sif.split("\r\n").find((l) => l.includes("10012345678902"))).toContain(",2026-10-22,2026-10-31,10,");
    const slip = (await call(g.app, "GET", `/api/payroll/runs/${run.id}/payslips`, g.owner)).body.payslips.find((s: { employee: { id: string } }) => s.employee.id === joiner.id);
    expect(Object.values(slip.allowances).every((v) => (v as number) >= 0)).toBe(true);
    await call(g.app, "POST", `/api/payroll/runs/${run.id}/wps-paid`, g.owner, { date: "2026-11-02", bankAccountId: A.bank.id });
    expect(g.app.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'payroll.%' ORDER BY created_at").map((r) => r.action)).toEqual(["payroll.approve", "payroll.paid"]);
  });

  it("4b: a settlement in a locked month is approved and posts on the first open day", async () => {
    const g = await garage();
    const e = await g.employee();
    await call(g.app, "PATCH", `/api/employees/${e.id}`, g.owner, { leftDate: "2026-09-20" });
    const s = (await call(g.app, "POST", `/api/employees/${e.id}/settlement`, g.owner, {})).body.settlement;
    const books = (await call(g.app, "GET", "/api/settings", g.owner)).body.settings.books;
    await call(g.app, "PUT", "/api/settings/books", g.owner, { ...books, lockDate: "2026-09-30" });
    expect((await call(g.app, "POST", `/api/settlements/${s.id}/approve`, g.owner, { totalFils: s.totalFils })).status).toBe(200);
    postPending(g.app.db);
    expect(g.app.db.get("SELECT date FROM journal_entries WHERE post_key = ?", [`final_settlement:${s.id}`])).toEqual({ date: "2026-10-01" });
  });

  it("4b: a leaver from before the books: the settlement posts at the start against opening clearing, releasing the provision", async () => {
    const g = await garage("2026-10-01");
    const e = await g.employee({ leftDate: "2026-09-20" });
    const s = (await call(g.app, "POST", `/api/employees/${e.id}/settlement`, g.owner, {})).body.settlement;
    expect((await call(g.app, "POST", `/api/settlements/${s.id}/approve`, g.owner, { totalFils: s.totalFils })).status).toBe(200);
    postPending(g.app.db);
    const entry = byKey(g.app, `final_settlement:${s.id}`);
    expect(entry["2200"]).toBe(-s.totalFils);
    expect(entry["6000"] ?? 0).toBe(0);
    expect(balance(g.app, A.gratuity_provision.id)).toBe(0);
  });

  it("4b: a changed salary after the payroll paid it splits by basic and allowances", async () => {
    const g = await garage();
    const e = await g.employee();
    await call(g.app, "PATCH", `/api/employees/${e.id}`, g.owner, { leftDate: "2026-10-12" });
    const oct = (await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-09" })).body.run;
    await call(g.app, "POST", `/api/payroll/runs/${oct.id}/approve`, g.owner, {});
    const oct2 = (await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-10" })).body.run;
    await call(g.app, "POST", `/api/payroll/runs/${oct2.id}/approve`, g.owner, {});
    const s = (await call(g.app, "POST", `/api/employees/${e.id}/settlement`, g.owner, {})).body.settlement;
    const changed = (await call(g.app, "PATCH", `/api/settlements/${s.id}`, g.owner, { key: "salary", amountFils: 45000, reason: "One day missed" })).body.settlement;
    await call(g.app, "POST", `/api/settlements/${s.id}/approve`, g.owner, { totalFils: changed.totalFils });
    postPending(g.app.db);
    const lines = g.app.db.all<{ account_id: string; d: number }>(
      `SELECT l.account_id, l.debit_fils - l.credit_fils AS d FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.post_key = ? AND l.account_id IN (?, ?) ORDER BY l.position`,
      [`final_settlement:${s.id}`, A.salaries.id, A.allowances.id]);
    expect(lines.find((l) => l.account_id === A.allowances.id)!.d).toBe(15000);
  });

  it("4b: opening a settlement takes the leaver out of a draft payroll of that month; under a year releases the provision", async () => {
    const g = await garage();
    const e = await g.employee({ joinDate: "2026-02-01" });
    const sept = (await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-09" })).body.run;
    await call(g.app, "POST", `/api/payroll/runs/${sept.id}/approve`, g.owner, {});
    const oct = (await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-10" })).body.run;
    expect(oct.lines).toHaveLength(1);
    await call(g.app, "PATCH", `/api/employees/${e.id}`, g.owner, { leftDate: "2026-10-12" });
    const s = (await call(g.app, "POST", `/api/employees/${e.id}/settlement`, g.owner, {})).body.settlement;
    expect((await call(g.app, "GET", `/api/payroll/runs/${oct.id}`, g.owner)).body.run.lines).toHaveLength(0);
    expect(s.items.find((i: { key: string }) => i.key === "gratuity").amountFils).toBe(0);
    await call(g.app, "POST", `/api/settlements/${s.id}/approve`, g.owner, { totalFils: s.totalFils });
    postPending(g.app.db);
    expect(balance(g.app, A.gratuity_provision.id)).toBe(0);
  });

  it("4b: a message key already used by another kind of message is refused", async () => {
    const g = await garage();
    const e = await g.employee({ email: "ravi@example.com" });
    await call(g.app, "POST", "/api/messages", g.owner, { event: "payslip", channel: "email", employeeId: e.id, recipient: "ravi@example.com", subject: "Payslip", body: "Attached", dedupeKey: "k1" });
    const r = await call(g.app, "POST", "/api/messages", g.owner, { event: "test", channel: "email", recipient: "x@example.com", subject: "Hi", body: "Hi", dedupeKey: "k1" });
    expect(r.status).toBe(409);
  });
});

describe("fixed asset minors", () => {
  async function books() {
    const g = await garage("2026-07-01");
    const supplier = (await call(g.app, "POST", "/api/suppliers", g.owner, { name: "Al Futtaim" })).body.supplier;
    await call(g.app, "POST", "/api/bills", g.owner, { supplierId: supplier.id, supplierInvoiceNo: "L1", billDate: "2026-07-10", lines: [{ accountId: TOOLS, description: "Lift", netFils: 1200000, vat: "none" }] });
    const add = async (a: Record<string, unknown>) => call(g.app, "POST", "/api/assets", g.owner, { name: "Lift", category: "equipment", accountId: TOOLS, costFils: 1200000, inUseFrom: "2026-07-10", lifeMonths: 36, ...a });
    return { ...g, add };
  }

  it("assets sit in a fixed asset account (15xx)", async () => {
    const g = await books();
    expect((await g.add({ accountId: PREPAY })).status).toBe(400);
  });

  it("proceeds equal to book value: no gain or loss line", async () => {
    const g = await books();
    const lift = (await g.add({})).body.asset;
    postPending(g.app.db);
    await call(g.app, "POST", `/api/assets/${lift.id}/dispose`, g.owner, { date: "2026-10-15", proceedsFils: 1200000 - 133332, proceedsAccountId: A.bank.id });
    postPending(g.app.db);
    expect(byKey(g.app, `asset_disposal:${lift.id}`)).toEqual({ "1590": 133332, "1020": 1066668, "1500": -1200000 });
  });

  it("the schedule says which months are posted, and which were before the books", async () => {
    const g = await books();
    const van = (await g.add({ name: "Van", inUseFrom: "2026-05-01", openingDepreciationFils: 66666 })).body.asset;
    postPending(g.app.db);
    const s = (await call(g.app, "GET", `/api/assets/${van.id}`, g.owner)).body.asset.schedule;
    expect(s.slice(0, 7).map((m: { month: string; status: string }) => [m.month, m.status])).toEqual([
      ["2026-05", "before"], ["2026-06", "before"], ["2026-07", "posted"], ["2026-08", "posted"], ["2026-09", "posted"], ["2026-10", "posted"], ["2026-11", "coming"],
    ]);
  });

  it("the opening balances proposal brings in assets from before the books", async () => {
    const g = await books();
    await g.add({ name: "Van", accountId: "00000000-0000-4000-8000-0000000a1510", costFils: 6000000, inUseFrom: "2025-07-01", lifeMonths: 60, openingDepreciationFils: 1200000 });
    const p = (await call(g.app, "GET", "/api/books/opening/proposal", g.owner)).body;
    expect(p.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "00000000-0000-4000-8000-0000000a1510", debitFils: 6000000 }),
      expect.objectContaining({ accountId: A.accumulated_depreciation.id, creditFils: 1200000 }),
    ]));
  });
});
