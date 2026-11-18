# Fleetfix Garage Pro — Settings, credit customers & messages — Design

Comes before Accounting: Accounting builds its customer ledger on the receipts, credit notes and balances defined here.

## Why
Settings today is the garage profile, a fixed 5% VAT note, Fleetfix cloud, Other PCs and Sync issues. Number
formats, payment methods and the stock rule are fixed in code. Before real garages run on it they need: documents
that carry their own branding, bank details and terms (in Arabic too when a client insists — user); **credit
customers** (user: "garage has credit customers"), with terms, limits, statements and one payment against several
invoices; a legal way to correct an issued invoice (credit notes); backups for PCs without the cloud; and
**WhatsApp and email** to customers (user). All garages print on **A4** (user), so there is one layout.

## Goals
**A. Settings screen.** One Settings page with a section list on the left. Only the Owner (`settings.manage`)
changes settings; others don't see the page. Every change is written to the audit log (G).

| Section | Holds | Where it lives |
|---|---|---|
| Garage | name, TRN, phone, email, address (exists); trade licence no.; **Arabic** name and address; bank name, account name, IBAN | garage-wide |
| Documents & printing | logo, stamp, signature image; letterhead mode; terms & footer (EN/AR); warranty line (EN/AR); estimate valid for N days; show part numbers; show labour hours; customer signature box on job cards | garage-wide |
| Numbering | prefix and next number per type (estimate, job card, invoice, credit note, PO, receipt) | garage-wide |
| Tax | VAT rate (5%, shown, not editable); prices typed **including / excluding** VAT; VAT return period (quarterly/monthly + first period start) | garage-wide |
| Pricing | default labour rate per hour; **largest discount %** per role; default parts markup % | garage-wide |
| Customers & credit | default payment terms (days); over-limit rule; reminder days; statement day of month | garage-wide |
| Messages | WhatsApp and email set-up; per-event on/off, auto/ask, channel, text (EN/AR) | garage-wide (secrets write-only) |
| Inventory | stock below zero: **warn** / block; default reorder level | garage-wide |
| Security | lock screen after N idle minutes (default 15) | garage-wide |
| Backups *(PC only)* | backup folder, keep N days, Back up now, Restore | this PC |
| Fleetfix cloud, Other PCs *(PC)*, Sync issues | as today | as today |

**B. Documents and printing (A4 only).**
- Logo top-left, garage details (EN, plus AR right-to-left when bilingual) top-right. **Letterhead mode** leaves a
  set top margin blank (mm) and prints no logo/details, for pre-printed paper.
- Bank details and terms in the footer of invoices and statements; warranty line on invoices.
- Stamp and signature images (optional) above "Authorised signature".
- Job cards get a customer signature box ("I authorise the work above").
- **Watermarks:** "COPY" on every print of an issued invoice or credit note after the first (the document counts its
  prints); "PAID" once fully paid.
- Images are PNG/JPG up to 500 KB, stored in settings (so they sync).

**C. English + Arabic documents.**
- Each customer has **Document language**: English (default) or English + Arabic.
- Bilingual documents carry both labels side by side ("Tax Invoice / فاتورة ضريبية", "Total / المجموع"…), the
  garage's Arabic name, address, terms and warranty line, and the **total in words in English and Arabic**.
- Line descriptions: parts gain an optional Arabic name, used on bilingual documents under the English one. Lines
  typed by hand print as typed. *(My call: translating free text is not something the app can do reliably.)*
- An Arabic font (Noto Naskh Arabic, OFL) is bundled; numbers stay Western digits; the screens stay English.
- The language is copied onto the document when it is created, so a reprint looks the same if the customer changes.

**D. Credit customers.**
- Per customer: **credit allowed**, **credit limit**, **payment terms** (days; default from settings),
  **discount %**, **LPO required**, statement contact, **opening balance** (with date).
- Invoices get a **due date** (issue date + terms; cash customers: same day) and an **LPO number**. A customer with
  "LPO required" can't have an invoice issued without one.
