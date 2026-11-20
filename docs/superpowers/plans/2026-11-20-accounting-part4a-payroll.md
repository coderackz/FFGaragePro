# Accounting Part 4a: Running Payroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay the garage's staff every month in the app.
- Employees, with documents and expiry dates, leave, and advances.
- A monthly run: the accountant prepares it and the owner approves it.
- On approval, the salaries and the gratuity put aside are posted.
- The WPS salary file (SIF), cash-bonus vouchers, paying the salaries, and payslips.

**Scope split:** Part 4 of the spec is split in two.
- **4a (this plan):** running payroll.
- **4b (next plan):**
  - the final settlement for a leaver;
  - sending payslips by WhatsApp or email.

The garage's pay choices (Settings → Payroll) are needed in 4a already, because the monthly run uses the unpaid-leave day rate and the gratuity accrual uses the gratuity rules.

**Architecture:** People's actions are synced rows: employees, leave, advances, runs and their lines, approvals, and the marks for "WPS paid" and "bonus paid". Postings are new rules in the existing idempotent `postPending` (packages/server/src/books/rules.ts), so they post only where the books post, like every other automatic entry. All pay maths lives in pure functions in `packages/shared/src/payroll.ts`, so the server, the screens and the tests use the same numbers. Amounts are integer fils, and each line is rounded to the fil.

**Tech Stack:** As before: TypeScript, Zod 4, node:sqlite, Fastify, React 19, Vitest, Playwright, and the print templates of Part 3a (`apps/desktop/src/renderer/print`).

**Spec:** `docs/superpowers/specs/2026-11-19-accounting-design.md` (Part 4 — Payroll; the posting table; Decisions after the builder check §1, §2 and §5; Constraints; Anti-goals; Open question 1).

**Branch:** `feature/accounting-part4a-payroll` from `main` (16c4257). Migration 14 goes to the cloud with migrations 11–13, before any PC.

## Global Constraints
- **Money:** integer fils. Every entry balances, and posted entries never change.
- **Who can do what:**
  - `payroll.manage` (Owner, Accountant): employees, leave, advances, preparing runs, marking paid.
  - `payroll.approve` (Owner only).
  - Advisors never see salaries: every payroll route needs `payroll.manage`, and the nav hides payroll from them.
- **No hidden default for pay rules (spec §5).** Settings → Payroll holds four choices, all `null` until chosen:
  - `gratuityDayRate`: `"basic_30"` or `"basic_365"`;
  - `gratuityCap`: `"basic"` or `"gross"`, two years of it;
  - `leaveBasis`: `"basic"` or `"gross"`;
  - `salaryDayRate`: `"gross_30"` or `"gross_365"`.

  Approving a run is refused until `gratuityDayRate`, `gratuityCap` and `salaryDayRate` are chosen: "Choose how pay is worked out in Settings → Payroll". `leaveBasis` is needed only by 4b.
