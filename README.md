# Fleetfix Garage Pro

Garage management software for independent garages, by Fleetfix.
Windows desktop app; works with or without internet.

**Project 1 — Workshop (milestone 1, done):** first-run garage setup, user logins with roles
(Owner, Admin/Accountant, Service Advisor), customers and vehicles, estimate → job card →
invoice with 5% UAE VAT, tax invoice issuing, payments, print / PDF.

**Main-computer mode:** several PCs share one garage. The owner turns on sharing in Settings → Other PCs
(TCP 47820, discovery on UDP 47821) and gives each new PC a 10-minute pairing code; other PCs choose
"Connect to main computer" on first run. Only paired PCs get in; 5 wrong passwords lock a login for 5 minutes.

**Project 2 — Inventory:** one parts list for shelf stock and parts bought per job, suppliers (Fleet Fix built in),
purchase orders, receiving deliveries with the supplier's invoice and VAT, average cost, and each job's parts cost
and margin (Owner and Accountant only). Parts list import from CSV.
- **When stock moves:** a part on a **job card** comes off the shelf as soon as the job card is saved; changing or
  removing the line puts it back. Turning the job card into an invoice moves nothing again; an invoice made without
  a job card (counter sale) takes its parts when issued. Estimates never move stock. Stock may go below zero (warned).
- **Request part** on a job-card line adds it to that supplier's draft purchase order; "Already bought" records a
  cash purchase in one step. Receiving puts shelf parts on the shelf and charges per-job parts to their job.
- **Supplied by Fleet Fix** marks a part Fleet Fix provides on its own jobs: charged at zero, never touches stock.
- Every stock change is a row in `stock_movements` (append-only); `packages/server/src/stock.ts` is the only writer.

