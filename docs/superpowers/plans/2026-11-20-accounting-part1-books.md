# Accounting Part 1 — The books — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The garage's real double-entry books. A chart of accounts. Automatic journal entries from invoices, credit notes, receipts, goods receipts and stock. Manual journals and reversals, opening balances, locking and year end. Trial balance, profit and loss, balance sheet and general ledger with Excel and PDF export. A "books health" panel that proves the books agree with the workshop.

**Architecture:**
- Migration 11 adds `accounts` (seeded default chart with fixed ids), insert-only `journal_entries` and `journal_lines`, and editable `journal_drafts`.
- **One place posts.** `postPending(db)` is an idempotent catch-up. It posts every source event that has no entry yet, keyed by a unique `post_key`, each in its own transaction. It runs only where the garage's data is decided:
  - the cloud's garage apps;
  - a standalone PC or main computer (`AppOptions.postsBooks`).
  - Linked PCs receive entries by sync.
- Reports read the entries. Screens live in a new "Books" area and a "Books" Settings tile.

**Tech Stack:** TypeScript, Zod 4, node:sqlite, Fastify, React 19, Vitest, Playwright. New dependency: `write-excel-file@4.1.1` (renderer, Excel export; devDependency, bundled by Vite).

**Spec:** `docs/superpowers/specs/2026-11-19-accounting-design.md` (Goals Part 1, the posting table, "Decisions after the builder check" 1–4, Constraints, Anti-goals).

## Global Constraints
- Money in integer fils. Every entry's debits equal its credits, enforced in `postEntry`, which throws otherwise.
- Never edit or delete a posted entry. Corrections are reversals. Only `journal_drafts` are editable.
- **Only the posting place posts:** the cloud for linked garages, otherwise the main computer or single PC. A linked PC creates drafts only.
- An automatic entry carries the event's own Dubai date (`dubaiDate`). An event dated on or before the lock date posts on the day after the lock date, keeping `original_date`, with the narration ending " (dated DD Mon YYYY; books locked)".
- Events dated before `books.startDate` are never posted: they belong to the opening balances. No start date: nothing posts.
- Opening items dated on or after the start date post against **Opening balance clearing**. These are customer opening balances and `opening` stock movements.
- Parts fitted on a job post to **Work in progress**, with the job card's id on the WIP line. Issuing the invoice moves that job's WIP balance to **Cost of parts sold**.
- "Supplied by Fleet Fix" lines post nothing. Discounts stay inside line nets.
- New actions:
  - `books.view` and `books.post`: Owner and Accountant;
  - `books.lock`: Owner.
  - Advisors see nothing of the books.
- Journal numbers: `NUMBER_KINDS` gains `"journal"` (prefix `JV`).
- Never edit migrations 1–10. Update the cloud before the PCs.

## Review Focus
1. **The same event posted twice:** postPending run twice, run concurrently from two requests, or after a sync. Every event has exactly one entry. → Task 3 test `postPending is idempotent`.
2. **A credit note for part of an invoice, with discounted lines:** the entry balances to the fil, and its VAT equals the document's. → Task 3 test `credit note reverses by line kind`.
3. **Refunds and cheques:** a negative receipt posts Dr Receivables / Cr cash, and a cheque payment goes to Cheques in hand. → Task 3 test `receipts post by method; refunds reverse`.
4. **Dates around the start and lock dates:** an event before the start date isn't posted; one dated in a locked period posts on the first open day with its original date. → Task 3 test `dates: before start never, locked → first open day`.
5. **A linked PC:** posts nothing itself, and gets the cloud's entries by sync. → Task 3 test `linked PC never posts; cloud entries arrive by sync`.

---

### Task 1: Shared — chart, books settings, journal schema, permissions

**Files:**
- Create: `packages/shared/src/books.ts`, `packages/shared/test/books.test.ts`
- Modify: `packages/shared/src/{index,settings,rules}.ts`, `packages/shared/test/settings.test.ts`

