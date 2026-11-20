import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { call, EMPLOYEE, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
afterEach(() => vi.useRealTimers());
const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30" };
const balance = (app: App, accountId: string) => app.db.get<{ b: number }>("SELECT COALESCE(SUM(debit_fils - credit_fils), 0) AS b FROM journal_lines WHERE account_id = ?", [accountId])!.b;

async function garage(o: { posts?: boolean; employee?: Record<string, unknown> } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T08:00:00Z"));
  const app = await makeApp(undefined, { postsBooks: o.posts ?? true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: "2026-09-01" });
  await call(app, "PUT", "/api/settings/payroll", owner, RULES);
  const e = (await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE, ...o.employee })).body.employee;
  const settle = async (lastDay: string) => {
    await call(app, "PATCH", `/api/employees/${e.id}`, owner, { leftDate: lastDay });
    return (await call(app, "POST", `/api/employees/${e.id}/settlement`, owner, {})).body.settlement;
  };
  const approve = (s: { id: string; totalFils: number }) => call(app, "POST", `/api/settlements/${s.id}/approve`, owner, { totalFils: s.totalFils });
  return { app, owner, e, settle, approve };
}

describe("final settlement review fixes", () => {
  it("1: a payroll approved after the settlement puts no gratuity aside for the leaver", async () => {
    const g = await garage();
    const sept = (await call(g.app, "POST", "/api/payroll/runs", g.owner, { month: "2026-09" })).body.run;
    const s = await g.settle("2026-10-12");
    expect((await g.approve(s)).status).toBe(200);
    expect((await call(g.app, "POST", `/api/payroll/runs/${sept.id}/approve`, g.owner, {})).status).toBe(200);
    postPending(g.app.db);
    expect(balance(g.app, A.gratuity_provision.id)).toBe(0);
  });

  it("2: after approval, the leaving date and pay can't change", async () => {
    const g = await garage();
    expect((await g.approve(await g.settle("2026-10-12"))).status).toBe(200);
    const moved = await call(g.app, "PATCH", `/api/employees/${g.e.id}`, g.owner, { leftDate: "2026-11-15" });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatch(/approved final settlement/);
    expect((await call(g.app, "PATCH", `/api/employees/${g.e.id}`, g.owner, { leftDate: null })).status).toBe(409);
    expect((await call(g.app, "PATCH", `/api/employees/${g.e.id}`, g.owner, { basicFils: 400000 })).status).toBe(409);
    expect((await call(g.app, "PATCH", `/api/employees/${g.e.id}`, g.owner, { phone: "050 123 4567" })).status).toBe(200);
  });

  it("3: amounts are checked by kind; a forgiven advance is written off, not left owed", async () => {
    const g = await garage();
    await call(g.app, "POST", `/api/employees/${g.e.id}/advances`, g.owner, { amountFils: 20000, paidOn: "2026-10-02", paidFromAccountId: A.cash.id, instalmentFils: 20000 });
    const s = await g.settle("2026-10-12");
    const edit = (key: string, amountFils: number) => call(g.app, "PATCH", `/api/settlements/${s.id}`, g.owner, { key, amountFils, reason: "Checked" });
    expect((await edit("advances", 20000)).status).toBe(400);
    expect((await edit("advances", -30000)).status).toBe(400);
    expect((await edit("gratuity", -1)).status).toBe(400);
    expect((await edit("salary", -1)).status).toBe(400);
    const half = (await edit("advances", -10000)).body.settlement;
    expect((await g.approve(half)).status).toBe(200);
    postPending(g.app.db);
    expect(balance(g.app, A.staff_advances.id)).toBe(0);
    expect((await call(g.app, "GET", `/api/employees/${g.e.id}`, g.owner)).body.employee.advanceOwedFils).toBe(0);
  });

  it("4: a PC waits for the gratuity brought forward before approving", async () => {
    const g = await garage({ posts: false });
    const s = await g.settle("2026-10-12");
    const r = await g.approve(s);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/sync, then approve/);
  });

  it("5: leave from before the app: an opening leave balance, or a warning", async () => {
    const g = await garage({ employee: { leaveBalanceDays: 10, leaveBalanceDate: "2026-09-01" } });
    const leave = (await g.settle("2026-10-12")).items.find((i: { key: string }) => i.key === "leave");
    expect(leave.how).toMatch(/^12\.5 days/);
    const h = await garage();
    const warned = (await h.settle("2026-10-12")).items.find((i: { key: string }) => i.key === "leave");
    expect(warned.how).toMatch(/no leave balance was entered/);
  });
});
