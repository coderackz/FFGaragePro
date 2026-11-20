import { afterEach, describe, expect, it, vi } from "vitest";
import { gratuityOwed, serviceDays, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { addUser, call, EMPLOYEE, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
afterEach(() => vi.useRealTimers());
const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30" };
const byCode = (app: App, postKey: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [postKey]).map((r) => [r.code, r.d]));

async function garage(o: { rules?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T08:00:00Z"));
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: "2026-09-01" });
  if (o.rules !== false) await call(app, "PUT", "/api/settings/payroll", owner, RULES);
  const employee = async (extra: Record<string, unknown> = {}) => (await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE, ...extra })).body.employee;
  const open = async (month: string) => (await call(app, "POST", "/api/payroll/runs", owner, { month })).body.run;
  const approve = (id: string, token = owner) => call(app, "POST", `/api/payroll/runs/${id}/approve`, token);
  const edit = (runId: string, employeeId: string, body: unknown) => call(app, "PATCH", `/api/payroll/runs/${runId}/lines/${employeeId}`, owner, body);
  return { app, owner, employee, open, approve, edit };
}

describe("monthly payroll runs", () => {
  it("run proposes only people employed that month", async () => {
    const g = await garage();
    await g.employee();
    const joiner = await g.employee({ name: "Joiner", joinDate: "2026-10-22", personId: "10012345678902" });
    await g.employee({ name: "Leaver", joinDate: "2025-01-01", leftDate: "2026-09-30", personId: "10012345678903" });
    const run = await g.open("2026-10");
    expect(run.lines.map((l: { name: string }) => l.name).sort()).toEqual(["Joiner", "Ravi Kumar"]);
    const j = run.lines.find((l: { employeeId: string }) => l.employeeId === joiner.id);
    expect(j.workedDays).toBe(10);
    expect(j.basicFils + j.allowancesFils).toBe(150000);
    expect((await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-10" })).status).toBe(409);
    expect((await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-12" })).status).toBe(400);
  });

  it("instalment capped and negative net refused", async () => {
    const g = await garage();
    const e = await g.employee();
    await call(g.app, "POST", `/api/employees/${e.id}/advances`, g.owner, { amountFils: 15000, paidOn: "2026-10-05", paidFromAccountId: A.cash.id, instalmentFils: 20000 });
    const run = await g.open("2026-10");
    expect(run.lines[0].advanceRepaymentFils).toBe(15000);
    expect((await g.edit(run.id, e.id, { advanceRepaymentFils: 30000 })).status).toBe(400);
    expect((await g.edit(run.id, e.id, { extrasFils: -500000, extrasNote: "Damage" })).status).toBe(200);
    const r = await g.approve(run.id);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Ravi Kumar/);
  });

  it("approval rules", async () => {
    const g = await garage({ rules: false });
    await call(g.app, "PUT", "/api/settings/payroll", g.owner, { salaryDayRate: "gross_30" });
    await g.employee();
    const oct = await g.open("2026-10");
    const nov = await g.open("2026-11");
    const accountant = await addUser(g.app, g.owner, "accountant");
    expect((await g.approve(oct.id, accountant)).status).toBe(403);
    const unchosen = await g.approve(oct.id);
    expect(unchosen.status).toBe(400);
    expect(unchosen.body.error).toMatch(/Settings → Payroll/);
    await call(g.app, "PUT", "/api/settings/payroll", g.owner, RULES);
    expect((await g.approve(nov.id)).status).toBe(409);
    expect((await g.approve(oct.id)).status).toBe(200);
    expect((await g.approve(oct.id)).status).toBe(409);
    expect((await g.edit(oct.id, oct.lines[0].employeeId, { bonusFils: 100 })).status).toBe(409);
    postPending(g.app.db);
    postPending(g.app.db);
    expect(g.app.db.get("SELECT COUNT(*) AS n FROM journal_entries WHERE post_key LIKE 'payroll_run:%'")).toEqual({ n: 1 });
  });

  it("approval posts salaries, advances and gratuity", async () => {
    const g = await garage();
    const e = await g.employee();
    await call(g.app, "POST", `/api/employees/${e.id}/leave`, g.owner, { kind: "unpaid", from: "2026-10-12", to: "2026-10-13" });
    await call(g.app, "POST", `/api/employees/${e.id}/advances`, g.owner, { amountFils: 30000, paidOn: "2026-10-05", paidFromAccountId: A.cash.id, instalmentFils: 10000 });
    const oct = await g.open("2026-10");
    expect(oct.lines[0]).toMatchObject({ unpaidDays: 2, unpaidDeductionFils: 30000, advanceRepaymentFils: 10000, netFils: 410000 });
    expect((await g.approve(oct.id)).status).toBe(200);
    postPending(g.app.db);
    const unpaid = [{ from: "2026-10-12", to: "2026-10-13" }];
    const gOct = gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: serviceDays("2024-01-01", "2026-10-31", unpaid), dayRate: "basic_30", cap: "basic" });
    // Service before the books started (1 Sep 2026) is brought forward in the opening position; October puts aside the rest.
    const atStart = gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: serviceDays("2024-01-01", "2026-08-31", []), dayRate: "basic_30", cap: "basic" });
    const month = gOct - atStart;
    expect(byCode(g.app, `payroll_run:${oct.id}`)).toEqual({ "6000": 280000, "6001": 140000, "6003": month, "2200": -410000, "1410": -10000, "2210": -month });
    const nov = await g.open("2026-11");
    expect((await g.approve(nov.id)).status).toBe(200);
    postPending(g.app.db);
    const gNov = gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: serviceDays("2024-01-01", "2026-11-30", unpaid), dayRate: "basic_30", cap: "basic" });
    expect(byCode(g.app, `payroll_run:${nov.id}`)["6003"]).toBe(gNov - gOct);
  });
});