**Interfaces:**
- **Produces the account model:**
  - `ACCOUNT_TYPES = ["asset","liability","equity","income","cost_of_sales","expense"]` and `type AccountType`;
  - `SYSTEM_ACCOUNTS: Record<SystemKey, { id: string; code: string; name: string; type: AccountType }>`;
  - `DEFAULT_CHART` (the system accounts plus the others below, each with a fixed id `00000000-0000-4000-8000-0000000a<code>`);
  - `accountSchema` (code `^\d{4}$`, name 1–80, type).
- **System keys and codes:**

  | Key | Code | Name |
  |---|---|---|
  | `cash` | 1000 | Cash on hand |
  | `card_clearing` | 1010 | Card receipts clearing |
  | `bank` | 1020 | Bank |
  | `cheques_in_hand` | 1030 | Cheques in hand |
  | `receivables` | 1100 | Accounts receivable |
  | `inventory` | 1200 | Inventory |
  | `wip` | 1210 | Work in progress |
  | `vat_input` | 1300 | Input VAT |
  | `payables` | 2000 | Accounts payable |
  | `vat_output` | 2100 | Output VAT |
  | `vat_payable` | 2110 | VAT payable |
  | `opening_clearing` | 2900 | Opening balance clearing |
  | `retained_earnings` | 3200 | Retained earnings |
  | `opening_equity` | 3300 | Opening balance equity |
  | `sales_labour` | 4000 | Labour sales |
  | `sales_parts` | 4010 | Parts sales |
  | `sales_other` | 4020 | Other income |
  | `cogs_parts` | 5000 | Cost of parts sold |
  | `stock_adjustments` | 5010 | Stock adjustments |
  | `stock_revaluation` | 5020 | Stock revaluation |
  | `purchases_other` | 5030 | Other purchases |

- **The other default accounts:**
  - 1400 Prepayments; 1500 Tools and equipment; 1510 Vehicles; 1590 Accumulated depreciation;
  - 2200 Salaries payable;
  - 3000 Owner's capital; 3100 Owner's drawings;
  - 6000 Salaries; 6010 Rent; 6020 Utilities; 6030 Bank charges; 6040 Fuel; 6050 Repairs and maintenance; 6060 Office and admin; 6090 Other expenses.
- **Produces the journal schema:** `journalLineSchema` (accountId, debitFils ≥ 0, creditFils ≥ 0, exactly one of them > 0, optional customerId, supplierId, memo ≤ 200) and `journalDraftSchema` (date ymd, narration 1–300, lines 2–200, `.refine` total debits = total credits, message "Debits and credits must be equal").
- **Produces the `books` settings section:**
  - `startDate` (ymd or null);
  - `fiscalYearStartMonth` (int 1–12, default 1);
  - `lockDate` (ymd or null);
  - `methodAccounts`: `{ cash, card, bank_transfer, cheque }` → account ids, defaulting to `cash`, `card_clearing`, `bank`, `cheques_in_hand`.
- **Produces numbering and permissions:**
  - numbering `journalPrefix` (default `"JV"`) and `journalStart`;
  - the uniqueness refine now checks 7 prefixes;
  - `NUMBER_KINDS` gains `"journal"`;
  - new actions as in Global Constraints.

- [ ] **Step 1: Write the failing tests** in `books.test.ts`:
  - **chart:**
    - every `SYSTEM_ACCOUNTS` entry is in `DEFAULT_CHART`;
    - codes are unique;
    - ids match the pattern;
    - the type follows the code range: 1→asset, 2→liability, 3→equity, 4→income, 5→cost_of_sales, 6→expense.
  - **journal draft refuses unbalanced or one-sided lines:** debits 100 against credits 90 is refused with "Debits and credits must be equal"; a line with both debit and credit set is refused.
  - **books defaults** (in `settings.test.ts`): `DEFAULT_SETTINGS.books` is `{ startDate: null, fiscalYearStartMonth: 1, lockDate: null, methodAccounts: { cash: SYSTEM_ACCOUNTS.cash.id, … } }`; the default `journalPrefix` is "JV".
  - **permissions:** an accountant can do `books.view` and `books.post` but not `books.lock`; an advisor has none of the three.
