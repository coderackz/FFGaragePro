# Accounting Part 2 — Suppliers, expenses and bank — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supplier bills for anything (not only parts), paying suppliers (split across bills, or held as an advance), supplier balances, aging and statements, expenses paid on the spot with a receipt photo, bank and cash accounts with transfers, cheques received and issued, and bank reconciliation from a CSV statement. All of it posts to the Part 1 books.

**Architecture:**
- **Migration 12** adds:
  - `supplier_bills` and their lines;
  - `supplier_payments` and allocations to bills or goods receipts;
  - `expenses`, `money_transfers`, `cheque_deposits`, `cheque_clearances`;
  - `bank_imports` and `bank_lines`;
  - supplier terms and opening balance;
  - an account `money_kind`, and the system account `cheques_issued` (2010).
  - It also rebuilds `journal_entries` to widen its `source_type` CHECK.
- **Posting:** each new source posts through Part 1's `postPending` rules (one function per source, keyed `post_key`), only at the posting place.
- **Supplier side:** it mirrors the customer side: balance, aging and statement come from goods receipts, bills, payments and the opening balance.

**Tech Stack:** TypeScript, Zod 4, node:sqlite, Fastify, React 19, Vitest, Playwright. No new dependencies (CSV uses `packages/server/src/csv.ts` `parseCsv`).

**Spec:** `docs/superpowers/specs/2026-11-19-accounting-design.md`: Part 2 goals, the posting table rows "Supplier bill" and "Supplier payment", Constraints, Anti-goals. Part 1 (`feature/accounting-part1-books`) is the base branch.

## Global Constraints
- Everything in Part 1's Global Constraints still holds:
  - money in fils, balanced entries, never edit posted entries;
  - only the posting place posts;
  - dates people choose are refused in a locked period or before the books start (`checkNotLocked`);
  - control accounts are refused in manual journals.
- **A goods receipt is already the supplier's bill for parts** (Part 1 posts it to payables). Bills here are for everything else.
- **Bill VAT per line:** `standard` (5% of net, rounded per line with `roundFils`) or `none`. Bill gross = Σ net + Σ VAT.
- A bill is posted when saved. It is corrected by **cancelling**: a mirror entry, allowed only if nothing is allocated to it. A posted bill is never edited.
- **Supplier payments:**
  - Paying a supplier is split oldest first, by due date (editable).
  - Anything left over is the **supplier advance** (debit balance), used later by allocating.
  - Methods: `cash`, `bank_transfer`, `card`, `cheque`.
  - A cheque posts to **Cheques issued** (2010, liability) until it is marked cleared, which then posts from the bank.
- **Customer cheques** (receipts with method `cheque`) sit in Cheques in hand until deposited. A deposit names the bank account and posts Dr bank / Cr cheques in hand. A post-dated cheque shows its cheque date and can't be deposited before it.
- **Money accounts** are asset accounts with a `money_kind` (`cash`, `bank`, `card_clearing`, `cheques_in_hand`). Any number can be added from the chart. The system ones are already tagged.
- New actions: `payables.manage` for Owner and Accountant. Advisors see none of this.
- New number kinds:
  - `supplier_payment`: prefix `PV`, a payment voucher;
  - `expense`: prefix `EX`.
  - Bills keep the supplier's own invoice number.
- **Receipt photo:** PNG or JPG under 1 MB, stored as a data URL (like the logo), synced.
- **Bank CSV:** the columns are mapped once per bank account (date, description, amount, or separate debit and credit, and reference; the date format). Importing the same line twice is skipped (key = date + amount + description + reference).
- Migration 12 only; never edit migrations 1–11. Update the cloud before the PCs.

