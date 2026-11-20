import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gratuityOwed, serviceYears, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { Db } from "../src/db";
import { call, EMPLOYEE, makeApp, setUp, tempDir, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
afterEach(() => vi.useRealTimers());
const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30" };
const byKey = (app: App, like: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key LIKE ? GROUP BY a.code`, [like]).map((r) => [r.code, r.d]));

async function garage(o: { start?: string; rules?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T08:00:00Z"));
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: o.start ?? "2026-10-01" });
  if (o.rules !== false) await call(app, "PUT", "/api/settings/payroll", owner, RULES);
  const e = (await call(app, "POST", "/api/employees", owner, EMPLOYEE)).body.employee;
  const open = (month: string) => call(app, "POST", "/api/payroll/runs", owner, { month });
  const approve = (id: string, body: unknown = {}) => call(app, "POST", `/api/payroll/runs/${id}/approve`, owner, body);
  return { app, owner, e, open, approve };
}

describe("payroll review fixes", () => {
  it("a run waits for the salary day rate to be chosen (no hidden default)", async () => {
    const g = await garage({ rules: false });
    const r = await g.open("2026-10");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Settings → Payroll/);
  });

  it("I2: a month before an approved one can't be opened or approved", async () => {
    const g = await garage();
    const oct = (await g.open("2026-10")).body.run;
    const nov = (await g.open("2026-11")).body.run;
    expect((await g.approve(oct.id)).status).toBe(200);
    expect((await g.approve(nov.id)).status).toBe(200);
    const g2 = await garage();
    const nov2 = (await g2.open("2026-11")).body.run;
    expect((await g2.approve(nov2.id)).status).toBe(200);
    const early = await g2.open("2026-10");
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/Nov 2026 is already approved/);
  });

  it("I3: gratuity and advances from before the books start go to the opening position", async () => {
    const g = await garage();
    const adv = await call(g.app, "POST", `/api/employees/${g.e.id}/advances`, g.owner, { amountFils: 60000, paidOn: "2026-09-20", paidFromAccountId: A.cash.id, instalmentFils: 20000 });
    expect(adv.status).toBe(200);
    postPending(g.app.db);
    const opening = gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceYears: serviceYears("2024-01-01", "2026-09-30", []), dayRate: "basic_30", cap: "basic" });
    expect(byKey(g.app, `payroll_opening:${g.e.id}%`)).toEqual({ "2210": -opening, "2900": opening });
    expect(byKey(g.app, `staff_advance:${adv.body.advance.id}`)).toEqual({ "1410": 60000, "2900": -60000 });
    const oct = (await g.open("2026-10")).body.run;
    expect(oct.lines[0].advanceRepaymentFils).toBe(20000);
    expect((await g.approve(oct.id)).status).toBe(200);
    postPending(g.app.db);
    const owedOct = gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceYears: serviceYears("2024-01-01", "2026-10-31", []), dayRate: "basic_30", cap: "basic" });
    expect(byKey(g.app, `payroll_run:${oct.id}`)["6003"]).toBe(owedOct - opening);
    // The opening balances clear 2900 as usual.
    const p = (await call(g.app, "GET", "/api/books/opening/proposal", g.owner)).body;
    const d = (await call(g.app, "POST", "/api/books/drafts", g.owner, { kind: "opening", date: p.date, narration: "Opening", lines: p.lines })).body.draft;
    expect((await call(g.app, "POST", `/api/books/drafts/${d.id}/post`, g.owner)).status).toBe(200);
    const health = (await call(g.app, "GET", "/api/books/health", g.owner)).body.checks;
    expect(health.find((c: { key: string }) => c.key === "opening_clearing")).toMatchObject({ ok: true });
  });

  it("I7: the draft shows the bonus where it will go; approval refuses totals that moved", async () => {
    const g = await garage();
    await call(g.app, "PUT", "/api/settings/payroll", g.owner, { ...RULES, bonusInWps: true });
    const oct = (await g.open("2026-10")).body.run;
    const run = (await call(g.app, "PATCH", `/api/payroll/runs/${oct.id}/lines/${g.e.id}`, g.owner, { bonusFils: 20000 })).body.run;
    expect(run.lines[0].bonusInWps).toBe(true);
    expect(run.totals.netWpsFils).toBe(470000);
    await call(g.app, "POST", `/api/employees/${g.e.id}/leave`, g.owner, { kind: "unpaid", from: "2026-10-12", to: "2026-10-13" });
    const moved = await g.approve(oct.id, { netWpsFils: 470000 });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatch(/changed/);
    const fresh = (await call(g.app, "GET", `/api/payroll/runs/${oct.id}`, g.owner)).body.run;
    expect((await g.approve(oct.id, { netWpsFils: fresh.totals.netWpsFils })).status).toBe(200);
  });

  it("I8: migration 14 keeps a garage's own account that took a payroll code", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 13 });
    old.run("DELETE FROM accounts WHERE id = ?", [A.allowances.id]);
    old.run("INSERT INTO accounts (id, code, name, type, active, created_at, updated_at) VALUES ('mine', '6001', 'Wages', 'expense', 1, 'x', 'x')");
    old.close();
    const db = new Db(file);
    expect(db.get("SELECT code, system_key FROM accounts WHERE id = ?", [A.allowances.id])).toEqual({ code: "6001", system_key: "allowances" });
    expect(db.get<{ code: string; name: string }>("SELECT code, name FROM accounts WHERE id = 'mine'")).toMatchObject({ name: "Wages" });
    expect(db.get<{ code: string }>("SELECT code FROM accounts WHERE id = 'mine'")!.code).not.toBe("6001");
    db.close();
  });

  it("I9: wrong leave and a wrong advance can be cancelled", async () => {
    const g = await garage();
    const wrong = (await call(g.app, "POST", `/api/employees/${g.e.id}/leave`, g.owner, { kind: "unpaid", from: "2026-10-12", to: "2026-10-31" })).body.leave;
    expect((await call(g.app, "POST", `/api/employees/${g.e.id}/leave/${wrong.id}/cancel`, g.owner, {})).status).toBe(200);
    expect((await call(g.app, "POST", `/api/employees/${g.e.id}/leave`, g.owner, { kind: "unpaid", from: "2026-10-12", to: "2026-10-13" })).status).toBe(200);
    const adv = (await call(g.app, "POST", `/api/employees/${g.e.id}/advances`, g.owner, { amountFils: 30000, paidOn: "2026-10-05", paidFromAccountId: A.cash.id, instalmentFils: 10000 })).body.advance;
    expect((await call(g.app, "POST", `/api/employees/${g.e.id}/advances/${adv.id}/cancel`, g.owner, {})).status).toBe(200);
    postPending(g.app.db);
    expect(byKey(g.app, `staff_advance%${adv.id}%`)).toEqual({ "1410": 0, "1000": 0 });
    const oct = (await g.open("2026-10")).body.run;
    expect(oct.lines[0]).toMatchObject({ unpaidDays: 2, advanceRepaymentFils: 0 });
    // An advance already being taken back can't be cancelled.
    const adv2 = (await call(g.app, "POST", `/api/employees/${g.e.id}/advances`, g.owner, { amountFils: 30000, paidOn: "2026-10-06", paidFromAccountId: A.cash.id, instalmentFils: 10000 })).body.advance;
    await call(g.app, "POST", `/api/payroll/runs/${oct.id}/refresh`, g.owner, {});
    expect((await g.approve(oct.id)).status).toBe(200);
    expect((await call(g.app, "POST", `/api/employees/${g.e.id}/advances/${adv2.id}/cancel`, g.owner, {})).status).toBe(409);
  });

  it("I10: changing the bonus keeps the extras note", async () => {
    const g = await garage();
    const oct = (await g.open("2026-10")).body.run;
    await call(g.app, "PATCH", `/api/payroll/runs/${oct.id}/lines/${g.e.id}`, g.owner, { extrasFils: 5000, extrasNote: "Overtime Fri" });
    const run = (await call(g.app, "PATCH", `/api/payroll/runs/${oct.id}/lines/${g.e.id}`, g.owner, { bonusFils: 100 })).body.run;
    expect(run.lines[0].extrasNote).toBe("Overtime Fri");
  });
});