- [ ] **Step 2: Run** `npx vitest run packages/shared`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** `npx vitest run packages/shared`, then `npm run typecheck`. Expected: PASS. Fix any `NumberingSection` exhaustiveness the new kind exposes, by adding a "Journal" row to its labels.
- [ ] **Step 5: Commit** `feat(books): chart of accounts, books settings, journal schema, permissions`.

### Task 2: Tables, accounts API and `postEntry`

**Files:**
- Create: `packages/server/src/books/{post,accounts}.ts`, `packages/server/src/routes/books.ts`, `packages/server/test/books-core.test.ts`
- Modify: `packages/server/src/{migrations,app}.ts`, `packages/sync/src/tables.ts`

**Interfaces:**
- **Migration 11:**
  - `accounts` (id, code UNIQUE, name, type CHECK, system_key UNIQUE nullable, active, created_at, updated_at), seeded with `DEFAULT_CHART`;
  - `journal_entries`: id, series, seq, number, date, narration, source_type CHECK(invoice|credit_note|receipt|goods_receipt|stock|cogs|customer_opening|opening|manual|reversal|year_close|revaluation), source_id, post_key UNIQUE, reverses_id, original_date, created_by, created_at; UNIQUE(series, seq);
  - `journal_lines`: id, entry_id, position, account_id, debit_fils, credit_fils, customer_id, supplier_id, document_id, memo; indexes on (account_id), (entry_id), (customer_id), (document_id);
  - `journal_drafts`: id, kind CHECK(manual|opening), date, narration, lines_json, created_by, created_at, updated_at.
- **Sync tables:** `accounts` (after `users`); `journal_drafts`; `journal_entries` (insertOnly) and `journal_lines` (insertOnly), both after `receipt_allocations`.
- **Produces:**
  - `postEntry(db, e: { date; narration; sourceType; sourceId?; postKey?; reversesId?; lines: PostLine[]; userId: string|null }): string | null`. `PostLine` = `{ accountId; debitFils; creditFils; customerId?; supplierId?; documentId?; memo? }`.
    - Drops zero lines.
    - Throws `badRequest("Debits and credits must be equal")` if they differ.
    - Returns null when `postKey` already exists (idempotent).
    - Moves a date on or before the lock date to the day after it (setting `original_date` and the narration suffix).
    - Numbers with `takeNumber(db, "journal", null, undefined)`.
    - Its own `db.tx`.
  - `accountId(db, key: SystemKey): string`.
  - `GET/POST /api/books/accounts` and `PATCH /api/books/accounts/:id`. Changing a system account's type, or deactivating it, gives 400; deactivating an account with posted lines is allowed (it stays in reports). Needs `books.view` / `books.post`.

