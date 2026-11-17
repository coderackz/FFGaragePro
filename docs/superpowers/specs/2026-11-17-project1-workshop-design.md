# Fleetfix Garage Pro — Project 1: Garage Workshop — Design

## Why
Fleetfix Garage Pro is Fleetfix's garage management system (GMS), sold to independent
garages. Phase 1: each garage runs its whole business on it, standalone. Phase 2: garages in
the Fleet Fix network also receive work from Fleet Fix (job cards in; estimates/invoices back)
inside the same app. The user will refine scope as we go.

## Programme (four projects, built in order)
1. **Workshop** (this doc): logins/roles, customers, vehicles, estimates, job cards, invoices
   with VAT, payments, printing; single PC first, then "main computer" mode for several PCs.
2. Inventory (parts, stock, suppliers, purchasing; parts on jobs draw stock).
3. Accounting (double-entry ledger, expenses, supplier bills, VAT return, reports).
4. Fleetfix Cloud (sync/backup, owner remote view, licensing, phase-2 Fleet Fix work).

## Users and roles (user-specified)
- **Owner** — everything; users, settings, reports, profit.
- **Admin / Accountant** — invoices, payments, (later) expenses, supplier bills, VAT, books.
- **Service advisor** — customers, vehicles, estimates, job cards, parts on jobs, issuing invoices.
Each person has their own login. Proposal: advisors do not see cost/margin or the books.

## Goals (project 1)
- First-run setup: garage profile (name, TRN, address, phone, logo later) + owner account.
- Customers (individual or company, with TRN for B2B tax invoices) and their vehicles
  (plate, make, model, year, VIN, colour, odometer).
- Estimate → approve → job card → invoice, carrying line items forward.
- Line items: type (labour / part / other), description, qty, unit price, discount; 5% VAT.
- Document numbering per garage: EST-00001, JC-00001, INV-00001 (never reused).
- Payments against invoices (cash / card / bank transfer); status unpaid / part-paid / paid.
- Printable/PDF estimate, job card, tax invoice (UAE tax invoice fields; English, Arabic labels optional later).
- Works fully offline.

## Non-goals (project 1)
Stock levels, purchasing, ledger/VAT return, cloud sync, licensing, Mac build polish.

## Anti-goals
Losing or silently altering financial data; rounding errors in money; an issued invoice being
editable (issued invoices are corrected by credit note in project 3, never edited).

## Constraints
- UAE first: AED, 5% VAT, TRN on tax invoices. Money stored as integer fils.
- Windows is the target; developed on macOS (Intel); final checks on a Windows PC/VM.
- Must work with and without internet.
- Phase 2 readiness: every record gets a UUID and created/updated timestamps so it can sync later.

## Approaches (decided)
- **Picked: Electron + React/TypeScript + embedded Node (Fastify) server + SQLite.**
- Rejected: Tauri (Rust server, two languages); .NET/WPF + SQL Server Express (Windows-only,
  heavy per-garage install, no reuse of existing code).

## Architecture
- npm workspaces monorepo:
  - `packages/shared` — Zod schemas, money & VAT math, role permissions, document numbering format.
  - `packages/server` — Fastify HTTP API + SQLite via built-in `node:sqlite` (synchronous; each
    request's writes run in one transaction), plain-SQL migrations, auth (scrypt hashes, session tokens).
  - `apps/desktop` — Electron main (starts the server, opens the window) + React renderer
    (Tailwind, shadcn-style components, TanStack Table, React Hook Form + Zod). Print-to-PDF via Electron.
- The renderer only talks HTTP to the server. On a single PC the server listens on 127.0.0.1.
  **Main-computer mode** (later in project 1): the server listens on the garage network and other
  PCs' apps connect to it by address — no other change needed.
- Ruling (stack change): `node:sqlite` with a small typed SQL layer instead of Drizzle +
  better-sqlite3 — no native module to rebuild between Node and Electron, and real synchronous
  transactions. Cost: `node:sqlite` is still flagged experimental in Node.

## Left to the builder
Screen layouts (clean, dense, desktop-first), exact table columns, colour scheme (neutral with a
Fleetfix accent), PDF template styling.