## Review Focus
1. **Paying more than a supplier is owed:** the rest becomes the advance, the supplier balance goes into debit, and payables health stays green. → Task 3 test `overpayment becomes an advance`.
2. **A bill with standard and no-VAT lines:** input VAT counts only the standard lines, each rounded to the fil, and the entry balances. → Task 3 test `bill posts net by account and VAT per line`.
3. **A cheque issued in one month and cleared the next:** the bank balance moves on the clearing date, not the payment date. It can't be cleared twice. → Task 4 test `issued cheque: payable on payment, bank on clearing`.
4. **The same bank statement imported twice, in a "debit/credit columns, dd/mm/yyyy" layout with amounts like "1,234.50":** parsed correctly, no duplicate lines. → Task 5 test `import parses layouts and skips duplicates`.
5. **Cancelling a bill that is partly paid:** refused. Cancelling an unpaid one posts the mirror. → Task 3 test `cancel only an unpaid bill`.

---

### Task 1: Shared — schemas, permissions, numbering, chart additions

**Files:**
- Create: `packages/shared/src/payables.ts`, `packages/shared/test/payables.test.ts`
- Modify: `packages/shared/src/{index,rules,settings,books,schemas}.ts`

**Interfaces:**
- **Produces in `payables.ts`:**
  - **Bills:**
    - `BILL_VAT = ["standard","none"]`;
    - `billLineSchema` (accountId, description 1–200, netFils int ≥ 0, vat enum, default `standard`);
    - `supplierBillSchema` (supplierId uuid, supplierInvoiceNo 1–60, billDate ymd, dueDate ymd optional, notes, lines 1–100);
    - `billTotals(lines) → { netFils, vatFils, grossFils }`, where VAT per standard line = `roundFils(net × 0.05)`.
  - **Payments:** `supplierPaymentSchema` (supplierId, amountFils > 0, method, paidFromAccountId, reference, chequeNo, chequeDate, paidAt optional, allocations optional `[{ target: "bill"|"goods_receipt", id, amountFils > 0 }]`).
  - **Expenses:** `expenseSchema` (date ymd, accountId, description 1–200, netFils > 0, vat enum, paidFromAccountId, payee optional text 120, reference, photo: `imageSchema` with a 1 MB limit).
  - **Money movements:** `transferSchema` (date, fromAccountId ≠ toAccountId, amountFils > 0, reference); `chequeDepositSchema` (receiptIds 1–100, bankAccountId, date); `chequeClearSchema` (paymentIds 1–100, date).
  - **Bank statements:**
    - `bankMappingSchema` (date, description, amount | debit + credit, reference column indexes; dateFormat `dd/mm/yyyy` | `mm/dd/yyyy` | `yyyy-mm-dd`; hasHeader);
    - `parseStatement(rows: string[][], m: BankMapping) → { date, description, amountFils, reference }[]`. It accepts "1,234.50", "(12.00)" and "-12.00"; a debit column is money out (negative). A row that can't be parsed throws `"Row N: …"`.
- **Modifies:**
  - `rules.ts`: `ACTIONS` + `"payables.manage"` (Owner, Accountant); `NUMBER_KINDS` + `"supplier_payment"`, `"expense"`.
  - `settings.ts`: numbering prefixes `supplierPaymentPrefix` (default "PV"), `expensePrefix` (default "EX"), and their starts. Prefixes must be unique (9 now).
  - `books.ts`: `SYSTEM` + `cheques_issued: ["2010","Cheques issued"]`; `MONEY_KINDS = ["cash","bank","card_clearing","cheques_in_hand"]`.
  - `schemas.ts` `supplierSchema`: `termsDays` (int 0–365, default 30), `openingBalanceFils` (int, default 0), `openingBalanceDate` (ymd | null).

- [ ] **Step 1: Write the failing tests** (`payables.test.ts`):
  - **`billTotals`:** net 10000 standard + 3333 standard + 2000 none → VAT 500 + 167 = 667, gross 15999 + 667 = 16000.
  - **Schemas refuse:** a transfer to the same account; a payment of 0; a bill with no lines.
  - **`parseStatement`, three layouts:**
    - `dd/mm/yyyy` with "1,234.50" amounts;
    - debit and credit columns (debit "50.00" → −5000);
    - `yyyy-mm-dd` with "(12.00)" → −1200.
    - A bad date gives "Row 3: …".
  - **Permissions and numbering:**
    - an accountant can `payables.manage`, an advisor can't;
    - the default prefixes are PV and EX;
    - `formatNumberOf("supplier_payment", 7)` = "PV-00007".
