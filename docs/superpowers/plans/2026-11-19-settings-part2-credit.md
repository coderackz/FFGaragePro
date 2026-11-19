# Settings Part 2 (Credit customers and credit notes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit customers (terms, limits, LPO, opening balance), receipts allocated across invoices with customer credit and refunds, tax credit notes, statements of account and an aging report, all syncing between PCs and the cloud.

**Architecture:** Money stays derived from rows: an invoice's `paid_fils` is the sum of its receipt allocations and its new `credited_fils` the sum of its issued credit notes, recalculated on every side by one server function that sync also calls. Receipts and allocations are insert-only (a wrong allocation is undone by a negative one); a credit note is a `credit_note` document created and issued in one step from an issued invoice. Customer balance, statement and aging come from one ledger function.

**Tech Stack:** TypeScript, Zod 4, Fastify 5, `node:sqlite`, React 19, Electron 45, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-settings-design.md` — Goals D and E, "Ready for the insurance add-on", "Part 2 decisions".

## Global Constraints
- Money is integer fils; VAT 5%. Balances, statements and aging must agree to the fil.
- An issued invoice or credit note is never edited or deleted; receipts and allocations are only ever added.
- No two documents share a number; numbers never go backwards (credit notes "CN", receipts "RCT", same series rules as invoices: the cloud's main series online, the PC's own offline).
- Nothing may assume one invoice per job card or that an invoice's customer is the job card's customer (insurance add-on later).
- Permissions: `credit_notes.issue` (Owner, Accountant), `credit.override` (Owner), `payments.record` covers receipts and allocations; Advisors see balance and "over limit" but not aging (`reports.view`).
- Cash customers (credit not allowed): due on the issue date. Credit limit 0 = no limit.
- English only on statements (Arabic is Part 3). Copy is plain English for garage staff.
- Never edit migrations 1–7; this plan adds migration 8.

## Review Focus
1. Two PCs allocate to the same invoice offline (or both receive a payment for it): after sync both sides show the same invoice paid amount, status and customer balance; an over-allocated invoice shows as paid and the excess is not lost from the balance — test in Task 2.
2. Two credit notes for the same invoice line that together exceed it: the second is refused on one PC ("Only 1 left to credit on line 2"); arriving by sync, both stand and both sides still agree — tests in Tasks 2 and 6.
3. A garage upgraded with existing payments: every invoice keeps its paid amount and status, receipts are numbered RCT-00001… in payment order, and a PC and the cloud migrating separately end up with identical rows — test in Task 2.
4. Bad money input: zero receipt, allocation larger than the receipt or than the invoice owes, refund larger than the customer's credit, allocating to a draft invoice or another customer's invoice — all refused with a plain message, nothing written — test in Task 5.
5. A statement for a range: its opening balance includes the customer's opening balance and everything before the start date, and its closing balance equals the customer's balance at the end date — test in Task 3.

---

### Task 1: Shared rules — kinds, schemas, settings, money helpers

**Files:**
- Modify: `packages/shared/src/rules.ts`, `packages/shared/src/schemas.ts`, `packages/shared/src/settings.ts`, `packages/shared/src/money.ts`
- Create: `packages/shared/src/credit.ts` (export from `index.ts`)
- Test: `packages/shared/test/credit.test.ts`, `packages/shared/test/rules.test.ts`, `packages/shared/test/settings.test.ts`

**Interfaces:**
- Produces:
  - rules.ts: `DOC_TYPES` gains `"credit_note"` (PREFIX "CN", `DOC_LABELS` "Credit Note", `DOC_STATUSES.credit_note = ["issued"]`, not in `CONVERTS_TO`); `NUMBER_KINDS` gains `"credit_note"`, `"receipt"`; `formatReceiptNumber(n, series = "", prefix = "RCT")`; actions `"credit_notes.issue"` (Owner, Accountant), `"credit.override"` (Owner).
  - settings.ts: numbering gains `creditNotePrefix` "CN", `receiptPrefix` "RCT", `creditNoteStart`, `receiptStart` (all six prefixes must differ); `prefixOf`/`startOf` cover the new kinds; new section `credit`: `defaultTermsDays` (int 0–365, default 30), `overLimit` (`"warn"|"block"|"approve"`, default `"warn"`). `SETTINGS_SECTIONS` gains `"credit"`.
  - schemas.ts: `customerSchema` gains `creditAllowed` (default false), `creditLimitFils` (money, default 0), `termsDays` (int 0–365 | null = settings default), `discountPct` (0–100, default 0), `lpoRequired` (default false), `openingBalanceFils` (int, may be negative, default 0), `openingBalanceDate` (`YYYY-MM-DD` | null). `receiptSchema` `{ customerId, amountFils (int ≠ 0, "Amount can't be zero"), method (PAYMENT_METHODS), reference, chequeDate (YYYY-MM-DD|null), receivedAt?, allocations?: { documentId, amountFils (int > 0) }[] }` (absent = oldest first). `allocationSchema { allocations: { documentId, amountFils (int ≠ 0) }[] (min 1) }`. `creditNoteSchema { reason (text 3–500, "Give a reason"), lines?: { lineId, qty (> 0) }[] (absent = everything still uncredited), returnToStock (default true) }`. `issueSchema { lpoNumber?, approval? }`. `documentUpdateSchema` gains `lpoNumber`.
  - credit.ts (pure):
    - `owedFils(d: { grossFils: number; creditedFils: number; paidFils: number }): number` = gross − credited − paid.
    - `invoiceStatus(d): "issued" | "part_paid" | "paid"` — paid when owed ≤ 0 and gross > 0; part_paid when paid + credited > 0; else issued.
    - `allocateOldestFirst(amountFils: number, invoices: { id: string; dueDate: string; issuedAt: string; owedFils: number }[]): { documentId: string; amountFils: number }[]` — by due date, then issue date; never more than each owes; stops when the amount runs out.
    - `dueDate(issuedAt: string, termsDays: number, creditAllowed: boolean): string` — `YYYY-MM-DD`, Dubai date (UTC+4) of issue + terms; cash customers same day.
    - `AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const`; `agingBucket(dueDate: string, asOf: string): AgingBucket` (days past due ≤ 0 → current).

- [ ] **Step 1: Write the failing tests** — credit.test.ts:
  - `owedFils({grossFils:10500, creditedFils:500, paidFils:4000}) === 6000`; `invoiceStatus` of that → `"part_paid"`; with paid 10000 → `"paid"`; nothing paid/credited → `"issued"`; credited fully (credited 10500, paid 0) → `"paid"`.
  - `allocateOldestFirst(15000, [B due 2026-11-10 owes 10000, A due 2026-11-01 owes 8000, C due 2026-11-20 owes 5000])` → `[{A,8000},{B,7000}]`; amount larger than all owed → each fully, total 23000.
  - `dueDate("2026-11-19T21:30:00.000Z", 30, true) === "2026-12-20"` (Dubai date is 20 Nov); `dueDate(x, 30, false)` → same Dubai day `"2026-11-20"`.
  - `agingBucket("2026-11-01","2026-11-01") === "current"`, `("2026-10-01","2026-11-01") === "31-60"`, `("2026-07-01","2026-11-01") === "90+"`.
  - rules: `formatDocNumber("credit_note", 7) === "CN-00007"`; `formatReceiptNumber(3, "P1") === "RCT-P1-00003"`; `can("accountant","credit_notes.issue")` true, `can("advisor","credit_notes.issue")` false, `can("accountant","credit.override")` false.
  - settings: defaults `credit.defaultTermsDays === 30`, `credit.overLimit === "warn"`, `numbering.receiptPrefix === "RCT"`; `receiptPrefix: "INV"` throws "Each document type needs its own prefix".
  - schemas: `receiptSchema` rejects `amountFils: 0` with "Amount can't be zero"; `creditNoteSchema` rejects `reason: ""` with "Give a reason".
- [ ] **Step 2: Run** `npx vitest run packages/shared` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npx vitest run packages/shared && npm run typecheck` — Expected: PASS (fix type fallout from the wider `DocType` with explicit cases, not casts).
- [ ] **Step 5: Commit** `git commit -m "shared: credit customers, receipts, credit notes — rules, schemas, settings, money helpers"`