- [ ] **Step 1: Write the failing tests** (`books-core.test.ts`):
  - **chart seeded:** GET accounts returns `DEFAULT_CHART.length` rows. An advisor gets 403.
  - **system accounts can be renamed, not retyped or removed.**
  - **postEntry balances or refuses:**
    - an unbalanced entry throws and writes nothing;
    - a balanced one gets number "JV-00001";
    - the same `postKey` twice returns null the second time and there is one row.
  - **postEntry moves locked dates:** with `lockDate` 2026-10-31, an entry dated 2026-10-15 is stored as 2026-11-01 with `original_date` "2026-10-15", and its narration ends "(dated 15 Oct 2026; books locked)".
  - **migration 11 on an old database:** migrateTo 10, then reopen; the tables exist and the chart is seeded. Close both handles.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/books-core.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** the test, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(books): accounts and journal tables, postEntry`.

### Task 3: Automatic posting — rules, `postPending`, who posts

**Files:**
- Create: `packages/server/src/books/rules.ts` (one `post…` function per source), `packages/server/src/books/pending.ts`, `packages/server/test/books-posting.test.ts`, `apps/cloud/test/books.test.ts`
- Modify:
  - `packages/server/src/app.ts`: `AppOptions.postsBooks?: boolean`, and the onResponse hook described in Step 3.
  - `packages/server/src/index.ts`: `startGarageServer` posts unless linked; `startServer` takes `postsBooks`.
  - `packages/server/src/dev.ts`: posts.
  - `apps/cloud/src/garages.ts`: garage apps post.
  - `apps/cloud/src/sync-routes.ts`: `postPending` after a push applies and before a pull reads.
  - `apps/desktop/src/main/index.ts`: `postsBooks: !sync`.

**Interfaces:**
- **Produces:**
  - `postPending(db): number`, the number of entries posted. It does nothing without `books.startDate`.
  - Post keys and rules:

    | Post key | Debit | Credit | Date |
    |---|---|---|---|
    | `invoice:<id>` | receivables (customer), gross | sales by line kind (net), vat_output | issue date |
    | `credit_note:<id>` | the same accounts as the invoice, reversed | | its issue date |
    | `receipt:<id>` | `methodAccounts[method]`, amount > 0 | receivables (customer) | received date |
    | `receipt:<id>`, amount < 0 (refund) | receivables (customer) | `methodAccounts[method]` | received date |
    | `goods_receipt:<id>` | per line: inventory (stocked part, no job), wip (with the job's document id, line has a job), or purchases_other; vat_input | payables (supplier), gross | `supplier_invoice_date ?? created_at` |
    | `stock:<id>`, reason `job` | wip (job id) | inventory | movement date |
    | `stock:<id>`, reason `invoice` | cogs_parts | inventory | movement date |
    | `stock:<id>`, reason `adjust` | inventory or stock_adjustments, by sign | the other | movement date |
    | `stock:<id>`, reason `opening` | inventory | opening_clearing | movement date |
    | `cogs:<invoiceId>` | cogs_parts | wip | invoice date |
    | `customer_opening:<customerId>:<n>` | receivables (customer) | opening_clearing | opening date |

    - The value of a stock entry is `round(|qty| × unit_cost)`. A returned part (qty > 0) reverses its debit and credit.
    - `goods_receipt`: rounding between the lines and `gross_fils` goes to the last line, so the payable equals `gross_fils` exactly.
    - Reason `receive` movements post nothing: the goods receipt covers them.
    - `cogs:<invoiceId>` moves the WIP balance of the job card the invoice was converted from, and of any job linked to it. A goods-receipt line for a job whose invoice is already issued goes straight to cogs_parts.
    - `customer_opening`: n counts each change. A change posts the difference between the current opening balance and what has been posted.
    - The invoice debit carries `customerId`; the goods-receipt credit carries `supplierId`.
  - The cutoff: events dated before `startDate` are skipped.

- [ ] **Step 1: Write the failing tests** (`books-posting.test.ts`). The garage is built with `postsBooks: true` and `books.startDate` set to today; for invoices, call the API and then `postPending`.
  - **invoice posts by line kind:** labour 100.00, a part 50.00 with a 10% discount, and an "other" line 20.00 give:
    - Dr Receivables (customer) = gross;
    - Cr Labour sales 10000, Parts sales 4500, Other income 2000;
    - Cr Output VAT = the document's VAT;
    - balanced.
  - **credit note reverses by line kind:** a partial credit note on that invoice posts the mirror of its own lines, and the VAT equals the credit note's VAT.
  - **receipts post by method; refunds reverse:**
    - cash 50 → Dr Cash / Cr AR;
    - cheque 30 → Dr Cheques in hand;
    - a refund of −20 cash → Dr AR / Cr Cash.
  - **goods receipt and WIP to COGS:**
    1. Receive a stocked part, qty 2 at 40.00 plus 5% VAT → Dr Inventory 8000, Dr Input VAT 400, Cr Payables 8400 (supplier).
    2. Fit 1 on a job card → Dr WIP 4000 (document = the job card) / Cr Inventory.
    3. Convert to an invoice and issue it → `cogs:` Dr Cost of parts sold 4000 / Cr WIP. The job's WIP is 0.
  - **counter sale takes stock straight to COGS**, and **a stock count adjustment of −1** → Dr Stock adjustments / Cr Inventory.
  - **opening items go to clearing:** a customer opening balance of 300 → Dr AR / Cr Opening balance clearing. Changing it to 250 posts a −50 difference entry.
  - **dates: before start never, locked → first open day:**
    - a receipt dated before the start date posts nothing;
    - with the lock date set to yesterday, a receipt dated yesterday posts today with `original_date` yesterday.

    For the second case, set the lock date directly in the settings table: the screen refusal comes in Task 4.
  - **postPending is idempotent:**
    - running it twice posts nothing the second time;
    - running it twice at once (`Promise.all` of two requests that trigger the hook) leaves exactly one entry per post key;
    - the count of entries equals the number of events.
  - **every entry balances:** after all the above, `SUM(debit) = SUM(credit)` per entry and overall.
  - **no start date, nothing posts.**
  - In `apps/cloud/test/books.test.ts`, **linked PC never posts; cloud entries arrive by sync**: with the cloud and PC helpers from the sync client tests, invoice on the PC, then `syncOnce`. The cloud has `invoice:<id>`; the PC's `journal_entries` hold the cloud's entry (pulled); there is exactly one.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/books-posting.test.ts apps/cloud/test/books.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `rules.ts`, `pending.ts` and the wiring.
  - The onResponse hook runs `postPending` after every non-GET request with a 2xx answer, when `postsBooks`. Errors are logged, never thrown.
  - The books GET routes also call it first, so reports are never behind.
- [ ] **Step 4: Run** the same command, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(books): automatic posting from invoices, credit notes, receipts, purchases and stock`.