- **Balance** = issued invoices + opening balance − credit notes − receipts. Shown on the customer page, the
  document editor and the customer picker.
- **Over the limit** (balance + this invoice > limit) when issuing an invoice or opening a job card: setting picks
  **warn** (default), **block**, or **block unless the Owner approves** (Owner enters their password; logged).
- **Receipts:** one payment (cash, card, transfer, cheque — with cheque number and date) is **allocated across
  several invoices**, oldest first by default, editable. What isn't allocated stays as **customer credit** (an
  advance) and can be allocated later. Printable receipt (RCT-00001).
- **Statement of account** (PDF, A4, EN or EN+AR): opening balance, invoices, credit notes, receipts, running
  balance, and an aging summary, for any date range.
- **Aging report** (Owner, Accountant): per customer, owed for current / 1–30 / 31–60 / 61–90 / 90+ days overdue.

**E. Credit notes.** An issued invoice is never edited. The Owner or Accountant issues a **tax credit note**
(CN-00001) against it: whole invoice or chosen lines/quantities, with a required reason. It reduces what the
invoice owes; if the invoice was already paid, the amount becomes customer credit (or a refund, recorded as a
negative receipt). For stocked parts, "Return parts to stock" (default on) puts them back. Prints like an invoice
with the original invoice number and date on it.

**F. Messages — WhatsApp and email.**

*Contacts.* A customer has **contacts** (name, phone, email, language, and what they get: approvals, invoices &
statements, "vehicle ready"). An individual customer's own phone/email count as one contact. A job card can name
the driver (name, phone) who gets that job's "vehicle received/ready" messages.

*Events.* Each has: on/off, **send automatically** or **ask** (staff see a ready message and press Send), channel
(WhatsApp, email, both), and text in English and Arabic. The contact's language picks the text.

| Event | Goes to | Attachment |
|---|---|---|
| Vehicle received (job card opened) | driver or customer | — |
| Estimate ready | approvals contact | estimate PDF |
| Extra work needs approval (estimate re-sent) | approvals contact | estimate PDF |
| Vehicle ready | driver or customer | — |
| Invoice issued | invoices contact | invoice PDF |
| Payment received | invoices contact | receipt PDF |
| Payment due in N days / overdue by N days | invoices contact | — |
| Monthly statement | statement contact | statement PDF |

Placeholders: `{customer}`, `{contact}`, `{plate}`, `{vehicle}`, `{doc_number}`, `{amount}`, `{balance}`,
`{due_date}`, `{garage}`, `{garage_phone}`. Unknown placeholders are refused when the template is saved.

*WhatsApp — this project: click to send.* "Send on WhatsApp" opens WhatsApp (desktop app or web) to the contact's
number with the message typed in, and saves the PDF to a folder and shows it, ready to drag in. Staff press Send in
WhatsApp. Free, no set-up, works on the garage's own number. Automatic events on WhatsApp become "ask" events,
because nothing can be sent without a person.

*Email.* Two ways, picked in Settings → Messages:
1. **Fleetfix mail** (default when linked to the cloud): the cloud sends it from a Fleetfix address with the
   garage's name and **reply-to** the garage's email. Nothing to set up.
2. **Own mail server (SMTP):** host, port, security, username, password, from name/address, "Send test email".

*Who sends automatic messages.* Exactly one place, so nothing goes twice: the **cloud** when the garage is linked;
otherwise the **main computer**; otherwise this PC. Messages wait in an outbox and retry on failure (1, 5, 30 min,
then marked failed and shown on the dashboard).

*Message log.* Every message (sent, failed, or opened in WhatsApp) is logged with channel, recipient, event,
document, who triggered it and when; shown on the customer page and on the document.

*Consent.* Messages about a job or account need no opt-in. Service reminders and offers (later) only go to contacts
with **marketing consent** ticked (date recorded), as the UAE data protection law expects.

**G. Audit log.** Append-only record of: settings changes (old → new, secrets masked), discounts over a role's
limit, credit-limit overrides, credit notes, receipts and allocations, users and roles changed, restores. Owner can
view and filter it.