- **Gratuity (Decree-Law 33 of 2021):**
  - 21 days of basic for each of the first five years of service, 30 days for each year after;
  - pro rata for part years;
  - capped at two years of basic or gross (the garage's choice);
  - service leaves out unpaid-leave days.
- Annual leave builds up at 2.5 days per month of service (spec).
- **WPS file:**
  - the cash bonus is not in WPS unless `bonusInWps` is on;
  - a salary is never paid twice: "WPS paid" can be marked once per run;
  - the SIF layout is the MOHRE standard below, kept in one function. The spec's open question 1 still stands: one real SIF accepted by a garage's bank confirms it.
- One place posts (`postsBooks`). Approving and marking paid are people's actions: they work on any PC and sync.
- Screens stay English. Payslips print in English, or English + Arabic, by the employee's language.

## Review Focus
1. Someone who joins mid-month is paid for their days only (the salary day rate × days from the joining date). Someone with no days in the month isn't in the run → Task 1 test `joiner mid-month is prorated`; Task 3 test `run proposes only people employed that month`.
2. Unpaid leave that crosses a month end deducts only the days inside the run's month, and those days don't count as service for gratuity → Task 1 tests `unpaid leave across months` and `gratuity leaves out unpaid days`.
3. An advance's instalment is never more than what's left of it, and a run whose net pay goes below zero can't be approved → Task 3 test `instalment capped and negative net refused`.
4. Approving twice, editing after approval, approving before the previous month, or approving with pay rules unchosen: each is refused. Posting the same run again posts nothing → Task 3 test `approval rules`.
5. `bonusInWps` on: the bonus goes into the SIF's variable column and into salaries payable. Off: it's paid from cash on the voucher, and the SIF's total leaves it out → Task 4 test `bonus in or out of WPS`.

---

### Task 1: Shared payroll model and maths

**Files:**
- Create: `packages/shared/src/payroll.ts`, exported from `index.ts`.
- Modify: `rules.ts` (actions), `settings.ts` (a `payroll` section), `books.ts` (system accounts).
- Test: `packages/shared/test/payroll.test.ts`.

**Interfaces (produces):**
- **Actions:** `"payroll.manage"` (owner, accountant) and `"payroll.approve"` (owner).
- **Settings** `payroll`:
  ```ts
  {
    establishmentId: string|null;      // MOHRE employer ID, 13 digits
    employerRoutingCode: string|null;  // 9 digits
    bonusInWps: boolean;               // false
    gratuityDayRate, gratuityCap, leaveBasis, salaryDayRate; // the four choices above, default null
  }
  ```
- **SYSTEM accounts:**
  - `salaries` 6000 Salaries (existing id);
  - `allowances` 6001 Allowances;
  - `staff_bonus` 6002 Staff bonus;
  - `gratuity_expense` 6003 End-of-service gratuity;
  - `salaries_payable` 2200 Salaries payable (existing id);
  - `gratuity_provision` 2210 Gratuity provision;
  - `staff_advances` 1410 Staff advances.

  Remove 6000 and 2200 from `OTHER`.
- **Schemas:**
  - `employeeSchema`:
    - name, nameAr?, job, nationality, joinDate, leftDate?;
    - basicFils, housingFils, transportFils, otherAllowanceFils;
    - payMethod `"bank"|"salary_card"`, iban/cardNumber, routingCode (9 digits), personId (14 digits, for MOHRE);
    - emiratesId plus expiry, labourCard plus expiry, passport plus expiry, visa plus expiry;
    - language `"en"|"en_ar"`, phone?, email?.
  - `leaveSchema`: kind `"annual"|"sick"|"unpaid"`, from, to, note?.
  - `advanceSchema`: amountFils, paidOn, paidFromAccountId, instalmentFils, note?.
  - `runLineEditSchema`: bonusFils?, extrasFils?, extrasNote?, advanceRepaymentFils?.
- **Pure functions** (dates `YYYY-MM-DD`, months `YYYY-MM`):
  - `monthDays(month): { from: string; to: string; days: number }`.
  - `daysIn(range: {from,to}, within: {from,to}): number` (inclusive overlap).
  - `dayRate(monthlyFils, rule: "gross_30"|"gross_365"|"basic_30"|"basic_365"): number` (fractional fils: ÷30, or ×12÷365).
  - `proposeLine(input): PayLine`:
    - input: `{ month; employee: { basicFils, housingFils, transportFils, otherAllowanceFils, joinDate, leftDate }; unpaidLeave: {from,to}[]; salaryDayRate; advanceDueFils }`;
    - output: `{ workedDays, basicFils, allowancesFils, unpaidDays, unpaidDeductionFils, advanceRepaymentFils, extrasFils: 0, bonusFils: 0, netFils }`;
    - a month fully worked pays the full basic and allowances;
    - a joiner or leaver part-month is paid `round(dayRate(gross) × workedDays)`, split between basic and allowances in proportion;
    - unpaid days (within the month and the worked days) are deducted at `dayRate(gross)`;
    - `netFils = basic + allowances − unpaidDeduction − advanceRepayment + extras` (the bonus is added only by the WPS rule in Task 4).
  - `serviceDays(joinDate, asOf, unpaidLeave): number` (calendar days from joining up to `asOf`, less unpaid days).
  - `gratuityOwed({ basicFils, grossFils, serviceDays, dayRate: "basic_30"|"basic_365", cap: "basic"|"gross" }): number`:
    - years = serviceDays / 365;
    - days of pay = 21 × min(years, 5) + 30 × max(years − 5, 0);
    - amount = round(dayRate(basic) × days of pay), capped at 24 × (basic or gross);
    - computed whatever the service (the provision builds from day one; the one-year qualifying rule is 4b's).
  - `annualLeaveBalance(joinDate, asOf, annualTaken: {from,to}[]): number` (2.5 × whole months of service, less annual days taken).
  - `buildSif(input): { fileName: string; text: string }`:
    - EDR lines: `EDR,<personId>,<routingCode>,<iban|card>,<from>,<to>,<days>,<fixed 0.00>,<variable 0.00>,<leave days>`;
    - SCR line: `SCR,<establishmentId>,<employerRoutingCode>,<YYYY-MM-DD>,<HHMM>,<MMYYYY>,<EDR count>,<total 0.00>,AED,<reference>`;
    - CRLF line endings;
    - fileName `<establishmentId><YYMMDDHHMMSS>.SIF`;
    - throws on a missing or ill-formed ID or code, naming the employee.

- [ ] **Step 1: Write the failing tests**

```ts
const emp = { basicFils: 300000, housingFils: 100000, transportFils: 50000, otherAllowanceFils: 0, joinDate: "2024-01-01", leftDate: null };
it("a full month pays basic and allowances", () => {
  expect(proposeLine({ month: "2026-10", employee: emp, unpaidLeave: [], salaryDayRate: "gross_30", advanceDueFils: 0 }))
    .toMatchObject({ workedDays: 31, basicFils: 300000, allowancesFils: 150000, unpaidDays: 0, netFils: 450000 });
});
it("joiner mid-month is prorated", () => {
  const l = proposeLine({ month: "2026-10", employee: { ...emp, joinDate: "2026-10-22" }, unpaidLeave: [], salaryDayRate: "gross_30", advanceDueFils: 0 });
  expect(l.workedDays).toBe(10);
  expect(l.basicFils + l.allowancesFils).toBe(150000); // 450000 ÷ 30 × 10
});
it("unpaid leave across months", () => {
  const l = proposeLine({ month: "2026-10", employee: emp, unpaidLeave: [{ from: "2026-10-30", to: "2026-11-03" }], salaryDayRate: "gross_365", advanceDueFils: 10000 });
  expect(l.unpaidDays).toBe(2);
  expect(l.unpaidDeductionFils).toBe(Math.round((450000 * 12 / 365) * 2));
  expect(l.advanceRepaymentFils).toBe(10000);
  expect(l.netFils).toBe(450000 - l.unpaidDeductionFils - 10000);
});
it("gratuity: 21 days a year to five, 30 after, capped", () => {
  expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: 365, dayRate: "basic_30", cap: "basic" })).toBe(210000);
  expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: 365 * 7, dayRate: "basic_30", cap: "basic" })).toBe(10000 * (105 + 60));
  expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: 365 * 30, dayRate: "basic_30", cap: "basic" })).toBe(300000 * 24);
  expect(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: 365 * 30, dayRate: "basic_30", cap: "gross" })).toBe(10000 * (105 + 750));
});
it("gratuity leaves out unpaid days", () => {
  expect(serviceDays("2025-01-01", "2025-12-31", [{ from: "2025-03-01", to: "2025-03-10" }])).toBe(365 - 10);
});
it("annual leave builds at 2.5 days a month", () => {
  expect(annualLeaveBalance("2026-01-15", "2026-11-20", [{ from: "2026-06-01", to: "2026-06-05" }])).toBe(2.5 * 10 - 5);
});
it("SIF: EDR per employee, SCR last, named for the employer", () => {
  const s = buildSif({ establishmentId: "1234567890123", employerRoutingCode: "803320101", month: "2026-10", createdAt: new Date("2026-11-01T06:30:15Z"), reference: "OCT26",
    lines: [{ name: "Ravi", personId: "10012345678901", routingCode: "803320101", account: "AE070331234567890123456", from: "2026-10-01", to: "2026-10-31", days: 31, fixedFils: 450000, variableFils: 0, leaveDays: 0 }] });
  expect(s.fileName).toBe("1234567890123261101103015.SIF");
  expect(s.text.split("\r\n")).toEqual([
    "EDR,10012345678901,803320101,AE070331234567890123456,2026-10-01,2026-10-31,31,4500.00,0.00,0",
    "SCR,1234567890123,803320101,2026-11-01,1030,102026,1,4500.00,AED,OCT26", "",
  ]);
  expect(() => buildSif({ ...input, lines: [{ ...line, personId: "123" }] })).toThrow(/Ravi/);
});
it("payroll permissions", () => {
  expect(can("accountant", "payroll.manage")).toBe(true);
  expect(can("accountant", "payroll.approve")).toBe(false);
  expect(can("advisor", "payroll.manage")).toBe(false);
});
```
(The SIF's date and time are Dubai time: 06:30Z is 10:30.)

- [ ] **Step 2: Run** `npx vitest run packages/shared/test/payroll.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `payroll.ts`, the actions, the settings section and the accounts.
- [ ] **Step 4: Run** it — Expected: PASS. Then run `npm run typecheck` — Expected: exit 0.
- [ ] **Step 5: Commit** `feat(payroll): payroll maths, settings, accounts and permissions`.

### Task 2: Employees, leave and advances (server)

**Files:**
- Modify: `packages/server/src/migrations.ts` (migration 14), `packages/sync/src/tables.ts`, `packages/server/src/books/rules.ts` and `post.ts` (the `staff_advance` source type).
- Create: `packages/server/src/payroll/employees.ts`, `packages/server/src/routes/payroll.ts` (registered in `app.ts` with `{ posts }`).
- Test: `packages/server/test/payroll-employees.test.ts`.

**Interfaces:**
- **Migration 14:**
  - Rebuild `journal_entries` to add the source types `'payroll_run'`, `'wps_paid'`, `'bonus_paid'` and `'staff_advance'` (the migration 13 pattern).
  - Insert the new system accounts with `INSERT OR IGNORE`, and `UPDATE accounts SET system_key = …` for 6000 and 2200.
  - Tables:
    - `employees`: every field of `employeeSchema`, plus `created_at` and `updated_at`;
    - `employee_leave`: id, employee_id, kind, from_date, to_date, note, created_by, created_at;
    - `staff_advances`: id, employee_id, amount_fils, paid_on, paid_from_account_id, instalment_fils, note, created_by, created_at;
    - `payroll_runs`: id, month UNIQUE, status `draft|approved`, approved_by, approved_at, wps_paid_on, wps_bank_account_id, bonus_paid_on, bonus_cash_account_id, created_at, updated_at;
    - `payroll_lines`: id, run_id, employee_id, the `PayLine` fields, gratuity_fils, bonus_in_wps (0/1), UNIQUE(run_id, employee_id).
  - Sync:
    - field-merge: employees, payroll_runs, payroll_lines;
    - insert-only: employee_leave, staff_advances.
- **Functions:**
  - `listEmployees(db, { includeLeft })` and `getEmployee(db, id)`. `getEmployee` returns the employee with:
    - `leave` and `advances`;
    - `advanceOwedFils` (advances less repayments in approved runs);
    - `annualLeaveDays` (`annualLeaveBalance` up to today);
    - `expiring` (documents expiring within 30 days, or already expired).
  - `createEmployee`, `updateEmployee`, `addLeave` (refuses a range that overlaps the same employee's leave), `addAdvance`.
  - `expiringDocuments(db, within = 30)`: `{ employeeId, name, document: "Emirates ID"|"Labour card"|"Passport"|"Visa", expires }[]`.
- **Routes** (all `payroll.manage`):
  - `GET/POST /api/employees`, `GET/PATCH /api/employees/:id`;
  - `POST /api/employees/:id/leave`, `POST /api/employees/:id/advances`;
  - `GET /api/payroll/expiring`.
- **Posting rule** `postStaffAdvances`: Dr 1410 Staff advances / Cr the paid-from account, post key `staff_advance:<id>`, dated `paid_on`.

- [ ] **Step 1: Write the failing tests:**
  - `employees: create, edit, list; advisors get 403`;
  - `leave can't overlap; annual balance shown`;
  - `an advance posts Dr staff advances / Cr cash`, with the entry `{ "1410": 50000, "1000": -50000 }`;
  - `expiring documents within 30 days`: a visa expiring in 10 days is listed, a passport in 90 days is not;
  - `migration 14 marks 6000 and 2200 as system accounts and keeps entries`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payroll-employees.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** that file, then `npm test` and `npm run typecheck` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(payroll): employees, leave and advances; migration 14`.

### Task 3: Monthly runs: propose, edit, approve, post

**Files:**
- Create: `packages/server/src/payroll/runs.ts`.
- Modify: `routes/payroll.ts`, `books/rules.ts` and `pending.ts`.
- Test: `packages/server/test/payroll-runs.test.ts`.

**Interfaces:**
- `openRun(db, month, userId)`:
  - refuses an existing month, and a month after today's;
  - inserts a line per employee employed for at least one day of the month (joinDate ≤ the month's end, and no leftDate before its start), from `proposeLine`;
  - `advanceDueFils` = min(the sum of open advances' instalments, what's still owed).
- `getRun(db, idOrMonth)`: the run with its lines (employee name and pay method) and totals: `{ grossFils, deductionsFils, advancesFils, bonusFils, netWpsFils, gratuityFils }`.
- `editLine(db, runId, employeeId, input)`:
  - only while the run is `draft`;
  - recomputes `netFils`;
  - `advanceRepaymentFils` can't be more than what's owed.
- `refreshRun(db, runId)` re-proposes the draft's lines from the current employees and leave, keeping typed bonuses and extras.
- `approveRun(db, runId, userId)` (`payroll.approve`). It refuses:
  - a run that isn't a draft;
  - any line with `netFils < 0` (naming the employee);
  - an earlier month that exists and is still a draft ("Approve <Mon yyyy> first");
  - the three pay rules not chosen;
  - the month's last day locked (`checkNotLocked`).

  On approval it:
  - sets `gratuity_fils` per line to `gratuityOwed(at the month end) − the gratuity held` (the sum of `gratuity_fils` in earlier approved runs; it can be negative after a pay cut);
  - sets `bonus_in_wps` from the setting;
  - stamps `approved_by`/`approved_at`.
- **Posting rule** `postPayrollRuns`, for approved runs, post key `payroll_run:<id>`, dated the month's last day.
  - Debits:
    - Salaries: basic − the unpaid deduction's basic share (the deduction is split pro rata);
    - Allowances: allowances − the rest of the deduction;
    - Salaries again: extras;
    - Staff bonus: the bonus, only for lines with `bonus_in_wps`;
    - Gratuity expense: the sum of `gratuity_fils` (a negative total goes to the credit side).
  - Credits:
    - Salaries payable: Σ netFils plus the WPS bonuses;
    - Staff advances: Σ advance repayments;
    - Gratuity provision: Σ gratuity_fils.
- Routes:
  - `GET /api/payroll/runs` (the list), `POST /api/payroll/runs { month }`, `GET /api/payroll/runs/:id`;
  - `PATCH /api/payroll/runs/:id/lines/:employeeId`, `POST /api/payroll/runs/:id/refresh`;
  - `POST /api/payroll/runs/:id/approve`.

- [ ] **Step 1: Write the failing tests** (October, with books started 2026-09-01; pin the clock as in `vat-returns.test.ts`):
  - **`run proposes only people employed that month`:** one employee from 2024, one joining 22 Oct, one who left on 30 Sep. The run has 2 lines, and the joiner's gross is 10/30 of theirs.
  - **`instalment capped and negative net refused`:**
    - an advance of 150.00 with an instalment of 200.00 proposes a repayment of 150.00;
    - editing the repayment to 300.00 → 400;
    - extras of −5,000.00 on a 4,500.00 salary → approving gives 400 naming the employee.
  - **`approval rules`:**
    - an accountant approving → 403;
    - pay rules unchosen → 400 /Settings → Payroll/;
    - approving November with October still a draft → 409;
    - approving October → 200, then again → 409;
    - editing a line → 409;
    - `postPending` twice → one `payroll_run:` entry.
  - **`approval posts salaries, advances and gratuity`:**
    - basic 3,000.00 plus allowances 1,500.00, with 2 unpaid days (`gross_30`) and an advance repayment of 100.00;
    - the entry by code is `{ "6000": basic − its share of the deduction, "6001": allowances − its share, "6003": gratuity, "2200": −net, "1410": −10000, "2210": −gratuity }`;
    - it balances;
    - the gratuity equals `gratuityOwed` at 31 Oct for the service from 2024-01-01;
    - the November run's gratuity is the difference only.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payroll-runs.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** that file, then `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(payroll): monthly runs, approval and posting`.

### Task 4: WPS file, paying salaries and cash bonuses, payslip data

**Files:**
- Modify: `payroll/runs.ts`, `routes/payroll.ts`, `books/rules.ts`.
- Test: `packages/server/test/payroll-pay.test.ts`.

**Interfaces:**
- `wpsFile(db, runId)`: for an approved run only. It builds the SIF from the lines:
  - fixed = `netFils`;
  - variable = the bonus when `bonus_in_wps`;
  - leave days = unpaid days;
  - days = worked days;
  - the reference is the month as `MMMYY` (e.g. `OCT26`).

  It refuses until the payroll settings hold the establishment ID and the employer routing code. Lines paid by salary card use the card number as the account.
  Route: `GET /api/payroll/runs/:id/wps`, which returns `{ fileName, text }`.
- `markWpsPaid(db, runId, { date, bankAccountId }, userId)`:
  - approved runs only;
  - only once ("Already marked paid on …");
  - the bank must be a `bank` money account;
  - the date must be on or after the month end and not locked.

  Posting rule `postWpsPaid`: Dr 2200 / Cr bank, total `netWpsFils`, key `wps_paid:<runId>`.
- `markBonusPaid(db, runId, { date, cashAccountId }, userId)`:
  - only when the run has non-WPS bonuses;
  - only once;
  - the account must be a `cash` money account.

  Posting rule `postBonusPaid`: Dr 6002 / Cr cash, the total of the non-WPS bonuses, key `bonus_paid:<runId>`.
- `payslips(db, runId)`: per line, `{ employee: { name, nameAr, job, language, personId }, month, basicFils, allowances: { housing, transport, other }, unpaidDays, unpaidDeductionFils, advanceRepaymentFils, extrasFils, extrasNote, bonusFils, bonusInWps, netWpsFils, paidBy }`.
  Route: `GET /api/payroll/runs/:id/payslips`.
- `GET /api/payroll/runs/:id/bonus-voucher` returns the non-WPS bonus lines: `{ name, job, bonusFils }[]` and the total.

- [ ] **Step 1: Write the failing tests:**
  - **`bonus in or out of WPS`:** two employees with bonuses 200.00 and 0.
    - With `bonusInWps` off: the SIF's EDR variable column reads `0.00`, and the SCR total is the sum of net pay. Marking the bonus paid from cash posts `{ "6002": 20000, "1000": -20000 }`.
    - In a second garage with it on: the variable column reads `200.00`, the SCR total includes it, the run entry has `6002: 20000`, and marking the bonus paid → 409 ("no cash bonuses in this run").
  - **`WPS paid once, from a bank`:**
    - marking it paid from cash → 400;
    - from the bank → 200, posting `{ "2200": net, "1020": -net }`;
    - a second time → 409;
    - on a draft run → 409.
  - **`SIF needs the employer details`:** with no establishment ID → 400 /Settings → Payroll/.
  - **`payslips list each line`**, with an EN + AR employee's `language: "en_ar"`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payroll-pay.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** that file, then `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(payroll): WPS file, paying salaries and bonuses, payslips`.

### Task 5: Screens: employees, settings, the dashboard

**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/payroll/EmployeesPage.tsx`;
  - `EmployeePage.tsx`, which includes the form modal, the leave and advance dialogs, and the expiry badges;
  - `apps/desktop/src/renderer/pages/settings/sections/PayrollSection.tsx`.
- Modify:
  - `App.tsx` (routes `/employees`, `/employees/:id`, `/payroll`, `/payroll/:id`, under `payroll.manage`);
  - `Layout.tsx`: a "Payroll" nav group with Employees and Payroll, shown with `payroll.manage`;
  - the settings tiles and `describe.ts` (a "Payroll" tile, its status, field names);
  - `DashboardPage.tsx`: a card "Staff documents expiring", shown with `payroll.manage`, listing `GET /api/payroll/expiring` (red if expired, amber within 30 days), each row linking to the employee.
- The Settings → Payroll section has:
  - the establishment ID;
  - the employer routing code;
  - "Put the bonus in WPS as variable pay";
  - four selects, each with a one-line explanation:
    - "Gratuity day rate": "Basic ÷ 30" or "Basic × 12 ÷ 365";
    - "Gratuity cap": "Two years of basic" or "Two years of gross";
    - "Leave not taken paid on": "Basic" or "Gross";
    - "Salary day rate (part months, unpaid leave)": "Gross ÷ 30" or "Gross × 12 ÷ 365".

  Each select has "Choose…" as its empty state.
- Covered by the Task 6 e2e.
- [ ] **Step 1: Implement**, then run `npm run typecheck` — Expected: exit 0.
- [ ] **Step 2: Commit** `feat(payroll): employees, payroll settings and expiry reminders`.

### Task 6: The payroll run screen, payslips, vouchers, e2e, docs

**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/payroll/PayrollPage.tsx` (the runs list plus "Run payroll for <month>");
  - `PayrollRunPage.tsx`;
  - in `apps/desktop/src/renderer/print/templates.ts` and `print.ts`: `renderPayslipHtml` / `printPayslips(slips, garage, settings, mode)` (one A4 page per employee, English or English + Arabic by the employee's language, using the existing `L`/`H` helpers) and `renderBonusVoucherHtml` / `printBonusVoucher` (a list with a signature column);
  - `apps/desktop/test/payroll.spec.ts`, `playwright.payroll.config.ts`, and an `e2e:payroll` script.
- Modify: `README.md` (a section "Payroll (Accounting Part 4a)"; Next becomes Part 4b, leavers and sending payslips).

**The run page:**
- **A grid**, one row per employee: Days, Basic, Allowances, Unpaid days/deduction, Advance, Extras, **Bonus** (an input while draft), Net (WPS).
- **The totals row**, which also shows the gratuity put aside this month.
- **Buttons by status:**
  - draft: "Refresh from employees", and "Approve" (when `can("payroll.approve")`), which confirms and states the totals;
  - approved:
    - "Download WPS file" (saves `fileName` with the SIF text);
    - "Mark WPS paid" (a dialog with the bank and date);
    - "Print bonus voucher" and "Mark bonus paid" (a dialog with the cash box and date), when there are cash bonuses;
    - "Print payslips".
- **Status badges:** Draft / Approved / WPS paid / Bonus paid.

- [ ] **Step 1: Write the failing e2e** (`payroll.spec.ts`):
  1. **Set-up:**
     - books start the first day of last month;
     - Settings → Payroll: the establishment ID `1234567890123`, the routing code `803320101`, and the four choices (gratuity Basic ÷ 30, cap basic, leave basic, salary Gross ÷ 30);
     - add 2 employees on the Employees page (one with a visa expiring in 10 days), with basic, allowances, IBAN and person ID;
     - give one an advance of 300.00 from cash with an instalment of 100.00.
  2. **The dashboard** shows the expiring visa.
  3. **Payroll:**
     - "Run payroll" for last month: 2 rows;
     - the advance row shows 100.00;
     - type a bonus of 250.00 for one;
     - Approve: the status shows Approved.
  4. **WPS and the bonus:**
     - "Download WPS file": the downloaded file name ends `.SIF` and its first line starts `EDR,`;
     - "Mark WPS paid" from 1020 Bank: the badge shows WPS paid;
     - "Mark bonus paid" from 1000 Cash: the badge shows Bonus paid.
  5. **Printing:** "Print payslips" opens a print without a page error (as other print e2es do).
  6. **Books health:** every check shows OK.
- [ ] **Step 2: Run** `npm run build -w @ffgp/desktop && npm run e2e:payroll` — Expected: FAIL (no Payroll nav).
- [ ] **Step 3: Implement** the pages, templates, README and config.
- [ ] **Step 4: Run** `npm run typecheck`, `npm test`, `npm run build -w @ffgp/desktop`, and all e2e suites (`e2e`, `e2e:settings`, `e2e:credit`, `e2e:messages`, `e2e:books`, `e2e:payables`, `e2e:vat`, `e2e:payroll`, `e2e:electron`, `e2e:cloud`, `e2e:sync`) — Expected: all pass.
- [ ] **Step 5: Commit** `feat(payroll): payroll runs screen, WPS, payslips and bonus vouchers`.