### Task 4: Manual journals, reversals, opening balances, locking, year end

**Files:**
- Create: `packages/server/src/books/{journals,opening,close}.ts`, `packages/server/test/books-journals.test.ts`
- Modify: `packages/server/src/routes/books.ts`, `packages/server/src/routes/receipts.ts` (lock check), `packages/server/src/settings.ts` (books section check)

**Interfaces:**
- **Drafts and posting:** `GET/POST /api/books/drafts`, `PATCH/DELETE /api/books/drafts/:id` and `POST /api/books/drafts/:id/post` (`books.post`).
  - Posting validates with `journalDraftSchema`, calls `postEntry` (manual), then deletes the draft.
  - A server without `postsBooks` gives 409: "Post from the browser app: this garage's books are kept in the cloud."
- **Reversal:** `POST /api/books/journals/:id/reverse { date }`. It mirrors the lines (`source_type` reversal, `reverses_id`, key `reversal:<id>`). Reversing twice gives 409 "Already reversed". Automatic entries can be reversed only through their source documents (credit note, refund): 400.
- **Opening balances:**
  - `GET /api/books/opening/proposal` returns lines as at `startDate − 1`:
    - receivables per customer = `customerBalance(asOf)` (non-zero only);
    - inventory = Σ qty×unit_cost of movements before the start date;
    - wip per job card still open at the start date.
  - The accountant saves it as a draft of kind `opening` and posts it (key `opening`, only one). Lines that don't balance are made up on `opening_equity`, shown on screen before posting.
- **Locking** (a check on the books settings section, Owner only through `settings.manage`):
  - `lockDate` must be before today;
  - moving it earlier is allowed and logged;
  - `startDate` can't change once any entry exists: "The books have started on …".
  - `POST /api/receipts` with `receivedAt` on or before the lock date gives 400: "The books are locked up to 31 Oct 2026".
