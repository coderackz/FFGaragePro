# Accounting Part 4b: Leavers and Payslips by Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A leaver's **final settlement**:
  - the app proposes each amount with how it was worked out: salary to the last day, leave not taken, gratuity, less advances;
  - the accountant can change an amount, giving a reason;
  - the owner approves;
  - it posts, is paid from a bank or cash box, and prints as a letter in English or English + Arabic.
- **Payslips sent** by email (PDF attached) or WhatsApp, through the messages feature.

**Architecture:** This follows Part 4a's patterns:
- a mergeable draft (`final_settlements`);
- an insert-only approval with the settlement exactly as approved (`settlement_approvals`), which the books and the letter read;
- an insert-only payment (`settlement_payments`, once per settlement).

Postings are new `postPending` rules. The maths lives in `packages/shared/src/payroll.ts`. The leaving month's payroll run leaves out anyone who has a final settlement (the settlement pays their days). Payslip messages reuse the outbox (`queueMessage`) with a new `payslip` event and an `employee_id`. They are hidden from anyone without `payroll.manage`.

**Tech Stack:** As 4a.

**Spec:**
- `docs/superpowers/specs/2026-11-19-accounting-design.md`:
  - Part 4: "final settlement", "Payslips: printed, or sent by WhatsApp or email … in English or Arabic";
  - Decisions §5, leaver pay is the garage's choice.
- Part 4a's plan and ledger rulings.

**Branch:** `feature/accounting-part4b-leavers`, from `feature/accounting-part4a-payroll`. **Migration 15** (migration 14 is already live on the cloud). It goes to the cloud before any PC.

## Global Constraints
- **The pay rules:** all four Settings → Payroll choices are needed before a final settlement can be opened: "Choose how pay is worked out in Settings → Payroll". There are no hidden defaults (§5).
- **Amounts:**
  - Each amount shows how it was worked out.
  - A changed amount needs a reason, and the reason is kept with it and printed on the letter.
- **Who does what:** the owner approves (`payroll.approve`), and `payroll.manage` does everything else. Advisors never see salaries, settlements or payslip messages.
- **Gratuity:** due only after one year of continuous service (Decree-Law 33 of 2021), counted without unpaid days. Under a year it is 0, and the provision held is released.
- **Leave not taken:**
  - days = `annualLeaveBalance` at the last day (it can be negative: leave taken ahead is deducted);
  - day rate = the salary day rule (÷30 or ×12÷365) applied to basic or gross, per `leaveBasis`.
- **Salary to the last day:** the leaving month's days worked, at the salary day rate (as `proposeLine` does for a leaver), less unpaid leave in them. It is only paid when that month's payroll hasn't already been approved with them in it.
- Everything balances to the fil. Posted entries never change.