- [ ] **Step 2: Run** `npx vitest run packages/shared`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the above. Also update `NumberingSection` labels ("Supplier payments", "Expenses") and the settings-tiles test fixture for the new kinds.
- [ ] **Step 4: Run** `npx vitest run packages/shared`, then `npm run typecheck`. Expected: PASS. (The server suite goes green in Task 2, which adds the tables; as in Part 1, record that.)
- [ ] **Step 5: Commit** `feat(payables): schemas, statement parser, permissions, numbering`.

### Task 2: Tables, supplier ledger and money accounts

**Files:**
- Create: `packages/server/src/payables/{ledger,accounts}.ts`, `packages/server/test/payables-core.test.ts`
- Modify:
  - `packages/server/src/migrations.ts` (migration 12);
  - `packages/sync/src/tables.ts`;
  - `packages/server/src/numbering.ts` (table per new kind);
  - `packages/server/src/routes/parts.ts` (suppliers routes: the new fields, plus balance);
  - `packages/server/src/books/accounts.ts` (`money_kind` in and out);
  - `packages/server/src/books/rules.ts`: the opening balance posts like a customer's, Dr opening clearing / Cr payables (supplier), and is shown in the opening proposal like customers.

**Interfaces:**
- **Migration 12:**
  - Rebuild `journal_entries` (with `foreignKeysOff: ["journal_entries","journal_lines"]`), adding the source types `supplier_bill`, `bill_cancel`, `supplier_payment`, `supplier_opening`, `expense`, `transfer`, `cheque_deposit`, `cheque_clear`.
  - The tables listed in Architecture, each with an id, timestamps and `created_by`.
  - `accounts.money_kind`, set for the system money accounts. Insert 2010 Cheques issued.
  - `suppliers` + `terms_days`, `opening_balance_fils`, `opening_balance_date`.
  - All new tables join the sync list. `bank_lines.matched_line_id` is editable; the others are insert-only, except `supplier_bills.status` (posted | cancelled).
- **Produces in `payables/ledger.ts`:**
  - `supplierBalance(db, supplierId, asOf?) → { balanceFils /* we owe; negative = advance */, overdueFils, advanceFils }`;
  - `supplierOpenItems(db, supplierId) → { target: "bill"|"goods_receipt", id, number, dueDate, owedFils }[]`. A goods receipt is due on its invoice date + terms.
  - `supplierStatement(db, supplierId, from, to)`, shaped like `customerLedger`;
  - `payablesAging(db, asOf)`, with the customer aging's buckets.
- **Routes:** `GET /api/suppliers/:id` adds `balanceFils`, `overdueFils`, `advanceFils`. `GET /api/suppliers/:id/statement?from&to` and `GET /api/reports/payables-aging` need `payables.manage`.