**Fleetfix Cloud — Stage 1 (browser app, development):** `apps/cloud` hosts every garage, each on its own
SQLite file, running the same garage server; the browser app is the same screens. Fleet Fix staff create a
garage at `/admin.html` (60-day trial, then a paid-until date; 14 days' grace, then read-only) and send the
owner the garage ID and a one-time setup code. Stage 2 adds sync with the PC app; Stage 3 puts it online.

    npm run cloud                                   # build the browser app and run the cloud on http://localhost:4790
    npm run admin:create -w @ffgp/cloud -- fleetfix "Fleet Fix Admin" <password>   # first staff login
    npm run e2e:cloud                               # Fleet Fix creates a garage, the owner runs a garage day in the browser

**Fleetfix Cloud — Stage 2 (PC ↔ cloud sync):** a PC links to its cloud garage once (Settings → Fleetfix
cloud, or "Connect to Fleetfix cloud" on first run). A new PC signs in and downloads the garage; a PC that
already has a garage uploads it into a new, empty cloud garage with the setup code. After that the PC keeps
working with or without internet and syncs every 30 seconds, and within 5 seconds of a change.
- **What syncs:** every business record (garage, users, customers, vehicles, documents and lines, payments,
  parts, suppliers, purchase orders, receipts, stock movements, settings). Not sign-ins or this PC's sharing settings.
- **Edits made in two places:** merged field by field; if both changed the same field, the later one to reach the
  cloud wins. A job card's lines move as a whole: the later save wins.
- **Never lost or doubled:** stock, average cost, totals and amounts paid are recalculated from the movements and
  payments on each side, so both add up. Payments are only ever added.
- **Issued invoices don't change:** a change to an invoice that was issued elsewhere is refused and listed under
  Sync issues. An invoice issued on an offline PC keeps the lines it was printed with.
- **Invoice numbers:** online, numbers come from the cloud (`INV-00012`); an offline PC uses its own series
  (`INV-P1-00003`), so two places never use the same number.
- **The same plate, username or part number added in two places:** the second becomes "… (2)" and is listed under
  Sync issues.
- **Licence:** the PC goes read-only if the subscription has ended or it hasn't reached the cloud for 30 days.
- **Versions:** if the cloud is newer than the PC app, sync stops with "Update Fleetfix Garage Pro to keep
  syncing"; the PC keeps working.

    npm run e2e:sync                                # the desktop app downloads, syncs both ways, and uploads (cloud on port 4792)

**Fleetfix Cloud — Stage 3 (live):** https://garagepro.fleetfix.ae (admin console: `/admin.html`), a Node.js app
on Fleetfix's Hostinger Cloud Enterprise plan. The PC app connects there by default.
- **Deploying:** `npm run package -w @ffgp/cloud` builds `deploy/cloud/` (one bundled `server.mjs` + the browser app)
  and a zip. Upload the zip to the website as `app.zip` and start a Node.js build (Node 24, type "other", entry
  `server.mjs`); `.hostinger/site.json` has the settings. The app restarts on the new version; data is untouched.
- **Data:** `/home/u241423798/domains/garagepro.fleetfix.ae/fleetfix-cloud-data` (set as `FFGP_CLOUD_DATA`), outside
  the website folder: `admin.db`, `garages/<id>/garage.db`, `licence-key.pem`.
- **Backups:** every day the server writes a consistent copy of everything to `<data>/backups/<date>/` and keeps 30
  days; Hostinger's own daily backups take them off the server. Keep a copy of `licence-key.pem` somewhere safe too.
- **Licence key:** its public half is built into the PC app (`apps/desktop/src/main/trusted-keys.ts`). If the key
  file is ever replaced, update that file and ship a new installer.
- **First staff account:** `FFGP_CLOUD_STAFF` = `username:Full Name:<password or scrypt hash>`, used only while that
  username doesn't exist.

**Settings (Part 1 of Settings, credit customers & messages):** Settings is a home screen of tiles (Owner only), each
with a status line (green fine, amber to do, red needs attention) and a "Getting ready" bar until the essentials are
set. Each tile opens its section with its own Save; every change goes to the Activity log.
- **Garage details** (TRN, trade licence, bank & IBAN) · **Documents & printing** (logo, stamp, signature, plain or
  letterhead paper, terms, warranty, estimate validity, part numbers, labour hours, job-card authorisation; live A4
  preview and "Print a test page"; invoices print COPY from the second print and PAID once paid) · **Numbering**
  (prefixes and next numbers, never backwards) · **Tax** (prices typed including or excluding VAT, fixed per document;
  return period) · **Pricing** (labour rate, parts markup, largest discount per role — above it the Owner approves
  with their password) · **Inventory** (warn or block below zero, default reorder level) · **Users & roles** ·
  **Security** (lock the screen after idle minutes) · **Activity log** · **Backups** (PC) · **Fleetfix cloud**,
  **Other PCs** (PC) · **About & support** (garagepro@fleetfix.ae).
- **Storage:** `section.field` rows in the `settings` table (schemas and defaults in `packages/shared/src/settings.ts`);
  they sync field by field. `local.` and `network.` keys stay on their PC.
- **PC backups:** a PC holding the garage writes `Fleetfix <garage> <date time>.db` to its backup folder (default
  `Documents\Fleetfix Backups`) once a day, keeps 30 days, and warns on the dashboard when the folder is missing or
  the last copy is over 3 days old. Restore (Owner) checks the file, backs up today's data first, then restarts.
  A PC linked to the cloud downloads the garage again instead.

    npm run e2e:settings                            # Settings in the browser: sections, preview, numbering, Owner approval, screen lock

**Credit customers and credit notes (Settings Part 2):**
- **Customers** can be on credit (Owner or Accountant sets it): credit limit, payment terms (blank = Settings →
  Customers & credit default, 30 days), standing discount, "needs an LPO", opening balance. Cash customers owe on the day.
- **Invoices** get a due date and LPO number when issued; going over a credit limit warns, is blocked, or needs the
  Owner's password (Settings → Customers & credit).
- **Receipts** (RCT-…): one payment split across invoices, oldest due first; what's left is the customer's credit, used
  later or refunded. The invoice screen's "Record payment" makes a receipt for that invoice.
- **Credit notes** (CN-…): from an issued invoice, whole or chosen lines, with a reason; a paid invoice's credited amount
  becomes customer credit; stocked parts go back on the shelf.
- **Statements of account** (any range, print or PDF) and the **Aging** report come from one ledger, so they agree with
  the balance on screen. Existing payments became receipts in the upgrade (migration 8).

    npm run e2e:credit                              # credit customer, one transfer across invoices, credit note, refund, English + Arabic invoice

**English + Arabic documents (Settings Part 3a):**
- A customer's **Document language** is English or English + Arabic. A document copies it when it's made (a credit note
  copies its invoice), so a reprint never changes; it can be switched while the document is still editable.
- English + Arabic documents, receipts and statements show every label in both languages, the garage's Arabic name,
  address, terms and warranty (Settings → Garage details / Documents & printing), customers' Arabic names and
  addresses, and parts' Arabic names under the English. Lines typed by hand print as typed.
- Invoices, credit notes and receipts print the total in words (English; Arabic too on bilingual ones).
- The Arabic font (Noto Naskh Arabic, OFL) is built in, so PDFs look the same on every PC and offline. Screens stay
  English; numbers stay 0–9.

**Messages: WhatsApp and email (Settings Part 3b):**
- **Contacts** on the customer page say who gets approvals, invoices and receipts, "vehicle ready" and statements, in
  English or Arabic. A job card can name its **driver**, who gets "vehicle received/ready".
- **Email goes out from the garage's own mailbox** (Settings → Messages: mail server, port, security, username, a
  password that is never shown again, and from name and address). "Send test email" sends a real message the normal
  way.