**H. Backups (PCs).** A PC that holds a garage (not a connected PC) writes a full copy daily to its backup folder
(default `Documents\Fleetfix Backups`), keeps 30 days, and warns on the dashboard if the last backup is over 3 days
old or the folder is missing (e.g. USB drive unplugged). **Restore** (Owner): pick a file, the app first backs up the
current data, then replaces it and restarts. A PC linked to the cloud can't restore over a cloud garage — it says to
download the garage again instead.

## Non-goals (this project)
WhatsApp Business API (automatic WhatsApp, delivery ticks) — phase 2, through the cloud; SMS; online estimate
approval link; **UAE e-invoicing** (Peppol via an accredited provider) itself — but this project makes the data ready
(see Anti-goals); insurance claims and split billing; one combined monthly invoice for a fleet; vehicle check-in
(fuel, damage photos, checklist); service menu / fixed-price packages; technicians and appointments; storage fees;
structured UAE plates; daily cash-up; zero-rated/exempt VAT lines; Arabic screens.

## Anti-goals
- Changing an issued invoice or credit note, or deleting anything that has been issued (FTA: keep 5 years).
- A message going out twice, or to a fleet's driver when it was meant for its accounts team.
- Passwords or API keys readable from the API, the screens, logs or exports once saved.
- An invoice number going backwards or two documents with the same number.
- A balance that doesn't match the statement.
- E-invoicing later forcing a rebuild: invoices, credit notes and customers must already hold what a structured
  invoice needs (TRN, address, due date, LPO, reasons, the invoice a credit note corrects).

## Approaches
1. **Picked: settings as validated keys in the existing `settings` table**, one Zod schema per section in
   `packages/shared`, read through one `getSettings()` with defaults. Syncs with no new table; new settings need no
   migration.
2. Rejected: one column per setting on `garage` — a migration for every new option, and wide rows clash in sync.
3. Rejected: a JSON blob in one row — two people changing different sections on two PCs would overwrite each other;
   per-key rows merge field by field like everything else.

For receipts: **picked** a receipt with allocations (one payment → many invoices); rejected keeping one payment per
invoice and splitting a transfer into several payments, because the bank shows one amount and statements must too.

## How it works
**Settings data.** Keys are `section.name` (e.g. `numbering.invoice.prefix`, `credit.overLimit`,
`msg.invoice_issued`). Values are JSON, validated against the schema on write; unknown keys are refused.
- **This-PC keys:** today only `network.` stays on the PC (`LOCAL_SETTING_PREFIX`). Make it a list:
  `network.`, `local.` (`local.backup.folder`, `local.backup.keepDays`). Change capture skips both.
- **Secrets** (`secret.smtp.password`): stored, synced to the cloud (which sends the mail), never returned by any
  API — the screen shows "set" / "not set" and a Replace button.
- **Numbering:** prefix 1–6 letters; next number can only go up, and only above the highest number used. Format stays
  `PREFIX-[series-]00000`; online numbers still come from the cloud, offline PCs keep their own series.

**Migration 7 (never edit 1–6):**
- `customers` + `name_ar`, `address_ar`, `doc_language` (`en`|`en_ar`), `credit_allowed`, `credit_limit_fils`,
  `terms_days`, `discount_bp`, `lpo_required`, `opening_balance_fils`, `opening_balance_date`.
- `customer_contacts` (id, customer_id, name, phone, email, language, gets_approvals, gets_invoices,
  gets_ready, gets_statements, marketing_consent_at, timestamps).
- `documents` + `due_date`, `lpo_number`, `language`, `print_count`, `driver_name`, `driver_phone`, `reason`
  (credit notes); `type` allows `credit_note` (source_id = the invoice). The type check means rebuilding the table,
  as migration 5 did — copy rows unchanged.