---

### Task 2: Migration 8 and sync for receipts, allocations and credit notes

**Files:**
- Modify: `packages/server/src/migrations.ts`, `packages/sync/src/tables.ts`, `packages/sync/src/apply.ts`, `packages/sync/src/recompute.ts`, `apps/cloud/src/sync-routes.ts` (numbers enum), `packages/server/src/numbering.ts` (receipts table for `receipt` kind)
- Create: `packages/server/src/invoice-money.ts`
- Test: `packages/server/test/migration8.test.ts`, `packages/sync/test/apply.test.ts`

**Interfaces:**
- Migration 8 (`foreignKeysOff` like migration 5, checking `documents`, `document_lines`, `stock_movements`, `document_prints`, `receipt_allocations`, `payments`):
  - `customers` + `credit_allowed INTEGER NOT NULL DEFAULT 0`, `credit_limit_fils INTEGER NOT NULL DEFAULT 0`, `terms_days INTEGER`, `discount_bp INTEGER NOT NULL DEFAULT 0`, `lpo_required INTEGER NOT NULL DEFAULT 0`, `opening_balance_fils INTEGER NOT NULL DEFAULT 0`, `opening_balance_date TEXT`.
  - `documents` rebuilt: `type` CHECK adds `'credit_note'`; new `due_date TEXT`, `lpo_number TEXT`, `reason TEXT`, `credited_fils INTEGER NOT NULL DEFAULT 0`; rows copied unchanged; indexes recreated; `documents_one_conversion` becomes `ON documents(source_id) WHERE source_id IS NOT NULL AND type <> 'credit_note'`; issued invoices get `due_date` = Dubai date of `issued_at`.
  - `document_lines` + `source_line_id TEXT` (a credit note line → the invoice line it credits).
  - `receipts (id PK, series TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL, number TEXT NOT NULL, customer_id NOT NULL REFERENCES customers, amount_fils INTEGER NOT NULL CHECK (amount_fils <> 0), method TEXT NOT NULL, reference TEXT, cheque_date TEXT, received_at TEXT NOT NULL, created_by REFERENCES users, created_at TEXT NOT NULL, UNIQUE(series, seq))`; `receipt_allocations (id PK, receipt_id NOT NULL REFERENCES receipts, document_id NOT NULL REFERENCES documents, amount_fils INTEGER NOT NULL CHECK (amount_fils <> 0), created_by, created_at)`; indexes on customer, receipt, document.
  - Existing payments → one receipt each (`id` = payment id, `seq` by `paid_at, id`, `number` `RCT-00001`…, customer = the invoice's) + one allocation (`id` = payment id || `'-a'`); `counters('receipt')` = count + 1. Deterministic, so separate migrations on a PC and the cloud give identical rows.
- tables.ts: `payments` leaves `SYNC_TABLES` (read-only from now on); add `{ receipts, key "id", insertOnly }`, `{ receipt_allocations, key "id", insertOnly }` after `documents`; `documents.derived` adds `"credited_fils"`.
- `recomputeInvoiceMoney(db: Db, docId: string): void` (server, `invoice-money.ts`): for an invoice, `paid_fils` = Σ allocations, `credited_fils` = Σ gross of its issued credit notes, status by `invoiceStatus` (drafts untouched). Sync's `recomputeDocument` calls it instead of reading `payments`.
- apply.ts: `isFrozen` = issued invoice **or** credit note; `touch` maps `receipt_allocations.document_id` and a credit note's `source_id` to `docs`; `TABLE_LABELS` gains receipts, receipt allocations, document prints, activity log.
- cloud `/api/cloud/sync/numbers` kind enum = `NUMBER_KINDS`.

- [ ] **Step 1: Write the failing tests:**
  - migration8.test.ts `"existing payments become receipts, nothing changes on the invoices"`: build a database at migration 7 (`new Db(file, { migrateTo: 7 })`) with two invoices and three payments (one invoice fully paid), then migrate → `receipts` has 3 rows numbered RCT-00001..3 in `paid_at` order with ids = payment ids; allocations ids = id+"-a"; every invoice's `paid_fils` and `status` unchanged; `credited_fils` 0; issued invoices have a `due_date`.
  - `"two separate migrations give identical rows"`: copy the migration-7 file twice, migrate both, `SELECT * FROM receipts` / allocations equal.
  - `"a second invoice from the same job card is allowed; a second conversion of an estimate is not"`: insert two documents with the same `source_id` where one is `credit_note` → OK; two non-credit-note → unique error.
  - apply.test.ts `"allocations made on two PCs to the same invoice add up on both sides"` (Review Focus 1): invoice 10500; PC A allocates 6000, PC B 6000 offline; after both sync and pull, cloud and both PCs show `paid_fils` 12000, status `paid`, identical customer balance (−1500).
  - apply.test.ts `"two credit notes over the same line both stand after sync"` (Review Focus 2): rows arriving from two PCs → both applied, invoice `credited_fils` = their sum on both sides.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/migration8.test.ts packages/sync/test/apply.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS (existing payment tests now go through Task 5's route in the next task; until then `POST /api/documents/:id/payments` writes a receipt + allocation — do that here so the suite stays green).
- [ ] **Step 5: Commit** `git commit -m "server: migration 8 (credit fields, receipts, allocations, credit notes); sync recalculates invoice money from allocations"`

---

### Task 3: Customer credit fields, balance, statement and aging

**Files:**
- Create: `packages/server/src/ledger.ts`, `packages/server/src/routes/reports.ts`
- Modify: `packages/server/src/routes/customers.ts`, `packages/server/src/app.ts`
- Test: `packages/server/test/ledger.test.ts`

**Interfaces:**
- `customerBalance(db, customerId, asOf?: string /* YYYY-MM-DD, inclusive, Dubai */): { balanceFils: number; overdueFils: number; creditFils: number }` — balance = opening + issued invoices − issued credit notes − receipts (all dated ≤ asOf); overdue = Σ positive owed of invoices past due; credit = Σ receipts − Σ allocations (unallocated).
- `customerLedger(db, customerId, from: string, to: string): { openingFils: number; rows: { date, kind: "invoice"|"credit_note"|"receipt"|"opening", number, description, debitFils, creditFils, balanceFils }[]; closingFils: number; aging: Record<AgingBucket, number> }` — rows by date then number; closing = `customerBalance(…, to).balanceFils`.
- `agingReport(db, asOf: string): { customers: { id, name, buckets: Record<AgingBucket, number>, totalFils, creditFils }[]; totals: Record<AgingBucket, number> }` — only customers owing or in credit.
- Customer API: `GET/POST/PATCH /api/customers` carry the credit fields (`customerOut` adds them); `GET /api/customers/:id` and the list add `balanceFils`, `overdueFils`, `creditFils`, `overLimit` (credit limit > 0 and balance > limit); `GET /api/customers/:id/statement?from&to` (any signed-in user); `GET /api/reports/aging?asOf` (`reports.view`).
- [ ] **Step 1: Write the failing tests** — ledger.test.ts:
  - `"balance = opening + invoices − credit notes − receipts"`: opening 5000 (2026-10-01), invoice 10500 issued, receipt 8000 allocated to it → balance 7500, credit 0; an unallocated receipt 1000 → balance 6500, credit 1000.
  - `"statement ties to the balance"` (Review Focus 5): with the above spread over Oct and Nov, statement 2026-11-01..2026-11-30 → `openingFils` = opening + October's rows, last row's `balanceFils` = `closingFils` = `customerBalance(…,"2026-11-30").balanceFils`.
  - `"aging puts each invoice in its bucket by days past due"`: invoices due 10, 40, 100 days ago and one not yet due → buckets 1-30, 31-60, 90+, current; totals add up.
  - `"customer API shows credit fields and balance; advisors can't see aging"`: PATCH `{creditAllowed:true, creditLimitFils:500000, termsDays:30}` → GET shows them plus `balanceFils`; advisor GET `/api/reports/aging` → 403.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/ledger.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "server: customer credit fields, balance, statement and aging"`

---

### Task 4: Invoices — due date, LPO, credit limit

**Files:**
- Modify: `packages/server/src/routes/documents.ts`
- Test: `packages/server/test/invoice-credit.test.ts`

**Interfaces:**
- `POST /api/documents/:id/issue` body `issueSchema`: sets `lpo_number` when given, `due_date` = `dueDate(issued_at, customer.terms_days ?? settings.credit.defaultTermsDays, customer.credit_allowed)`. Refuses: customer `lpo_required` and no LPO → 400 "This customer needs an LPO number on the invoice"; over the limit (limit > 0 and balance + this invoice's gross > limit) → by `settings.credit.overLimit`: `warn` → issues, response has `warning: "Over the credit limit by AED x"`; `block` → 409 code `over_limit` "Over the credit limit by AED x"; `approve` → 403 code `credit_approval` unless a valid Owner `approval` (same check and lockout as discounts; logged as `credit.override` in the activity log — add `"credit.override"` to `AuditAction` and `describeAudit`: "Approved going over the credit limit on INV-00012").
- Job card creation runs the same limit check on its gross (before taking a number, as in Part 1's fixes).
- `PATCH /api/documents/:id` accepts `lpoNumber` while editable; `full()` returns `dueDate`, `lpoNumber`, `creditedFils`, `owedFils`, `customerBalance`.
- [ ] **Step 1: Write the failing tests:** cash customer → `dueDate` = issue's Dubai date; credit customer terms 45 → +45 days; no terms → settings default 30; LPO required without LPO → 400 message; limit 10000 with balance 8000, invoice 5250: `warn` → 200 + warning "Over the credit limit by AED 32.50", `block` → 409 `over_limit`, `approve` → 403 `credit_approval`, with Owner approval → 200 and an activity-log entry; limit 0 → never checked.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/invoice-credit.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "invoices: due dates, LPO numbers, credit limit (warn / block / Owner approval)"`

---

### Task 5: Receipts and allocations

**Files:**
- Create: `packages/server/src/routes/receipts.ts`
- Modify: `packages/server/src/routes/documents.ts` (old payments route → receipt), `packages/server/src/app.ts`, `apps/desktop/src/renderer/lib/permissions.ts` if needed
- Test: `packages/server/test/receipts.test.ts`

**Interfaces:**
- `POST /api/receipts` (`payments.record`), body `receiptSchema`: number via `reserveNumber(numbers, "receipt")` before the transaction (validation first, as in Part 1); allocations default to `allocateOldestFirst` over the customer's issued invoices with owed > 0; given allocations must each be > 0, to that customer's issued invoices, ≤ what each owes, and sum ≤ amount. A negative amount (refund): no allocations, ≤ the customer's credit ("The refund is more than the customer's credit of AED x"). Recalculates each touched invoice (`recomputeInvoiceMoney`). Logs `receipt.create` (number, customer, amount, allocations) in the activity log. → `{ receipt }` with its allocations.
- `POST /api/receipts/:id/allocations` (`payments.record`), body `allocationSchema`: positive ones from the receipt's unallocated amount; negative ones undo (never below zero for that receipt+invoice). Logs `receipt.allocate`. → `{ receipt }`.
- `AuditAction` gains `receipt.create`, `receipt.allocate`, `credit_note.issue`, `credit.override`; `describeAudit` (Task 8) words them: "Received RCT-00004 from Emirates Logistics: AED 300.00", "Allocated AED 21.00 of RCT-00004 to INV-00007", "Issued CN-00001 against INV-00012: Wrong part".
- `GET /api/receipts?customerId&q` and `GET /api/receipts/:id` (signed-in).
- `POST /api/documents/:id/payments` keeps working for the invoice screen: one receipt allocated wholly to that invoice.
- [ ] **Step 1: Write the failing tests** — receipts.test.ts:
  - `"one transfer across three invoices, oldest first"`: invoices 10500 (due earliest), 21000, 5250; receipt 30000 → allocations 10500, 19500; statuses paid, part_paid, issued; number RCT-00001.
  - `"what isn't allocated is the customer's credit, and can be allocated later"`: receipt 40000 over 36750 owed → credit 3250; a new invoice 2100; `POST /allocations` 2100 → paid; credit 1150.
  - `"bad amounts are refused, nothing written"` (Review Focus 4): amount 0; allocation > receipt; allocation > owed; to a draft invoice; to another customer's invoice; refund 5000 with credit 1150 → each 400 with its message; `receipts` count unchanged.
  - `"a refund pays out credit"`: refund −1150 → credit 0, balance up by 1150.
  - `"the invoice screen's Record payment still works"`: `POST /api/documents/:id/payments {amountFils:5000, method:"card"}` → invoice part_paid, one receipt + allocation.
  - `"a refused receipt takes no number"`: linked numbers source counting calls; invalid allocation → 400, counter unchanged.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/receipts.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (update older payment tests only where they read the `payments` table directly).
- [ ] **Step 5: Commit** `git commit -m "receipts: one payment across several invoices, customer credit, refunds"`

---

### Task 6: Credit notes

**Files:**
- Modify: `packages/server/src/routes/documents.ts`, `packages/server/src/stock.ts`
- Test: `packages/server/test/credit-notes.test.ts`

**Interfaces:**
- `POST /api/documents/:id/credit-notes` (`credit_notes.issue`), body `creditNoteSchema`: the source must be an issued invoice; lines = chosen invoice lines and quantities (or everything still uncredited), each ≤ the line's quantity minus what earlier credit notes took (`source_line_id`): else 400 "Only {n} left to credit on line {position+1}". Number via `reserveNumber(numbers, "credit_note")` after validation. Creates a `credit_note` document — same customer and vehicle, `source_id` = invoice, `reason`, `prices_include_vat` copied, lines copied (price, discount; qty as chosen; `source_line_id`), `status "issued"`, `issued_at` now — then recalculates the invoice and logs `credit_note.issue` (number, invoice, reason, amount). If the invoice's allocations now exceed gross − credited, inserts negative allocations (newest receipts first) for the excess, so it becomes the customer's credit. `returnToStock`: for stocked, garage-supplied part lines, `postMovement` +qty, reason `"adjust"`, `document_id` = credit note, note "Returned on CN-00001", cost = the cost the part left at on that invoice's chain (else the current average). → `{ document }` (the credit note).
- `reconcileDocumentStock` returns early for `credit_note` (its movements are its own).
- `full()` of an invoice adds `creditNotes: {id, number, grossFils}[]`; of a credit note `source` is the invoice and `reason` is shown.
- [ ] **Step 1: Write the failing tests:**
  - `"credit part of an invoice"`: invoice with lines A (2 × 5000) and B labour → credit 1 of A, reason "Wrong part" → CN-00001, gross 5250; invoice `creditedFils` 5250, `owedFils` gross − 5250; status part_paid.
  - `"can't credit more than is left"` (Review Focus 2): second credit note for 2 of A → 400 "Only 1 left to credit on line 1".
  - `"crediting a paid invoice gives the customer credit"`: invoice fully paid by a receipt → full credit note → invoice paid (owed 0), a negative allocation exists, customer `creditFils` = invoice gross, balance −gross.
  - `"returned parts go back on the shelf"`: stocked part sold 2 → credit 2 with return → on_hand back; `returnToStock:false` → unchanged.
  - `"only issued invoices, only Owner and Accountant"`: draft invoice → 400; advisor → 403; credit note can't be edited (PATCH → 409) or converted.
  - `"a refused credit note takes no number"`.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/credit-notes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "credit notes: correct an issued invoice, customer credit, parts back to stock"`

---

### Task 7: Printing — credit notes, receipts, statements

**Files:**
- Modify: `apps/desktop/src/renderer/print/templates.ts`, `apps/desktop/src/renderer/print/print.ts`, `apps/desktop/src/renderer/print/sample.ts`, `apps/desktop/src/renderer/lib/types.ts`
- Test: `apps/desktop/test/templates.test.ts`

**Interfaces:**
- `renderDocumentHtml` handles `credit_note`: title "TAX CREDIT NOTE / إشعار دائن ضريبي", "Credit for {invoice number} of {invoice date}", "Reason: …", totals labelled "Total credit"; invoices print "Due date" and "LPO" in the title block when set, and "Credited" / "Balance due" rows when credited.
- `renderReceiptHtml(receipt, garage, settings): string` — RCT number, date, customer, amount in AED, method, reference/cheque date, "Allocated to" table (invoice, amount), "Kept as credit" line when unallocated, signature cell.
- `renderStatementHtml(statement, customer, garage, settings, range): string` — opening balance, rows with running balance, closing balance, aging summary, bank details footer.
- `printReceipt`, `printStatement` in print.ts (same `printHtml` path).
- [ ] **Step 1: Write the failing tests:** credit note HTML contains "TAX CREDIT NOTE", the invoice number and the reason; invoice with due date and LPO shows both; receipt HTML shows "Allocated to" rows and "Kept as credit: AED 32.50"; statement HTML shows opening and closing balances and the five aging labels.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/templates.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npx vitest run apps/desktop/test/templates.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "printing: credit notes, receipts and statements of account"`

---

### Task 8: Screens — customers, receipts, credit notes, aging, settings

**Files:**
- Modify: `apps/desktop/src/renderer/components/forms.tsx` (customer form), `apps/desktop/src/renderer/pages/CustomerPage.tsx`, `apps/desktop/src/renderer/pages/DocumentPage.tsx`, `apps/desktop/src/renderer/components/CustomerPicker.tsx`, `apps/desktop/src/renderer/components/Layout.tsx`, `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/pages/settings/tiles.ts`, `apps/desktop/src/renderer/pages/settings/SettingsSectionPage.tsx`, `apps/desktop/src/renderer/pages/settings/sections/NumberingSection.tsx`, `apps/desktop/src/renderer/pages/settings/describe.ts`
- Create: `apps/desktop/src/renderer/pages/ReceiptsPage.tsx`, `apps/desktop/src/renderer/pages/AgingPage.tsx`, `apps/desktop/src/renderer/components/ReceivePaymentDialog.tsx` (`ReceiveDialog.tsx` is already the goods-receiving dialog), `apps/desktop/src/renderer/components/CreditNoteDialog.tsx`, `apps/desktop/src/renderer/pages/settings/sections/CreditSection.tsx`
- Test: `apps/desktop/test/settings-tiles.test.ts`, `apps/desktop/test/describe.test.ts`

**Interfaces:**
- Customer form: "Credit" block — credit allowed, limit, terms (blank = default), discount %, LPO required, opening balance and date.
- Customer page: balance card (balance, overdue, credit, "Over the limit" badge), Statement (from/to, Print, PDF), Receipts list, "Receive payment" (`ReceivePaymentDialog`: amount, method, reference, cheque date, allocation table pre-filled oldest first and editable, "Kept as credit" line, Print receipt after save), "Allocate credit" when credit > 0, "Refund" when credit > 0.
- Invoice page: LPO field (draft), due date shown, issue handles `warning` (toast), `over_limit` (message), `credit_approval` (the Part 1 Owner approval dialog, generalised to any `*_approval` code); "Record payment" posts a receipt; "Credit note" button (issued invoices, `credit_notes.issue`) opens `CreditNoteDialog` (lines with quantity to credit, reason, return to stock) and lands on the new credit note; a credit note opens read-only with its reason and source.
- Customer picker and document editor show the customer's balance and an "Over the limit" badge; new lines on a customer with a standing discount start at that discount % (over a role's limit it goes through the Owner approval like any discount).
- Menu: new "Money" group — Receipts (`/receipts`), Credit notes (`/credit-notes`, `DocumentsPage type="credit_note"`), Aging (`/reports/aging`, `reports.view`).
- Settings: "Customers & credit" tile live (status "Terms 30 days · warn over limit"), `CreditSection`; Numbering lists credit notes and receipts; `describeAudit` covers `credit.override`.
- [ ] **Step 1: Write the failing tests:** `settings-tiles.test.ts` — customers-credit tile no longer `coming`, status "Terms 30 days · warn over limit"; `describe.test.ts` — "Approved going over the credit limit on INV-00012", "Received RCT-00004 from Emirates Logistics: AED 300.00", "Issued CN-00001 against INV-00012: Wrong part".
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/settings-tiles.test.ts apps/desktop/test/describe.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; check the screens with a throwaway screenshot script (as in Part 1) at 1440 and 800 px.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run e2e && npm run e2e:settings` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "screens: credit customers, receive payment, statements, credit notes, aging, settings"`

---

### Task 9: End-to-end and sync checks

**Files:**
- Create: `apps/desktop/test/credit.spec.ts` + `playwright.credit.config.ts` + root script `e2e:credit`
- Modify: `apps/desktop/test/cloud-sync.spec.ts`, `README.md`

- [ ] **Step 1: Write the e2e:**
  - credit.spec.ts `"credit customer: three invoices, one transfer, statement at zero"`: set a company customer to credit 30 days, limit AED 1,000; issue three invoices (third shows the over-limit warning); Receive payment of their total → allocations pre-filled oldest first; statement for the month ends at AED 0.00; aging shows nothing owed.
  - `"credit note on a paid invoice becomes customer credit"`: credit note with reason → CN-00001 opens; customer page shows credit; Refund it → credit 0.
  - cloud-sync.spec.ts: a receipt made on the PC appears in the browser's customer balance after Sync now.
- [ ] **Step 2: Run** `npm run e2e:credit && npm run e2e:sync` — Expected: PASS.
- [ ] **Step 3: Run** `npm test && npm run e2e && npm run e2e:settings && npm run e2e:electron && npm run e2e:cloud` — Expected: PASS.
- [ ] **Step 4:** README: credit customers, receipts, credit notes, statements, aging; `e2e:credit`.
- [ ] **Step 5: Commit** `git commit -m "e2e: credit customers, receipts, credit notes; README"`