- [ ] **Step 1: Write the failing tests** (`payables-core.test.ts`):
  - **migration 12 keeps old rows:** migrate to 11 with a journal entry, reopen. The entry survives and the new source types are accepted.
  - **A supplier's opening balance and goods receipts make its balance:** opening 1000.00, plus a goods receipt of 84.00 → balance 108400.
  - **Open items, oldest due first:** two goods receipts → open items with due dates = invoice date + terms.
  - **Statement:** it ties to the balance.
  - **An advisor gets 403** on statement and aging.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payables-core.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** it, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payables): tables, supplier ledger, money accounts`.

### Task 3: Bills and supplier payments

**Files:**
- Create: `packages/server/src/payables/{bills,payments}.ts`, `packages/server/src/routes/payables.ts`, `packages/server/test/payables-bills.test.ts`
- Modify: `packages/server/src/books/{rules,pending,reports}.ts` (new rules, and a `payables` health check: Σ supplier balances = the payables account)

**Interfaces:**
- **Bill routes:** `POST /api/bills` (posts on save), `GET /api/bills?supplierId&status`, `GET /api/bills/:id`, `POST /api/bills/:id/cancel { reason }`.
- **Payment routes:** `POST /api/supplier-payments` (allocations default oldest first), `GET /api/supplier-payments?supplierId`, `POST /api/supplier-payments/:id/allocations` (advance onto bills or goods receipts).
- All need `payables.manage`. Dates go through `checkNotLocked`.
- **Rules:**
  - `supplier_bill:<id>`: Dr each line's account (net), Dr vat_input / Cr payables (supplier) gross, dated the bill date.
  - `bill_cancel:<id>`: the mirror, dated the cancel date.
  - `supplier_payment:<id>`: Dr payables (supplier) / Cr the paid-from account, or cheques_issued for a cheque, dated the paid date.

- [ ] **Step 1: Write the failing tests:**
  - **bill posts net by account and VAT per line:** rent 10000 standard + fees 2000 none → Dr Rent 10000, Dr Bank charges 2000, Dr Input VAT 500 / Cr Payables 12500 (supplier).
  - **pay oldest first:** a goods receipt of 8400 due first and a bill of 12500. Paying 10000 by bank transfer gives allocations GR 8400 and bill 1600, Dr Payables 10000 / Cr Bank 10000, and a supplier balance of 10900.
  - **overpayment becomes an advance:** pay 25000 against 20900 owed → advance 4100, balance −4100. The `payables` health check is ok. Later, allocating the advance to a new bill brings it to 0.
  - **cancel only an unpaid bill:** a partly paid bill gives 409; an unpaid one gets a mirror entry and status cancelled, and its balance is gone.
  - **A locked date or one before the start date is refused** (bill date, payment date).
  - **An advisor gets 403.**
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payables-bills.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** it, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payables): supplier bills, payments, advances, payables health`.

### Task 4: Expenses, transfers and cheques

**Files:**
- Create: `packages/server/src/payables/{expenses,money}.ts`, `packages/server/test/payables-money.test.ts`
- Modify: `packages/server/src/routes/payables.ts`, `packages/server/src/books/rules.ts`

**Interfaces:**
- **Expenses:** `POST /api/expenses` (number EX-…), `GET /api/expenses?from&to`, `GET /api/expenses/:id/photo`.
- **Transfers:** `POST /api/transfers`.
- **Cheques received:** `GET /api/cheques/in-hand` (customer cheque receipts not yet deposited, with cheque date) and `POST /api/cheques/deposits`.
- **Cheques issued:** `GET /api/cheques/issued` (cheque supplier payments not yet cleared) and `POST /api/cheques/clearances`.
- **Money accounts:** `GET /api/money-accounts` lists the money accounts with their balance from the books.
- **Rules:**
  - `expense:<id>`: Dr account (net), Dr vat_input / Cr paid-from;
  - `transfer:<id>`: Dr to / Cr from;
  - `cheque_deposit:<id>`: Dr bank / Cr cheques_in_hand (per receipt);
  - `cheque_clear:<id>`: Dr cheques_issued / Cr the bank the payment came from.