- **Year end:** `POST /api/books/year-end { yearEnd: ymd }` (`books.lock`).
  - It posts `year_close:<ymd>`: every income, cost-of-sales and expense account's balance for the fiscal year goes to zero, against retained_earnings. The lock date becomes the year end.
  - A second call gives 409.

- [ ] **Step 1: Write the failing tests:**
  - **draft → post → reverse:**
    1. A rent journal (Dr Rent 5000 / Cr Bank 5000) saved as a draft, edited, then posted gets number JV-…; the draft is gone.
    2. Reversing it posts the mirror.
    3. A second reverse gives 409.
    4. Reversing an `invoice:` entry gives 400.
  - **linked server refuses to post:** an app without `postsBooks` gives 409 with the message above.
  - **opening proposal and post:**
    - customer balances and stock before the start date appear in the proposal;
    - posting it puts the difference on opening_equity;
    - a second opening post gives 409.
  - **locks:**
    - a lock date of today or later is refused;
    - a receipt dated in the lock gives 400;
    - changing the start date after posting is refused.
  - **year end:** income 10000 and expense 3000 in the year give a closing entry Dr income 10000, Cr expense 3000, Cr retained earnings 7000; the lock date becomes the year end; a second call gives 409.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/books-journals.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** the test, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(books): manual journals, reversals, opening balances, locking, year end`.

### Task 5: Reports and books health

**Files:**
- Create: `packages/server/src/books/reports.ts`, `packages/server/test/books-reports.test.ts`
- Modify: `packages/server/src/routes/books.ts`

**Interfaces** (all `books.view`; each calls `postPending` first where it posts):
- `GET /api/books/trial-balance?asOf` → `{ rows: {accountId, code, name, type, debitFils, creditFils}[], totals }`.
- `GET /api/books/profit-loss?from&to` → `{ current: Section, previous: Section }`.
  - A section is income, cost of sales, gross profit, expenses and net profit, by account.
  - "Previous" is the same length of time just before.
- `GET /api/books/balance-sheet?asOf` → assets, liabilities, and equity, including "profit this year" (income − costs since the last year close).
- `GET /api/books/ledger?accountId&from&to&customerId&supplierId` → the opening balance, rows `{entryId, number, date, narration, sourceType, sourceId, sourceNumber, debitFils, creditFils, balanceFils}`, and the closing balance.
- `GET /api/books/journals?from&to&sourceType&q` and `GET /api/books/journals/:id`, with lines, account names, the source document number, and what reversed it.
- `GET /api/books/health` → `{ checks: { key, ok, appFils, booksFils, differenceFils, note }[], late: Entry[], openWip: {jobId, number, wipFils}[] }`. The keys:
  - `trial_balance`;
  - `receivables`: Σ customer balances vs the receivables account;
  - `inventory`: Σ on_hand × avg_cost vs inventory;
  - `output_vat`: VAT on invoices − credit notes since the start vs vat_output movements from automatic entries;
  - `opening_clearing`: must be 0.
- `POST /api/books/revalue-stock` (`books.post`, posting place only):
  - posts the `inventory` difference as `revaluation:<uuid>`, Dr or Cr inventory against stock_revaluation, dated today;
  - with no difference, 409 "Stock already matches the books".
  - This is the spec's revaluation after a cost is recalculated. The Books health page has a button for it.

- [ ] **Step 1: Write the failing tests** on a small garage: one invoice, one receipt, a goods receipt, a part fitted and invoiced, and a rent journal.
  - The trial balance balances.
  - Profit and loss: net profit = sales − cost of parts − rent.
  - Balance sheet: assets = liabilities + equity, including profit this year.
  - The ledger for receivables, filtered by the customer, ends at that customer's `customerBalance`.
  - **health is green after normal work and flags a mismatch:** first all checks are `ok`; then a direct `UPDATE parts SET avg_cost_fils` makes `inventory` not ok, with the right difference.
  - **report dates:** a trial balance as at a date before an entry excludes it.
  - **revalue stock clears the mismatch:** after the `UPDATE` above, `POST /api/books/revalue-stock` posts the difference; `inventory` is ok again; a second call gives 409.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/books-reports.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with SQL over `journal_lines` joined to entries (no per-row JavaScript loops on large sets).
- [ ] **Step 4: Run** the test, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(books): trial balance, P&L, balance sheet, ledger, journals, books health`.

