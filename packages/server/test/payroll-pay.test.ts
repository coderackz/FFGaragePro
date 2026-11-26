import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { call, EMPLOYEE, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
afterEach(() => vi.useRealTimers());
const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30", establishmentId: "1234567890123", employerRoutingCode: "803320101" };
const byCode = (app: App, postKey: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [postKey]).map((r) => [r.code, r.d]));

/** October's payroll for two people, one with a bonus of 200.00, approved. */
async function october(o: { bonusInWps?: boolean; employer?: boolean; approve?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T08:00:00Z"));
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: "2026-09-01" });
  const rules = o.employer === false ? { ...RULES, establishmentId: null, employerRoutingCode: null } : RULES;
  await call(app, "PUT", "/api/settings/payroll", owner, { ...rules, bonusInWps: !!o.bonusInWps });
  const ravi = (await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE })).body.employee;
  await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE, name: "Sami", personId: "10012345678902", basicFils: 200000, housingFils: 0, transportFils: 0 });
  const run = (await call(app, "POST", "/api/payroll/runs", owner, { month: "2026-10" })).body.run;
  await call(app, "PATCH", `/api/payroll/runs/${run.id}/lines/${ravi.id}`, owner, { bonusFils: 20000 });
  if (o.approve !== false) expect((await call(app, "POST", `/api/payroll/runs/${run.id}/approve`, owner)).status).toBe(200);
  return { app, owner, run, ravi };
}

describe("paying a payroll", () => {
  it("bonus in or out of WPS", async () => {
    const off = await october();
    const sif = (await call(off.app, "GET", `/api/payroll/runs/${off.run.id}/wps`, off.owner)).body;
    const lines = sif.text.split("\r\n");
    expect(lines.filter((l: string) => l.startsWith("EDR")).map((l: string) => l.split(",")[8])).toEqual(["0.00", "0.00"]);
    expect(lines.find((l: string) => l.startsWith("SCR")).split(",")[7]).toBe("6500.00");
    expect((await call(off.app, "POST", `/api/payroll/runs/${off.run.id}/bonus-paid`, off.owner, { date: "2026-11-02", cashAccountId: A.cash.id })).status).toBe(200);
    postPending(off.app.db);
    expect(byCode(off.app, `bonus_paid:${off.run.id}`)).toEqual({ "6002": 20000, "1000": -20000 });
    expect((await call(off.app, "GET", `/api/payroll/runs/${off.run.id}/bonus-voucher`, off.owner)).body).toMatchObject({ totalFils: 20000, lines: [expect.objectContaining({ name: "Ravi Kumar", bonusFils: 20000 })] });

    const on = await october({ bonusInWps: true });
    const sifOn = (await call(on.app, "GET", `/api/payroll/runs/${on.run.id}/wps`, on.owner)).body.text.split("\r\n");
    expect(sifOn.find((l: string) => l.includes("10012345678901")).split(",")[8]).toBe("200.00");
    expect(sifOn.find((l: string) => l.startsWith("SCR")).split(",")[7]).toBe("6700.00");
    postPending(on.app.db);
    expect(byCode(on.app, `payroll_run:${on.run.id}`)["6002"]).toBe(20000);
    const none = await call(on.app, "POST", `/api/payroll/runs/${on.run.id}/bonus-paid`, on.owner, { date: "2026-11-02", cashAccountId: A.cash.id });
    expect(none.status).toBe(409);
    expect(none.body.error).toMatch(/no cash bonuses/);
  });

  it("WPS paid once, from a bank", async () => {
    const g = await october();
    const pay = (body: unknown) => call(g.app, "POST", `/api/payroll/runs/${g.run.id}/wps-paid`, g.owner, body);
    expect((await pay({ date: "2026-11-02", bankAccountId: A.cash.id })).status).toBe(400);
    expect((await pay({ date: "2026-11-02", bankAccountId: A.bank.id })).status).toBe(200);
    postPending(g.app.db);
    expect(byCode(g.app, `wps_paid:${g.run.id}`)).toEqual({ "2200": 650000, "1020": -650000 });
    expect((await pay({ date: "2026-11-03", bankAccountId: A.bank.id })).status).toBe(409);
    const d = await october({ approve: false });
    expect((await call(d.app, "POST", `/api/payroll/runs/${d.run.id}/wps-paid`, d.owner, { date: "2026-11-02", bankAccountId: A.bank.id })).status).toBe(409);
  });

  it("SIF needs the employer details", async () => {
    const g = await october({ employer: false });
    const r = await call(g.app, "GET", `/api/payroll/runs/${g.run.id}/wps`, g.owner);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Settings → Payroll/);
  });

  it("payslips list each line", async () => {
    const g = await october();
    const slips = (await call(g.app, "GET", `/api/payroll/runs/${g.run.id}/payslips`, g.owner)).body.payslips;
    expect(slips).toHaveLength(2);
    expect(slips.find((s: { employee: { name: string } }) => s.employee.name === "Ravi Kumar")).toMatchObject({
      month: "2026-10", employee: { name: EMPLOYEE.name }, basicFils: 300000, allowances: { housing: 100000, transport: 50000, other: 0 }, bonusFils: 20000, netWpsFils: 450000,
    });
  });
});
