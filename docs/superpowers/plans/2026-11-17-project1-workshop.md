# Project 1 (Workshop) — Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working single-PC Fleetfix Garage Pro: setup, logins/roles, customers, vehicles, estimate → job card → invoice with 5% VAT, payments, print/PDF.

**Architecture:** npm-workspaces monorepo. `packages/shared` (pure logic + Zod), `packages/server` (Fastify + `node:sqlite`), `apps/desktop` (Electron + React renderer talking HTTP to the embedded server).

**Tech Stack:** TypeScript, Node ≥22.13 / Electron 45, Fastify 5, node:sqlite, Zod 4, React 19, Vite, Tailwind 4, TanStack Table, React Hook Form, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-project1-workshop-design.md`

## Global Constraints
- Money is integer fils everywhere (`amountFils: number`); format only at display as `AED 1,234.50`.
- VAT rate 5% (`VAT_RATE_BP = 500` basis points), computed per line on the discounted net, rounded half-up to the fil; document totals are sums of line values.
- Document number format: `EST-00001`, `JC-00001`, `INV-00001`; counters per type, never reused.
- All tables: `id TEXT PRIMARY KEY` (UUID v4), `created_at`, `updated_at` (ISO strings).
- Roles: `owner`, `accountant`, `advisor`.
- Issued invoices are immutable (status `issued`/`part_paid`/`paid` → no line edits).
- Server binds `127.0.0.1` in this milestone.

## Review Focus
- Line with 100% discount or qty 0 → zero net, zero VAT, no NaN.
- Converting an estimate twice → second attempt rejected (409), no duplicate job card.
- Payment larger than balance → rejected (400); invoice never goes negative.
- Advisor calling an owner-only endpoint (users, settings) → 403.
- Server restarted mid-sequence → numbering continues, no reuse (counter in DB, incremented inside the insert transaction).

---

### Task 1: Scaffold + shared logic
**Files:** root `package.json` (workspaces), `tsconfig.base.json`, `packages/shared/src/{money,vat,numbering,permissions,schemas,index}.ts`, tests `packages/shared/test/*.test.ts`.
**Produces:** `lineTotals(line: {qty:number; unitPriceFils:number; discountPct:number}) -> {netFils, vatFils, grossFils}`; `docTotals(lines) -> {netFils, vatFils, grossFils}`; `formatAED(fils) -> string`; `parseAED(text) -> number`; `formatDocNumber(type: DocType, n: number) -> string`; `can(role: Role, action: Action) -> boolean`; Zod schemas for every API body.
- [ ] Tests: `lineTotals({qty:2, unitPriceFils:10000, discountPct:10})` → net 18000, vat 900, gross 18900; qty 0 → all 0; discount 100 → all 0; `lineTotals({qty:1, unitPriceFils:1, discountPct:0}).vatFils === 0` (0.05 rounds to 0), `unitPriceFils:10` → vat 1 (0.5 rounds up); qty 1.5 allowed (labour hours); `formatAED(123450)` → `AED 1,234.50`; `parseAED("1,234.5")` → 123450; `formatDocNumber("invoice", 7)` → `INV-00007`; `can("advisor","users.manage") === false`, `can("owner","users.manage") === true`, `can("accountant","payments.record") === true`, `can("advisor","payments.record") === false`.
- [ ] Run `npm test -w @ffgp/shared` → FAIL, implement, → PASS.

### Task 2: Server core (DB, migrations, setup, auth, users)
**Files:** `packages/server/src/{db,migrate,app,auth,routes/setup,routes/users}.ts`, `packages/server/migrations/001_init.sql`, tests `packages/server/test/*.test.ts` (Fastify `inject`, DB in a temp dir).
**Produces:** `buildApp({dataDir}) -> FastifyInstance`; `tx(db, fn)` runs `fn` inside `BEGIN IMMEDIATE…COMMIT`/`ROLLBACK`; endpoints `GET /api/setup/status`, `POST /api/setup` (garage + owner; only once), `POST /api/auth/login` → `{token, user}`, `POST /api/auth/logout`, `GET /api/me`, `GET/POST/PATCH /api/users` (owner only), `GET/PATCH /api/settings` (owner only). Auth header `Authorization: Bearer <token>`.
- [ ] Tests: setup twice → 409; login wrong password → 401; advisor `GET /api/users` → 403; owner creates advisor → advisor can log in; deactivated user can't log in.

### Task 3: Customers and vehicles
**Files:** `packages/server/src/routes/{customers,vehicles}.ts`, migration `002_customers.sql`.
**Produces:** `GET /api/customers?q=` (name/phone/plate search), `POST/PATCH /api/customers`, `GET /api/customers/:id` (with vehicles), `POST/PATCH /api/vehicles`, `GET /api/vehicles?q=`.
- [ ] Tests: create customer + 2 vehicles, search by plate fragment finds customer; duplicate plate for same garage → 409.

### Task 4: Documents and payments
**Files:** `packages/server/src/routes/{documents,payments}.ts`, migration `003_documents.sql` (tables `documents` (type, number, status, customer_id, vehicle_id, odometer, notes, source_id), `document_lines`, `payments`, `counters`).
**Produces:** `GET /api/documents?type=&status=&q=`, `POST /api/documents` (type estimate|jobcard|invoice), `GET /api/documents/:id` (with lines, totals, payments, balance), `PUT /api/documents/:id/lines` (only when editable), `POST /api/documents/:id/convert` (estimate→jobcard, jobcard→invoice), `POST /api/documents/:id/issue` (invoice draft→issued), `POST /api/documents/:id/payments`. Statuses: estimate `draft|sent|approved|converted`, jobcard `open|in_progress|completed|converted`, invoice `draft|issued|part_paid|paid`.
- [ ] Tests: full flow estimate→jobcard→invoice keeps lines and totals; convert twice → 409; edit lines of issued invoice → 409; payment > balance → 400; two payments → `paid`; numbering continues after `buildApp` is rebuilt on the same dataDir.

### Task 5: Desktop shell + setup/login/customers/vehicles screens
**Files:** `apps/desktop/{electron.vite.config.ts, src/main/index.ts, src/preload/index.ts, src/renderer/**}`.
**Produces:** Electron main starts `buildApp({dataDir: app.getPath('userData')})` on a free 127.0.0.1 port, passes the URL to the renderer via preload (`window.ffgp.apiBase`, `window.ffgp.printToPDF(html)`). Renderer: API client with token, setup wizard, login, sidebar layout (Dashboard, Estimates, Job Cards, Invoices, Customers, Vehicles, Settings/Users — hidden by role), customers & vehicles list/detail/forms.
- [ ] Verify: `npm run dev -w @ffgp/desktop` opens; first run shows setup; after setup, login works; customer + vehicle can be created and found by plate. Renderer also runs in a browser against a dev server for Playwright screenshots.

### Task 6: Document screens + printing
**Files:** `apps/desktop/src/renderer/pages/documents/**`, `apps/desktop/src/renderer/print/templates.ts`.
**Produces:** list per type with status filters; editor with line grid (type, description, qty, price, disc %, VAT, total) and live totals from `@ffgp/shared`; convert/issue/payment actions per role; Print → HTML template → PDF saved via `window.ffgp.printToPDF`. Tax invoice shows "TAX INVOICE", garage TRN, customer TRN (if any), invoice number/date, line VAT, totals in AED.
- [ ] Verify: create estimate → approve → convert → complete → invoice → issue → pay; PDF opens and totals match the screen.

### Task 7: Windows installer
- [ ] `electron-builder --win nsis` from macOS produces `FleetfixGaragePro-Setup-<ver>.exe`; build succeeds (runtime test needs a Windows PC/VM).