### Task 6: Screens, exports and docs

**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/books/{BooksHome,AccountsPage,JournalsPage,JournalEditor,OpeningPage,ReportPage,HealthPage}.tsx`
  - `apps/desktop/src/renderer/books/export.ts`
  - `apps/desktop/src/renderer/pages/settings/sections/BooksSection.tsx`
  - `apps/desktop/test/books.spec.ts`
  - `playwright.books.config.ts` (copy of the messages config, its own data dir)
- Modify:
  - the nav (a "Books" group, shown with `books.view`);
  - `App.tsx` routes;
  - `pages/settings/{tiles.ts,SettingsSectionPage.tsx}`: the Books tile. Its status is "Not started" (todo), "Books from DD Mon YYYY · locked to …" (ok), or alert when health has a failing check.
  - root `package.json` (the `e2e:books` script);
  - `apps/desktop/package.json` (`write-excel-file@4.1.1`, devDependency, exact version);
  - `README.md` (a "Books (Accounting Part 1)" section).

**Interfaces:**
- **Produces in `export.ts`:**
  - `exportXlsx(fileName: string, sheet: { columns: {header, key, money?: boolean}[]; rows: Record<string, unknown>[] }): Promise<void>`. Money is in AED with 2 decimals. In the browser it downloads; on a PC it uses the same blob download.
  - `exportPdf(title: string, html: string): Promise<void>` uses the existing `printHtml(…, "pdf")`.
- **What the screens hold:**
  - **Books home:** cards for Trial balance, Profit and loss, Balance sheet, General ledger, Journals, Chart of accounts, Opening balances, Books health. A banner says "Books not started: set the start date in Settings → Books" (link) when there's no start date.
  - **Reports:** a date or range picker, a table with clickable rows (account → ledger; ledger row → journal; journal → source document), and Excel and PDF buttons.
  - **Journal editor:** date, narration, and lines (account picker by code or name, debit, credit, customer or supplier for receivables and payables). Running totals and the difference are shown in red until balanced. Save draft, then Post.
  - **Settings → Books:** start date, fiscal year start month, lock date (Owner), the account for each payment method, and a "Close the year" button (Owner).

- [ ] **Step 1: Write the failing e2e** `books.spec.ts`:
  - **books from first sale to reports:**
    1. Set up the garage and set the start date to today in Settings → Books.
    2. Issue an invoice (labour 100.00) and receive 105.00 in cash.
    3. Books → Trial balance shows Cash 105.00 Dr, Labour sales 100.00 Cr and Output VAT 5.00 Cr, and the totals are equal.
    4. Profit and loss shows net profit 100.00.
    5. Post a rent journal of 30.00 from Cash: profit becomes 70.00.
    6. Reverse it: profit is back to 100.00.
    7. Books health shows all checks ok.
    8. Excel export downloads a `.xlsx` file whose first bytes are "PK".
  - **advisor sees no Books:** the nav has no Books link, and `/api/books/trial-balance` gives 403.
- [ ] **Step 2: Run** `npm run e2e:books`. Expected: FAIL.
- [ ] **Step 3: Implement** the screens, exports, tile and README.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, then every e2e suite: `e2e`, `e2e:settings`, `e2e:credit`, `e2e:messages`, `e2e:books`, `e2e:electron` (after `npm run build -w @ffgp/desktop`), `e2e:cloud`, `e2e:sync`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(books): Books screens, Settings → Books, Excel and PDF export`.

## After merge (not a task)
Deploy the cloud first (migration 11), then push `main`. A garage turns the books on by setting the start date and posting its opening balances.
