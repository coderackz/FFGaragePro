import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { addDays } from "../src/books/post";
import { Db } from "../src/db";
import { addUser, call, EMPLOYEE, makeApp, setUp, tempDir, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const today = () => dubaiDate(new Date().toISOString());
const byCode = (app: App, postKey: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [postKey]).map((r) => [r.code, r.d]));

async function garage() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), -60) });
  return { app, owner };
}

describe("employees, leave and advances", () => {
  it("employees: create, edit, list; advisors get 403", async () => {
    const { app, owner } = await garage();
    const e = (await call(app, "POST", "/api/employees", owner, EMPLOYEE)).body.employee;
    expect(e).toMatchObject({ name: "Ravi Kumar", basicFils: 300000, iban: "AE070331234567890123456" });
    expect((await call(app, "PATCH", `/api/employees/${e.id}`, owner, { job: "Senior mechanic" })).body.employee).toMatchObject({ job: "Senior mechanic", basicFils: 300000 });
    expect((await call(app, "GET", "/api/employees", owner)).body.employees.map((x: { name: string }) => x.name)).toEqual(["Ravi Kumar"]);
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "GET", "/api/employees", advisor)).status).toBe(403);
    expect((await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE, personId: "12" })).status).toBe(400);
  });

  it("leave can't overlap; annual balance shown", async () => {
    const { app, owner } = await garage();
    const e = (await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE, joinDate: addDays(today(), -400) })).body.employee;
    expect((await call(app, "POST", `/api/employees/${e.id}/leave`, owner, { kind: "annual", from: addDays(today(), -30), to: addDays(today(), -26) })).status).toBe(200);
    const clash = await call(app, "POST", `/api/employees/${e.id}/leave`, owner, { kind: "sick", from: addDays(today(), -27), to: addDays(today(), -25) });
    expect(clash.status).toBe(409);
    const got = (await call(app, "GET", `/api/employees/${e.id}`, owner)).body.employee;
    expect(got.leave).toHaveLength(1);
    expect(got.annualLeaveDays).toBeGreaterThan(20);
  });

  it("an advance posts Dr staff advances / Cr cash", async () => {
    const { app, owner } = await garage();
    const e = (await call(app, "POST", "/api/employees", owner, EMPLOYEE)).body.employee;
    const r = await call(app, "POST", `/api/employees/${e.id}/advances`, owner, { amountFils: 50000, paidOn: today(), paidFromAccountId: A.cash.id, instalmentFils: 10000 });
    expect(r.status).toBe(200);
    postPending(app.db);
    expect(byCode(app, `staff_advance:${r.body.advance.id}`)).toEqual({ "1410": 50000, "1000": -50000 });
    expect((await call(app, "GET", `/api/employees/${e.id}`, owner)).body.employee.advanceOwedFils).toBe(50000);
    expect((await call(app, "POST", `/api/employees/${e.id}/advances`, owner, { amountFils: 100, paidOn: today(), paidFromAccountId: A.sales_other.id, instalmentFils: 100 })).status).toBe(400);
  });

  it("expiring documents within 30 days", async () => {
    const { app, owner } = await garage();
    await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE, visa: "201/2024/1", visaExpiry: addDays(today(), 10), passport: "P123", passportExpiry: addDays(today(), 90) });
    expect((await call(app, "GET", "/api/payroll/expiring", owner)).body.documents).toEqual([
      expect.objectContaining({ name: "Ravi Kumar", document: "Visa", expires: addDays(today(), 10) }),
    ]);
  });

  it("migration 14 marks 6000 and 2200 as system accounts and keeps entries", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 13 });
    old.run("UPDATE accounts SET system_key = NULL WHERE code IN ('6000', '2200')");
    old.run("DELETE FROM accounts WHERE code IN ('6001', '6002', '6003', '2210', '1410')");
    old.run(`INSERT INTO journal_entries (id, series, seq, number, date, narration, source_type, created_at) VALUES ('e1', '', 1, 'JV-00001', '2026-11-01', 'Old', 'manual', 'x')`);
    old.close();
    const db = new Db(file);
    expect(db.all("SELECT code, system_key FROM accounts WHERE code IN ('6000', '2200', '6001', '2210', '1410') ORDER BY code")).toEqual([
      { code: "1410", system_key: "staff_advances" }, { code: "2200", system_key: "salaries_payable" }, { code: "2210", system_key: "gratuity_provision" },
      { code: "6000", system_key: "salaries" }, { code: "6001", system_key: "allowances" },
    ]);
    expect(db.get("SELECT narration FROM journal_entries WHERE id = 'e1'")).toEqual({ narration: "Old" });
    db.run(`INSERT INTO journal_entries (id, series, seq, number, date, narration, source_type, created_at) VALUES ('e2', '', 2, 'JV-00002', '2026-11-30', 'Pay', 'payroll_run', 'x')`);
    db.close();
  });
});
