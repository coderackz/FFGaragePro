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

Next: Accounting → Fleetfix Cloud
(sync, backup, Fleet Fix work for network garages). See `docs/superpowers/specs/`.

## Layout
| Path | What |
|---|---|
| `packages/shared` | Money/VAT math (integer fils), roles & permissions, document numbering, Zod schemas |
| `packages/server` | Fastify API + SQLite (built-in `node:sqlite`); runs inside the app |
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
