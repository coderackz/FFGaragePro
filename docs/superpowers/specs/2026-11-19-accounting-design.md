# Fleetfix Garage Pro — Project 3: Accounting — Design

## Why
The garage's accountant keeps the books, and the owner or an outside auditor checks them (user, 2026-11-19). The user
wants a **complete accounts module**, so the garage's real books live in the app rather than in a separate package.
Everything the workshop already does with money (invoices, credit notes, receipts, refunds, parts received, stock
used) must reach the books by itself. The accountant adds what the app can't know. UAE garages also need proper books
for corporate tax (9%, since 2023), and e-invoicing is coming in 2027.

## Decided by the user
- A complete accounts module. The accountant keeps the books; the owner or a third party audits them.
- **Payroll runs in the app**: salaries are paid by **WPS**. A monthly **bonus** is paid in **cash**, outside WPS.
  (The user changed "overtime" to "bonus": no overtime by hours.)
- **Approach A, a stored ledger.** Every money event writes a fixed journal entry when it happens. Reports read the
  entries. Posted entries never change.
- Built in parts, in this order: (1) the books, (2) suppliers, expenses and bank, (3) VAT return, (4) payroll,
  (5) fixed assets. *(Order proposed; the user agreed to approach A and didn't change the order.)*

## Goals
**Part 1 — The books**
- **Chart of accounts.** A default chart for a UAE garage, editable: the accountant adds, renames and deactivates
  accounts. System accounts (receivables, VAT, inventory and the others the rules post to) can be renamed but not
  removed. Codes: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx cost of sales, 6xxx expenses.
- **Automatic entries** (the rules below) from everything that exists today, written in the same database transaction
  as the action that causes them.
- **Manual journals** by the accountant: date, narration, lines (account, debit or credit, optional customer or
  supplier). Saved as a draft, then posted. A posted journal is corrected only by a reversing journal.
- **Books start date and opening balances.**
  - The owner sets the date the books start. Everything from that date is posted automatically, including documents
    already in the app.
  - Opening balances (the trial balance the day before) are typed in or imported from CSV.
  - The app offers what it already knows as a starting point: customer balances and stock value at that date.
- **Reports:** trial balance, profit and loss (any period, with the previous one alongside), balance sheet (any date),
  general ledger by account, journal list, and customer and supplier ledgers. Each drills down to the entry and its
  source document. Each exports to Excel (.xlsx) and PDF.
- **Locking.** The owner locks the books up to a date (usually a finished month or VAT period). Nothing can be posted
  on or before that date. An automatic event that happens later but belongs to a locked period posts on the first
  open day, and its narration says so.
- **Year end.** A fiscal year start month (Settings). Closing a year moves profit and loss into retained earnings with
  a closing entry, and locks the year.
- **Audit trail.** Every entry shows who made it, when, which document caused it, and what reversed it. Settings and
  lock changes go to the existing activity log.

**Part 2 — Suppliers, expenses and bank**
- **Supplier bills.**
  - A goods receipt is already the supplier's bill for parts.
  - New: bills for anything else, such as rent, utilities, outside work and tools. Each has the supplier's invoice
    number and date, lines (expense account, net, VAT treatment) and a due date.
- **Paying suppliers.** Cash, bank transfer, card or cheque. A payment can cover several bills, or wait as an advance.
  Supplier balances, aging and statements, mirroring the customer side.
- **Expenses paid on the spot** (petty cash, fuel): a quick form that posts the expense and the payment together, with
  a receipt photo attached.
- **Bank and cash accounts.**
  - Any number of bank accounts, cash boxes and card-clearing accounts.
  - Transfers between them.
  - Cheques received sit in "cheques in hand" until deposited. Post-dated cheques show their date.
  - Cheques issued sit in "cheques issued" until they clear.
- **Bank reconciliation.** Import the bank statement as CSV (columns mapped once per bank), match lines to entries
  (suggested by amount and date), and add bank charges in place. Shows the reconciled balance against the statement.

**Part 3 — VAT return**
- The figures of the tax authority's VAT201 return for a period (Settings → Tax already holds the period):
  - standard-rated sales by emirate (the garage's emirate, from Settings);
  - zero-rated and exempt sales;
  - output VAT;
  - standard-rated expenses and input VAT;
  - reverse charge;
  - adjustments.
- Each box drills down to its entries.
- Marking a return filed locks its period and posts the settlement: output VAT minus input VAT into "VAT payable"
  (or refundable). Paying it is a normal bank payment.

**Part 4 — Payroll**
- **Employees:**
  - name, job, Emirates ID, labour card number, passport number and visa, each with an expiry date (reminders on the
    dashboard);
  - nationality, joining date;
  - pay: basic plus allowances (housing, transport, other);
  - how they're paid: bank IBAN or salary card, with the bank routing code;
  - their MOHRE personal number (person ID), needed for WPS.
- **Monthly run.**
  1. The accountant opens a month.
  2. The app proposes each person's pay: basic and allowances; minus unpaid leave (gross ÷ 30 per day) and advance
     repayments; plus extras.
  3. The accountant types each person's cash **bonus**.
  4. The owner **approves** the run. Approval posts the salary entries and makes the WPS file and payslips. *(My
     call: the accountant prepares and the owner approves, which keeps duties apart as auditors expect.)*
- **WPS file:** the MOHRE salary information file (SIF), one EDR line per employee plus an SCR line for the employer,
  named as the agent bank expects. Fixed pay goes in the fixed column. The cash bonus is **not** included, unless the
  setting "put bonus in WPS as variable pay" is on.
- **Cash bonus:** paid from a cash box on a voucher the employee signs (printed list per run). Posted as staff bonus
  expense paid from cash.
- **Paying the salaries:** marking the WPS transfer as paid posts it from the chosen bank account.
- **Leave:**
  - annual leave builds up at 2.5 days a month (30 days a year), with a balance per employee;
  - sick and unpaid leave are recorded by dates;
  - unpaid leave reduces pay and isn't counted towards service.
- **End-of-service gratuity (UAE Labour Law, Decree-Law 33 of 2021):**
  - 21 days of basic pay for each of the first five years, 30 days for each year after;
  - pro rata for part years; due after one year of service; capped at two years' total wages.
  - The amount owed is put aside every month in the books.
  - A **final settlement** for a leaver pays gratuity, leave not taken, and salary to the last day, less advances.
- **Advances and loans:** paid out, then taken back from salary in instalments.
- **Payslips:** printed, or sent by WhatsApp or email through the messages feature, in English or Arabic.

**Part 5 — Fixed assets**
- A list of tools, equipment, vehicles and fit-out: cost, date bought, useful life, and the account it sits in.
- Straight-line depreciation is posted monthly by the app. Selling or writing off an asset posts the gain or loss.

## How the automatic entries post (Part 1 unless marked)
| Event | Debit | Credit |
|---|---|---|
| Invoice issued | Receivables (customer), gross | Labour sales / Parts sales / Other income (net, by line kind); Output VAT |
| Credit note issued | the same accounts as its invoice, reversed | Receivables (customer) |
| Receipt (payment in) | Cash on hand / Card clearing / Bank / Cheques in hand (by method; Settings maps each) | Receivables (customer) |
| Refund to a customer | Receivables (customer) | Cash or bank |
| Customer opening balance (exists today) | in the opening balances, not as an entry of its own | |
| Goods receipt (parts in, with the supplier's invoice) | Inventory (stocked parts) or Work in progress (parts bought for a job); Input VAT | Payables (supplier), gross |
| Stock fitted on a job card | Work in progress | Inventory (at average cost) |
| Invoice issued for that job | Cost of parts sold | Work in progress (that job's parts) |
| Counter-sale invoice taking stock | Cost of parts sold | Inventory |
| Stock count adjustment | Stock adjustments expense, or Inventory | the other one |
| Supplier bill (Part 2) | Expense or asset account; Input VAT | Payables (supplier) |
| Supplier payment (Part 2) | Payables (supplier) | Bank / cash / cheques issued |
| Salary run approved (Part 4) | Salaries, allowances; Gratuity expense (accrual) | Salaries payable; Advances (repaid); Gratuity provision |
| WPS paid (Part 4) | Salaries payable | Bank |
| Cash bonus (Part 4) | Staff bonus | Cash on hand |
| Depreciation (Part 5) | Depreciation expense | Accumulated depreciation |

- "Supplied by Fleet Fix" lines are zero-priced and touch no stock, so they post nothing.
- Discounts are already inside each line's net, so there is no separate discount account. *(My call: that's how
  documents store them.)*
- Rounding: every entry balances to the fil. VAT is posted exactly as the document shows it.

## Decisions after the builder check (my calls, for checking)
1. **One place posts the books: the same rule as sending messages.**
   - Automatic entries are posted only where the garage's data is decided: the cloud when the garage is linked,
     otherwise the main computer or single PC.
   - A linked PC posts nothing automatically. It receives the entries by sync, so offline its books show where they
     stood at the last sync.
   - Posting is a catch-up step that runs after every change at that place. It looks for events with no entry yet and
     posts them from the data as it finally stands. The start-date posting is the same step, run over the whole history.
   - So when the cloud overrules a PC (an invoice issued on both sides, a stock correction, a refund of an
     overpayment), only the final version is ever posted. Nothing posted has to be thrown away.
   - Manual journals and payroll approvals are people's actions. They can be made on any PC and sync like receipts. The
     cloud checks each against the lock date when it arrives (see 2).
   - If a cost the app worked out changes after posting (average cost recalculated after a late delivery), the
     difference is posted as a stock revaluation entry. Posted entries never change.
2. **Dates and locked periods.**
   - An automatic entry carries the event's own date: the invoice's issue date, the receipt's received date, the goods
     receipt date.
   - On every screen, an action dated in a locked period is refused ("The books are locked up to …"). Backdating stays
     possible inside open periods.
   - Something that reaches the posting place dated in a locked period (an offline PC catching up) is posted on the first
     open day. Its narration says so, and "books health" lists it.
   - The rule "receivables = customer balances" holds on every date after the lock. A late item shows as a reconciling
     line on "books health".
3. **Start date and opening balances.**
   - The books can start on any date, for example the first day of the fiscal year for a garage that joined mid-year.
   - The opening trial balance is entered as at the day before. For a mid-year start it includes the year's income and
     expenses so far, as accountants do when moving systems.
   - Items in the app that are really part of the opening position post against an **opening balance clearing**
     account, whatever their date. These are customer opening balances, "opening" stock movements and parts imported
     from CSV.
   - Once the opening trial balance is in, that account must come to zero. "Books health" shows it until it does.
4. **VAT.**
   - All sales stay standard-rated (5%), as the Settings design already decided. The zero-rated and exempt boxes come
     from manual journals tagged with a VAT box, or stay at zero.
   - Payments received before an invoice (customer credit) don't post output VAT. At each period end, the VAT return
     page lists any such advances still unused, so the accountant can post VAT on them by manual journal if the law
     requires it. *(To confirm with the garage's accountant.)*
5. **Payroll rules** (to confirm with an accountant or the MOHRE calculator before Part 4 is built):
   - **day rate for gratuity:** basic ÷ 30;
   - **gratuity cap:** two years of basic pay;
   - **leave not taken at settlement:** paid on basic;
   - **salary to the last day and unpaid leave:** gross ÷ 30 per day.
   - Each is a setting with these defaults, so a garage's accountant can change it without new code.

## Constraints
- Money in integer fils, as everywhere in the app. Every entry's debits equal its credits. The trial balance always
  balances; this is enforced when posting, not checked afterwards.
- **Never edit, never delete** a posted entry. Corrections are reversals. Drafts (manual journals, payroll runs before
  approval) can be edited.
- **The books agree with the workshop:**
  - The receivables control account equals the sum of customer balances on any date.
  - Inventory equals stock value at average cost.
  - Output VAT equals the VAT on issued invoices less credit notes.
  - Each is checked by a test and shown on a "books health" panel.
- **Works offline and syncs** like everything else.
  - Entries are insert-only rows that sync like receipts.
  - Journal numbers (JV-…) come from the same series rules as other documents.
  - An automatic entry has a unique key (source, source id, event) as a second guard. Only one place posts automatic
    entries (see "Decisions after the builder check").
- **Who sees what** (new actions in `rules.ts`):
  - `books.view` and `books.post`: Owner and Accountant;
  - `books.lock` and `payroll.approve`: Owner;
  - `payroll.manage`: Owner and Accountant.
  - Advisors never see the books or salaries.
- **Screens stay English.** Payslips and settlement letters print in English or English + Arabic, using the Part 3a
  printing.

## Approaches
- **A. Stored ledger (chosen by the user).** Fixed entries are written as events happen, and reports read them.
  Audit-proof, lockable, and fits manual journals and opening balances. Costs a start date and a one-time posting of
  existing documents.
- **B. Books worked out on the fly from the documents.** Quicker to build, but history can shift and periods can't
  truly be locked. Rejected: auditors wouldn't accept it.
- **C. Export to the accountant's own software.** Rejected: the user wants a complete module.

## Non-goals (this project)
- Corporate tax return filing (the books support it).
- E-invoicing submission (its own project; the data is already ready).
- More than one currency: a foreign bill is entered at its AED value.
- Cost centres or branches; budgets; consolidation.
- Live bank feeds.
- Overtime by hours.
- Visa and labour card processing (expiry reminders only).
- GPSSA pension for UAE nationals (later, if a garage needs it).
- FIFO stock valuation (average cost stays).

## Anti-goals
- A trial balance that doesn't balance, or a posted entry that changes.
- The same event posted twice (sync, retries, the start-date posting run twice).
- Books that disagree with customer statements, aging, stock value or the VAT on invoices.
- A WPS file the bank rejects, or a salary paid twice.
- Advisors (or anyone without the right) seeing salaries or the books.
- A locked period changing.

## Open questions
1. **WPS agent details per garage:** employer MOHRE establishment ID, agent bank routing code and SIF file-name rules
   vary slightly by bank or exchange house. Part 4 needs one real SIF accepted by a garage's bank to confirm the format.
2. **Emirate per garage** for the VAT return: one emirate per garage (my assumption: a single location).

## Left to the builder
The default chart's exact account list and codes; screen layouts (following the Settings and Credit patterns); the
Excel library; the CSV column mapping UI; how the start-date posting runs (it must be resumable and idempotent).