## Review Focus
1. Under one year of service: the gratuity is 0, the provision held goes back to the gratuity expense, and the letter says why → Task 1 test `under a year: no gratuity`; Task 2 test `settlement releases the provision`.
2. Leave taken ahead of what was earned is deducted, not paid → Task 1 test `negative leave balance deducts`.
3. The leaving month already approved in a payroll with the leaver in it: the settlement doesn't pay those days again. A payroll for a later month leaves them out → Task 2 test `no salary twice`.
4. Approving twice, approving without the rules, paying twice, paying from a non-money account: each is refused. Posting twice posts once → Task 2 test `settlement approval and payment rules`.
5. Payslip messages never show to an advisor (message list, a customer's log), and only someone with `payroll.manage` can send one → Task 3 test `payslip messages are private`.

---

### Task 1: Shared: settlement maths, schemas, the payslip message event

**Files:**
- Modify: `packages/shared/src/payroll.ts`, `packages/shared/src/messages.ts`.
- Test: `packages/shared/test/payroll.test.ts`.

**Interfaces (produces):**
- **`settlementProposal(i)`** → `SettlementItem[]`.
  - Input:
    ```ts
    { employee: PayEmployee & { leftDate: string }; lastDay: string; unpaidLeave; annualTaken; rules: { salaryDayRate; gratuityDayRate; gratuityCap; leaveBasis };
      salaryAlreadyPaid: boolean; gratuityHeldFils: number; advancesOwedFils: number }
    ```
  - Each item:
    ```ts
    SettlementItem { key: "salary" | "leave" | "gratuity" | "advances"; label: string; proposedFils: number; amountFils: number; how: string; reason: string | null }
    ```
    `amountFils` = `proposedFils` until it is changed. Advances are a negative amount.
  - **salary:**
    - the leaving month's `proposeLine` (`advanceDueFils` 0): basic + allowances − unpaid deduction;
    - 0 with "Paid in the <Mon yyyy> payroll" when `salaryAlreadyPaid`;
    - `how` e.g. "12 days of 4,500.00 a month at Gross ÷ 30, less 0 unpaid days".
  - **leave:** `round(balance × dayRate(basic or gross, salaryDayRate→same divisor))`, e.g. "18.5 days not taken × 150.00 a day (Basic ÷ 30)".
  - **gratuity:**
    - `serviceDays(join, lastDay, unpaid)` < 365 → 0, with "Under one year of service (300 days): no gratuity";
    - otherwise `gratuityOwed` with the rules, e.g. "2 years 45 days: 21 days of basic a year, at Basic ÷ 30, capped at 2 years of basic".
  - **advances:** `-advancesOwedFils`, "Advances still owed".
- `settlementTotal(items) = Σ amountFils`.
- `settlementEditSchema = { key, amountFils (int, may be negative only for advances and leave), reason: string min 3 }`.
- `MESSAGE_EVENTS` gains `"payslip"`. `messageInputSchema` gains `employeeId?: uuid|null`.

- [ ] **Step 1: Write the failing tests**

```ts
const leaver = { ...emp, joinDate: "2024-01-01", leftDate: "2026-10-12" };
const rules = { salaryDayRate: "gross_30", gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic" } as const;
it("a final settlement: salary to the last day, leave, gratuity, less advances", () => {
  const items = settlementProposal({ employee: leaver, lastDay: "2026-10-12", unpaidLeave: [], annualTaken: [], rules, salaryAlreadyPaid: false, gratuityHeldFils: 0, advancesOwedFils: 20000 });
  const by = Object.fromEntries(items.map((i) => [i.key, i.amountFils]));
  expect(by.salary).toBe(180000);                       // 12 days × 450000 ÷ 30
  expect(by.leave).toBe(Math.round(2.5 * 33 * 10000));  // 33 whole months × 2.5 days × basic ÷ 30
  expect(by.gratuity).toBe(gratuityOwed({ basicFils: 300000, grossFils: 450000, serviceDays: serviceDays("2024-01-01", "2026-10-12", []), dayRate: "basic_30", cap: "basic" }));
  expect(by.advances).toBe(-20000);
  expect(items.every((i) => i.how.length > 0)).toBe(true);
});
it("under a year: no gratuity", () => {
  const g = settlementProposal({ employee: { ...leaver, joinDate: "2026-01-01" }, lastDay: "2026-10-12", unpaidLeave: [], annualTaken: [], rules, salaryAlreadyPaid: false, gratuityHeldFils: 50000, advancesOwedFils: 0 })
    .find((i) => i.key === "gratuity")!;
  expect(g.amountFils).toBe(0);
  expect(g.how).toMatch(/Under one year/);
});
it("negative leave balance deducts", () => {
  const l = settlementProposal({ employee: { ...leaver, joinDate: "2026-06-01" }, lastDay: "2026-10-12", unpaidLeave: [], annualTaken: [{ from: "2026-08-01", to: "2026-08-20" }], rules, salaryAlreadyPaid: false, gratuityHeldFils: 0, advancesOwedFils: 0 })
    .find((i) => i.key === "leave")!;
  expect(l.amountFils).toBe(Math.round((2.5 * 4 - 20) * 10000));
});
it("salary already paid in the payroll", () => {
  const s = settlementProposal({ employee: leaver, lastDay: "2026-10-12", unpaidLeave: [], annualTaken: [], rules, salaryAlreadyPaid: true, gratuityHeldFils: 0, advancesOwedFils: 0 }).find((i) => i.key === "salary")!;
  expect(s.amountFils).toBe(0);
});
it("payslip is a message event", () => expect(MESSAGE_EVENTS).toContain("payslip"));
```

- [ ] **Step 2: Run** `npx vitest run packages/shared/test/payroll.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** If a `Record<MessageEvent, …>` needs a `payslip` entry (message settings, labels, roles), add it: email by default, with a template "Your payslip for {doc_number} from {garage} is attached."
- [ ] **Step 4: Run** it, then `npm run typecheck` — Expected: pass.
- [ ] **Step 5: Commit** `feat(payroll): final settlement maths; payslip message event`.

### Task 2: Final settlements on the server

**Files:**
- Modify: `migrations.ts` (migration 15), `packages/sync/src/tables.ts`, `books/post.ts`, `books/rules.ts`, `books/pending.ts`, `payroll/runs.ts` (`employedIn`), `routes/payroll.ts`.
- Create: `packages/server/src/payroll/settlements.ts`.
- Test: `packages/server/test/payroll-settlements.test.ts`.

**Interfaces:**
- **Migration 15:**
  - Rebuild `journal_entries` with the source types `'final_settlement'` and `'settlement_paid'`.
  - Tables:
    - `final_settlements` (mergeable): id = stableId(`settlement|<employeeId>`), employee_id UNIQUE, last_day, items_json (edits: `{ key: { amountFils, reason } }`), created_by, created_at, updated_at;
    - `settlement_approvals` (insert-only): id, settlement_id UNIQUE, snapshot_json, approved_by, approved_at;
    - `settlement_payments` (insert-only): id, settlement_id UNIQUE, paid_on, account_id, amount_fils, created_by, created_at.
  - `messages.employee_id TEXT`.
  - Sync: the three new tables (insert-only as noted). The messages table already syncs.
- **Functions:**
  - `openSettlement(db, employeeId, userId)`. It refuses:
    - when the employee has no `leftDate` ("Enter the day they leave on the employee first");
    - when the pay rules are unchosen;
    - when a settlement already exists.
  - `getSettlement(db, employeeIdOrId)`:
    - while a draft, the proposal with edits applied (the `salaryAlreadyPaid` flag comes from an approved snapshot with the employee in the leaving month);
    - once approved, the snapshot.
    - Returns `{ id, employeeId, name, lastDay, items, totalFils, status, approvedAt, paidOn }`.
  - `editSettlement(db, id, { key, amountFils, reason })`: draft only. The reason is required when the amount differs from the proposal.
  - `approveSettlement(db, id, userId, { totalFils })`: `payroll.approve`.
    - It refuses: a total that differs from the one shown (409, like 4a's I7); a second approval; the last day being locked.
    - It stores the snapshot, including `gratuityHeldFils` (4a's `gratuityHeld`) and the split of salary between basic and allowances.
  - `markSettlementPaid(db, id, { date, accountId }, userId)`: approved only; once; a bank or cash money account; date ≥ the last day and not locked.
- **Runs:** `employedIn` leaves out an employee whose final settlement exists and whose `left_date` is in or before the run's month.
- **Posting rules:**
  - **`postSettlements`:** key `final_settlement:<id>`, dated `lastDay`.
    - Debits:
      - Salaries: the basic part of the salary;
      - Allowances: the allowance part;
      - Salaries: leave pay (a negative amount goes to the credit side);
      - Gratuity provision: the gratuity held;
      - Gratuity expense: gratuity − held, credited when negative.
    - Credits:
      - Staff advances: the advances owed;
      - Salaries payable: the total.
  - **`postSettlementPayments`:** key `settlement_paid:<id>`, Dr Salaries payable / Cr the account.
- **Routes** (`payroll.manage` unless noted):
  - `POST /api/employees/:id/settlement`, `GET /api/employees/:id/settlement`;
  - `PATCH /api/settlements/:id`;
  - `POST /api/settlements/:id/approve` (`payroll.approve`);
  - `POST /api/settlements/:id/paid`.

- [ ] **Step 1: Write the failing tests** (pinned clock 2026-11-20; books from 2026-09-01; Ravi joined 2024-01-01, basic 3,000 + allowances 1,500; the September payroll approved):
  - **`settlement releases the provision`:** Ravi leaves 2026-10-12 with an advance of 200.00 owed.
    - Open, approve and post.
    - The entry balances. 2210 ends at 0 for him (held released). 1410 ends at 0.
    - 2200 gets the total; marking it paid from the bank clears 2200.
  - **`no salary twice`:**
    - the October payroll approved with Ravi in it (left 2026-10-12, prorated), then his settlement: the salary item is 0 with "Paid in the Oct 2026 payroll";
    - in a second garage, the settlement first: the October payroll leaves Ravi out.
  - **`a changed amount needs a reason`:**
    - a PATCH of leave to 100.00 without a reason → 400;
    - with "Agreed with the owner" → the total moves and the reason is kept.
  - **`settlement approval and payment rules`:**
    - no leftDate → 400;
    - `leaveBasis` unchosen → 400;
    - an accountant approving → 403;
    - a total that moved → 409;
    - approving twice → 409;
    - paying from 4020 → 400;
    - paying twice → 409;
    - `postPending` twice → one entry.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payroll-settlements.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** that file, then `npm test` and `npm run typecheck` — Expected: pass.
- [ ] **Step 5: Commit** `feat(payroll): final settlements; migration 15`.

### Task 3: Payslip messages on the server

**Files:**
- Modify: `packages/server/src/messages/outbox.ts`, `routes/messages.ts`, and wherever customer message logs are listed.
- Test: `packages/server/test/payroll-messages.test.ts`.

**Interfaces:**
- `queueMessage` stores `employee_id`.
- `POST /api/messages` with `event: "payslip"` needs `payroll.manage` (403 otherwise) and an `employeeId`.
- `GET /api/messages` (and any list by customer or document) leaves out `event = 'payslip'` rows unless the user can `payroll.manage`.
- `GET /api/payroll/runs/:id/messages` lists that run's payslip messages, matched by `dedupe_key` `payslip:<runId>:<employeeId>`.

- [ ] **Step 1: Write the failing test** `payslip messages are private`:
  - the owner queues a payslip email for Ravi with a PDF;
  - an advisor's `GET /api/messages` doesn't include it;
  - an advisor posting a payslip message → 403;
  - an accountant sees it;
  - the run's messages list it once, and sending it again with the same dedupe key doesn't queue a second.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payroll-messages.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** that file and `npm test` — Expected: pass.
- [ ] **Step 5: Commit** `feat(payroll): payslips by message, private to payroll`.

### Task 4: Screens, the settlement letter, e2e, docs

**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/payroll/SettlementPage.tsx` (route `/employees/:id/settlement`);
  - `renderSettlementHtml` / `printSettlement` in `print/templates.ts` and `print.ts`;
  - `apps/desktop/src/renderer/pages/payroll/SendPayslips.tsx`.
- Modify:
  - `EmployeePage.tsx`: "Final settlement" appears once `leftDate` is set, opening the settlement (or showing it);
  - `PayrollRunPage.tsx`: a "Send payslips" button when approved;
  - `apps/desktop/test/payroll.spec.ts` (extend);
  - `README.md` ("Leavers and payslips by message", Accounting Part 4b; Next becomes Part 5, fixed assets).
- **The settlement page:**
  - one row per item: label, how it was worked out, amount, reason;
  - "Change" opens a dialog asking for the amount and the reason;
  - the total;
  - "Approve" (owner), which sends the total shown;
  - "Print letter";
  - "Mark paid" (a bank or cash box, and the date);
  - status badges: Draft / Approved / Paid.
- **The letter:**
  - the garage header;
  - the employee, job, joined and last day;
  - the items with how each was worked out and any reason;
  - the total;
  - a received-by signature.
  - English, or English + Arabic by the employee's language.
- **Send payslips:**
  - a dialog listing each person with the email and phone on their employee record;
  - "Email all with an address" queues one email each, with the payslip PDF (`makePdf(renderPayslipsHtml([slip]))`), event `payslip`, `employeeId`, dedupe key `payslip:<runId>:<employeeId>`;
  - a WhatsApp button per person opens `openWhatsApp(uaePhone(phone), text, pdf)`, logged like other WhatsApp messages;
  - rows already sent show Sent.
- [ ] **Step 1: Extend the e2e** (`payroll.spec.ts`, after the payslips):
  1. give Sami an email by API, and send payslips by email: his row shows Queued or Sent;
  2. set Sami's last day to the last day of last month by API;
  3. open his final settlement: four rows, each with a "how";
  4. change leave to 50.00 with a reason;
  5. approve, mark paid from 1020 Bank, print the letter;
  6. Books health shows all OK.
- [ ] **Step 2: Run** `npm run build -w @ffgp/desktop && npm run e2e:payroll` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the typecheck, the unit tests, the build and all 11 e2e suites — Expected: pass.
- [ ] **Step 5: Commit** `feat(payroll): final settlement screen and letter; send payslips`.