- **Each message** (vehicle received, estimate ready, extra work, vehicle ready, invoice issued, payment received,
  payment due/overdue, monthly statement) can be on or off, automatic or ask first, by WhatsApp, email or both, with its
  text in English and Arabic. Unknown `{placeholders}` are refused.
- **WhatsApp is click-to-send:** the chat opens with the message typed in, and the PDF is saved (on a PC, to
  Documents/Fleetfix Garage Pro/Sent) ready to drag in. Nothing goes on WhatsApp without someone pressing Send.
- **One sender per garage:** the cloud when the garage is linked to it, otherwise the PC that holds the garage (or the
  main computer). Emails wait in an outbox and are retried after 1, 5 and 30 minutes. A message that still fails shows
  on the dashboard with "Try again". PDFs are made on the PC or browser where the message starts. In the browser app
  they are page images.
- **The log:** every message is listed on its customer (Messages tab) and its document. The dashboard lists this
  month's **statements to send**.

    npm run e2e:messages                            # email set-up and test, contacts, invoice emailed with PDF, WhatsApp, retry

Next: Accounting. See `docs/superpowers/specs/`.

## Layout
| Path | What |
|---|---|
| `packages/shared` | Money/VAT math (integer fils), roles & permissions, document numbering, Zod schemas |
| `packages/server` | Fastify API + SQLite (built-in `node:sqlite`); runs inside the app |
| `packages/sync` | Cloud sync: change capture (triggers), merge rules, the PC's sync client, licence tokens |
| `apps/cloud` | Fleetfix Cloud: hosts every garage, admin console, sync API |
| `apps/desktop` | Electron app: starts the server, React screens, print/PDF |

## Commands
    npm install
    npm test                      # unit + API tests (Vitest)
    npm run e2e                   # clicks through the whole workflow (incl. stock and purchasing) in Chromium; screenshots in test-results/screens
    npm run e2e:electron          # real desktop app: garage day + PDF + restart + stock, and two PCs sharing (build first)
    npm run dev                   # run the desktop app with hot reload
    npm run dist:win -w @ffgp/desktop   # Windows installer → apps/desktop/release/

Browser mode for working on screens: `npm run dev:server -w @ffgp/server` and `npm run web -w @ffgp/desktop`, then open http://localhost:5180.

## Data
The garage database is one SQLite file: `%APPDATA%\Fleetfix Garage Pro\data\garage.db` on Windows
(`~/Library/Application Support/Fleetfix Garage Pro/data/` on macOS). Money is stored in fils (1 AED = 100 fils).
Issued invoices can't be edited.

## Windows testing
Every push to `main` runs `.github/workflows/windows.yml` on a GitHub Windows machine: unit tests, builds the
installer, installs it silently, and drives the installed app through a full garage day (setup → invoice →
payment → PDF → restart). Each run's screenshots, PDF and installer are under **Actions → run → Artifacts**.
Run it by hand from the Actions tab ("Run workflow") or with `gh workflow run windows.yml`.
