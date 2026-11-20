import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { addUser, call, EMPLOYEE, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
afterEach(() => vi.useRealTimers());
const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30" };
const byKey = (app: App, key: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [key]).map((r) => [r.code, r.d]));
const balance = (app: App, accountId: string) => app.db.get<{ b: number }>("SELECT COALESCE(SUM(debit_fils - credit_fils), 0) AS b FROM journal_lines WHERE account_id = ?", [accountId])!.b;

async function garage(rules: Record<string, unknown> = RULES) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T08:00:00Z"));
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: "2026-09-01" });
  await call(app, "PUT", "/api/settings/payroll", owner, rules);
  const e = (await call(app, "POST", "/api/employees", owner, EMPLOYEE)).body.employee;
  const sept = (await call(app, "POST", "/api/payroll/runs", owner, { month: "2026-09" })).body.run;
  if (rules.gratuityDayRate) expect((await call(app, "POST", `/api/payroll/runs/${sept.id}/approve`, owner, {})).status).toBe(200);
  const leaves = (lastDay: string) => call(app, "PATCH", `/api/employees/${e.id}`, owner, { leftDate: lastDay });
  const open = () => call(app, "POST", `/api/employees/${e.id}/settlement`, owner, {});
  const approve = (id: string, totalFils: number, token = owner) => call(app, "POST", `/api/settlements/${id}/approve`, token, { totalFils });
  const pay = (id: string, accountId: string) => call(app, "POST", `/api/settlements/${id}/paid`, owner, { date: "2026-10-15", accountId });
  return { app, owner, e, leaves, open, approve, pay };
}

describe("final settlements", () => {
  it("settlement releases the provision", async () => {
    const g = await garage();
    await call(g.app, "POST", `/api/employees/${g.e.id}/advances`, g.owner, { amountFils: 20000, paidOn: "2026-10-02", paidFromAccountId: A.cash.id, instalmentFils: 20000 });
    await g.leaves("2026-10-12");
    const s = (await g.open()).body.settlement;
    expect(s.items.map((i: { key: string }) => i.key)).toEqual(["salary", "leave", "gratuity", "advances"]);
    expect(s.items.find((i: { key: string }) => i.key === "advances").amountFils).toBe(-20000);
    expect((await g.approve(s.id, s.totalFils)).status).toBe(200);
    postPending(g.app.db);
    expect(Object.values(byKey(g.app, `final_settlement:${s.id}`)).reduce((a: number, b) => a + (b as number), 0)).toBe(0);
    expect(byKey(g.app, `final_settlement:${s.id}`)["2200"]).toBe(-s.totalFils);
    expect(balance(g.app, A.gratuity_provision.id)).toBe(0);
    expect(balance(g.app, A.staff_advances.id)).toBe(0);
    expect((await g.pay(s.id, A.bank.id)).status).toBe(200);
    postPending(g.app.db);
    expect(byKey(g.app, `settlement_paid:${s.id}`)).toEqual({ "2200": s.totalFils, "1020": -s.totalFils });
    // The October payroll leaves him out: the settlement paid his days.
    const oct = (await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-10" })).body.run;
    expect(oct.lines).toEqual([]);
  });

  it("no salary twice", async () => {
    const g = await garage();
    await g.leaves("2026-10-12");
    const oct = (await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-10" })).body.run;
    expect(oct.lines[0].workedDays).toBe(12);
    expect((await call(g.app, "POST", `/api/payroll/runs/${oct.id}/approve`, g.owner, {})).status).toBe(200);
    const salary = (await g.open()).body.settlement.items.find((i: { key: string }) => i.key === "salary");
    expect(salary).toMatchObject({ amountFils: 0, how: expect.stringMatching(/Paid in the Oct 2026 payroll/) });
  });

  it("a changed amount needs a reason", async () => {
    const g = await garage();
    await g.leaves("2026-10-12");
    const s = (await g.open()).body.settlement;
    expect((await call(g.app, "PATCH", `/api/settlements/${s.id}`, g.owner, { key: "leave", amountFils: 10000 })).status).toBe(400);
    const changed = (await call(g.app, "PATCH", `/api/settlements/${s.id}`, g.owner, { key: "leave", amountFils: 10000, reason: "Agreed with the owner" })).body.settlement;
    expect(changed.items.find((i: { key: string }) => i.key === "leave")).toMatchObject({ amountFils: 10000, reason: "Agreed with the owner" });
    expect(changed.totalFils).not.toBe(s.totalFils);
  });

  it("settlement approval and payment rules", async () => {
    const g = await garage();
    expect((await g.open()).status).toBe(400);
    await g.leaves("2026-10-12");
    const s = (await g.open()).body.settlement;
    expect((await g.open()).status).toBe(409);
    const accountant = await addUser(g.app, g.owner, "accountant");
    expect((await g.approve(s.id, s.totalFils, accountant)).status).toBe(403);
    expect((await g.approve(s.id, s.totalFils + 1)).status).toBe(409);
    expect((await g.approve(s.id, s.totalFils)).status).toBe(200);
    expect((await g.approve(s.id, s.totalFils)).status).toBe(409);
    expect((await g.pay(s.id, A.sales_other.id)).status).toBe(400);
    expect((await g.pay(s.id, A.bank.id)).status).toBe(200);
    expect((await g.pay(s.id, A.bank.id)).status).toBe(409);
    postPending(g.app.db);
    postPending(g.app.db);
    expect(g.app.db.get("SELECT COUNT(*) AS n FROM journal_entries WHERE post_key LIKE 'final_settlement:%'")).toEqual({ n: 1 });

    const h = await garage({ ...RULES, leaveBasis: null });
    await h.leaves("2026-10-12");
    const r = await h.open();
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Settings → Payroll/);
  });
});
