# Fleetfix Garage Pro

Garage management software for independent garages, by Fleetfix.
Windows desktop app; works with or without internet.

**Project 1 — Workshop (milestone 1, done):** first-run garage setup, user logins with roles
(Owner, Admin/Accountant, Service Advisor), customers and vehicles, estimate → job card →
invoice with 5% UAE VAT, tax invoice issuing, payments, print / PDF.

Next: main-computer mode (several PCs on the garage network) → Inventory → Accounting → Fleetfix Cloud
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
    npm run e2e                   # clicks through the whole workflow in Chromium; screenshots in test-results/screens
    npm run e2e:electron          # same workflow in the real desktop app, plus PDF and restart (build first)
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