- `parts` + `name_ar`.
- `receipts` (id, series, seq, number, customer_id, amount_fils, method, reference, cheque_date, received_at,
  created_by, timestamps) and `receipt_allocations` (id, receipt_id, document_id, amount_fils, created_by,
  created_at). Existing `payments` become one receipt + one allocation each, **reusing the payment's id** for the
  receipt (and a fixed derivation for the allocation id), so a PC and the cloud migrating separately end up with the
  same rows; `payments` is kept read-only for one release, then dropped.
- `messages` (id, customer_id, contact_id, document_id, event, channel, recipient, subject, body, attachment,
  status `queued|sent|failed|opened`, attempts, error, sender_place, created_by, created_at, sent_at).
- `audit_log` (id, action, entity, entity_id, before, after, user_id, device, created_at).
- Every new table has UUIDs and timestamps and is added to `packages/sync/src/tables.ts`.

**Money rules (`packages/shared`, unit-tested hard):**
- `paid_fils` on an invoice = its allocations; credit notes reduce `gross` owed, not `paid`. Status (issued /
  part_paid / paid) follows from that. All recalculated from rows, like stock, so sync adds up on both sides.
- Allocations are only ever added; a wrong one is undone by a negative allocation (same as payments today).
- Customer balance and aging come from the same function the statement uses.
- Discount over the role's limit: the line needs the Owner's approval (password), logged.
- Prices "including VAT": the typed price is gross; net = round(gross × 100 / 105) per line, VAT = gross − net, so
  the printed total equals what was typed.
- Amount in words: English and Arabic (dirhams and fils), in `packages/shared`.

**Permissions** (`packages/shared/src/rules.ts`): add `credit_notes.issue` (Owner, Accountant), `credit.override`
(Owner), `audit.view` (Owner), `messages.send` (everyone), `messages.configure` (Owner, via `settings.manage`).
`payments.record` covers receipts and allocations. Advisors see a customer's balance and "over limit" but not aging.

**Screens:** Settings (section list); customer page gains Contacts, Credit, Balance, Statement, Messages tabs; new
Receipts page and "Receive payment" on the customer page; credit note from an invoice; Aging report; Audit log;
"Send" menu on documents (WhatsApp / email / PDF); dashboard: overdue total, failed messages, backup warning.

**Cloud:** the cloud runs automatic messages and Fleetfix mail for linked garages (a queue per garage, one worker),
and the daily statement/reminder jobs. The browser app gets the same screens; Backups is hidden there (the cloud has
its own).

## Rollout
1. **Before the first live garage:** settings screen and storage, garage/printing/numbering/tax/pricing settings,
   credit customers, receipts with allocation, credit notes, audit log, backups.
2. **Then:** contacts, messages (WhatsApp click-to-send, email, outbox, log), English + Arabic documents.

## Tests
Vitest: settings schemas and defaults; this-PC keys never captured; secrets never in API output; numbering never
goes back; including-VAT rounding; allocation and balance with credit notes, advances and opening balances; aging
buckets; over-limit rules; amount in words (EN/AR edge cases: 0, 1, 11, 100, 1,000,000.25); placeholder checking;
one sender per message. Playwright: issue on credit → over limit warning → receive one transfer across three
invoices → statement shows zero; credit note on a paid invoice → customer credit; bilingual invoice PDF renders
Arabic; restore a backup. Sync e2e: allocation made on two PCs at once adds up on both; a message queued on a PC is
sent once by the cloud.

## Open questions
1. **Insurance and accident repairs** — do any garages do them? If yes, split billing (insurer + customer excess)
   needs its own project, and it changes how invoices relate to jobs.
2. **Monthly combined invoice for fleets** — wanted, or is one invoice per job plus a monthly statement enough?
   (Assumed enough for now.)
3. **WhatsApp phase 2** — the garage's own business number, or a shared Fleetfix number? (Click-to-send uses the
   garage's own WhatsApp, so this only matters for phase 2.)
4. **E-invoicing deadline** — our understanding is that businesses under AED 50m revenue must appoint an accredited
   provider by about March 2027 and go live by about July 2027. Confirm with the Ministry of Finance before planning
   that project.