- [ ] **Step 1: Write the failing tests:**
  - **expense with a photo:** fuel 100.00 + VAT, paid from cash → Dr Fuel 10000, Dr Input VAT 500 / Cr Cash 10500. The photo comes back. A 2 MB photo gives 400.
  - **transfer:** bank → cash 500.00 moves both balances in the money accounts list.
  - **customer cheque deposited:** a cheque receipt of 300.00 is listed in hand. Depositing it to the bank gives Dr Bank / Cr Cheques in hand, and it leaves the list. A second deposit gives 409. A post-dated cheque (cheque date tomorrow) gives 400 "not due until …".
  - **issued cheque: payable on payment, bank on clearing:**
    1. A supplier paid by cheque on day 1 → Cr Cheques issued; the bank balance is unchanged.
    2. Cleared on day 3 → Dr Cheques issued / Cr Bank, dated day 3.
    3. Clearing again gives 409.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payables-money.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** it, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payables): expenses with receipt photos, transfers, cheques in and out`.

### Task 5: Bank reconciliation

**Files:**
- Create: `packages/server/src/payables/reconcile.ts`, `packages/server/test/payables-reconcile.test.ts`
- Modify: `packages/server/src/routes/payables.ts`

**Interfaces:**
- **Importing:**
  - `PUT /api/money-accounts/:id/mapping` stores a `bankMappingSchema` value on the account (`accounts.bank_mapping` JSON column, added in migration 12).
  - `POST /api/money-accounts/:id/imports { fileName, csv }` parses the CSV with the saved mapping. It inserts the new `bank_lines` and skips duplicates by key. It returns `{ added, skipped }`.
- **Matching:**
  - `GET /api/money-accounts/:id/reconcile?to` → `{ lines: BankLine[] (unmatched first), suggestions: { bankLineId, journalLineId }[], bookBalanceFils, statementBalanceFils, unmatchedBookLines }`.
  - A suggestion has the same amount with the date within ±5 days. Each journal line is suggested only once.
  - `POST /api/bank-lines/:id/match { journalLineId }` and `POST /api/bank-lines/:id/unmatch`.
  - `POST /api/bank-lines/:id/expense { accountId, vat, description }` creates an expense paid from this account (for bank charges and fees) and matches it.

- [ ] **Step 1: Write the failing tests:**
  - **import parses layouts and skips duplicates:** a debit/credit, `dd/mm/yyyy` statement with "1,234.50" → 3 lines added. The same file again → 0 added, 3 skipped.
  - **suggest, match, reconcile:**
    1. A supplier payment by bank transfer of 1,234.50 and a statement line of −1,234.50 two days later → a suggestion.
    2. Matching it leaves the unmatched count at 0.
    3. A bank charge line of −15.75 → "expense" posts Dr Bank charges / Cr Bank and matches it.
    4. The book balance and the statement balance are equal.
  - **A journal line can't be matched to two bank lines** (409). Unmatching frees it.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/payables-reconcile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** it, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(payables): bank statement import and reconciliation`.

### Task 6: Screens, e2e and docs

**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/payables/{BillsPage,BillEditor,PaySupplierDialog,ExpensesPage,MoneyPage,MoneyAccountPage,ReconcilePage,PayablesAgingPage}.tsx`
  - `apps/desktop/test/payables.spec.ts`
  - `playwright.payables.config.ts`
- Modify:
  - nav: a "Payables" group shown with `payables.manage`, holding Bills, Expenses, Bank & cash, and Payables aging;
  - `App.tsx` routes;
  - `pages/SuppliersPage.tsx`: the supplier page gets balance, advance, statement (print, PDF, Excel) and "Pay supplier";
  - the customer Receipts page: "Deposit cheques";
  - the Books home cards: Bank & cash, Payables aging;
  - root `package.json` (`e2e:payables`);
  - `README.md` (a "Suppliers, expenses and bank (Accounting Part 2)" section).

- [ ] **Step 1: Write the failing e2e** (`payables.spec.ts`): **from a supplier bill to a reconciled bank.**
  1. Start the books today.
  2. Enter a rent bill of 1,000.00 + VAT from "Al Quoz Properties". The supplier balance is 1,050.00.
  3. Pay it by bank transfer. The balance is 0.
  4. Record a fuel expense of 50.00 + VAT from cash, with a photo.
  5. Upload a statement CSV (debit/credit columns) holding −1,050.00 and −15.75 bank charges. Map the columns once.
  6. Accept the suggested match, and add the 15.75 as a bank charge. The page shows "Reconciled".
  7. The trial balance totals are equal, and Books health is all OK, payables included.
- [ ] **Step 2: Run** `npm run e2e:payables`. Expected: FAIL.
- [ ] **Step 3: Implement** the screens following the Part 1 Books patterns (`ReportPage`, `JournalEditor`, `Table`, `Modal`, `exportXlsx`/`exportPdf`).
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, then every e2e suite: `e2e`, `e2e:settings`, `e2e:credit`, `e2e:messages`, `e2e:books`, `e2e:payables`, `e2e:electron` (after `npm run build -w @ffgp/desktop`), `e2e:cloud`, `e2e:sync`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(payables): bills, payments, expenses, bank and reconciliation screens`.

## After merge (not a task)
Merge Part 1 and Part 2 together (Part 2's branch contains Part 1). Deploy the cloud first (migrations 11 and 12), then push `main`.
