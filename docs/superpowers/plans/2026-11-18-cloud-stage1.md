# Fleetfix Cloud — Stage 1 (cloud server, admin, licence, browser app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser-only garages work end to end. Fleet Fix staff create a garage with a setup code; the owner sets it up in a browser and runs the whole garage there, with a 60-day trial, paid-until date, 14-day grace and read-only.

**Architecture:** A new `apps/cloud` Node server owns `admin.db` (garages, staff, audit). For each garage it lazily builds the **existing** `buildApp({ dataDir, cloud: true })` on that garage's own `garage.db`, kept in an LRU cache. The front HTTP server reads `x-ffgp-garage` and hands the raw request to that garage's Fastify instance with `garageApp.routing(req, res)`, so every existing route runs unchanged. The same front server serves the renderer's web build (`/`) and a small admin console (`/admin.html`). The cloud's own JSON API lives at `/api/cloud/*` (licence) and `/admin/api/*` (staff).

**Tech Stack:** Node 24, Fastify 5.12, `node:sqlite`, Zod 4, Vitest, React 19 + Tailwind 4 (Vite multi-page web build), Playwright, plus `@fastify/static`.

**Spec:** `docs/superpowers/specs/2026-11-18-cloud-design.md` (Stage 1 only; sync, number series and the PC "Connect" flow are Stage 2).

## Global Constraints
- **Trial:** 60 days from garage creation.
- **Grace:** 14 days after the trial or paid-until date ends, or after a pause; then read-only.
- **Read-only:** login, logout and every GET still work; every other method under `/api/*` returns `402 {error, code:"read_only"}`.
- **Setup code:** 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, valid 14 days, required in header `x-ffgp-setup-code` on `POST /api/setup`.
- **Garage ID (`garage_code`):** lowercase, `^[a-z0-9][a-z0-9-]{2,39}$`, unique. Input is trimmed and lowercased before use.
- **Garage routing:** every garage API call carries header `x-ffgp-garage: <garage_code>`. Unknown → `404 {code:"unknown_garage"}`.
- **Dev URL:** `http://localhost:4790` (env `PORT`). Data in `apps/cloud/.cloud-data` (env `FFGP_CLOUD_DATA`); each garage at `<data>/garages/<id>/garage.db`.
- **Unchanged:** `packages/server` routes, the Electron app's behaviour and all existing tests (98) stay green.
- **Commits:** end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Garage A's session token sent with garage B's header** → 401, never B's data. Test in Task 3.
2. **Garage ID typed with capitals or spaces** (`" AlQuoz-Auto "`) → treated as `alquoz-auto`. Test in Tasks 1 and 3.
3. **Setup without, or with a wrong or expired, setup code** → 403. A second setup after it's done → 409, as today. Test in Task 3.
4. **A read-only garage:** sign-in and viewing work, every change is refused with 402, sign-out works. Test in Task 3.
5. **A garage evicted from the open-garage cache and used again** works, with no "database is closed" error. Test in Task 3 with the cache size set to 1.

---

### Task 1: Shared licence rules and garage IDs

**Files:**
- Create: `packages/shared/src/cloud.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/cloud.test.ts`

**Interfaces — Produces:**
- `TRIAL_DAYS = 60`, `GRACE_DAYS = 14`, `SETUP_CODE_DAYS = 14`, `GARAGE_HEADER = "x-ffgp-garage"`, `SETUP_CODE_HEADER = "x-ffgp-setup-code"`.
- `normalizeGarageCode(input: string): string | null` trims and lowercases the input, then returns null unless it matches the Garage ID pattern.
- `type GarageStatus = "trial" | "active" | "paused"`.
- `licenceState(g: { status: GarageStatus; trialEndsAt: string; paidUntil: string | null; pausedAt: string | null }, now: Date): { state: "trial" | "active" | "grace" | "read_only"; endsAt: string; graceEndsAt: string }`
  - **End date:** a paused garage ends at `pausedAt`; an active garage at `paidUntil` (an ISO date `YYYY-MM-DD`, ending at that day's 23:59:59+04:00), or at `trialEndsAt` if it has no paid date; a trial garage at `trialEndsAt`.
  - **State:** `now < end` → `trial` or `active`; `now < end + 14 days` → `grace`; otherwise `read_only`.

- [ ] **Step 1:** Write the tests in `cloud.test.ts`:
  - `normalizeGarageCode(" AlQuoz-Auto ") === "alquoz-auto"`;
  - `normalizeGarageCode("ab") === null`;
  - `normalizeGarageCode("-abc") === null`;
  - **trial:** created 2026-01-01T00:00Z with trialEndsAt 2026-03-02T00:00Z (60 days later) is `trial` at 2026-03-01, `grace` at 2026-03-10 and `read_only` at 2026-03-17;
  - **active:** `paidUntil "2026-06-30"` is `active` at 2026-06-30T19:00Z (23:00 Dubai) and `grace` at 2026-06-30T20:30Z;
  - **paused** at 2026-05-01T00:00Z: `grace` at 2026-05-10, `read_only` at 2026-05-16.
- [ ] **Step 2:** Run `npx vitest run packages/shared/test/cloud.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `cloud.ts` and export it from the index.
- [ ] **Step 4:** Run `npx vitest run packages/shared && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit with message `shared: licence state and garage IDs`.

### Task 2: A cloud mode for the garage server

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/cloud-mode.test.ts`

**Interfaces — Produces:**
- **`AppOptions.cloud?: boolean`.** When true:
  - no CORS plugin, because the browser app is served from the same origin;
  - no `deviceGuard`;
  - no `networkRoutes`, since main-computer sharing is meaningless in the cloud.
  - Everything else is the same.

- [ ] **Step 1:** Write the tests:
  - **"cloud mode accepts requests from any address without a device key":** `buildApp({dataDir, cloud:true})`; `inject({method:"GET", url:"/api/setup/status", remoteAddress:"10.0.0.5"})` → 200.
  - **"cloud mode has no network routes":** `GET /api/network` (as owner after setup) → 404.
  - **"local mode still guards":** without `cloud`, the same request from `10.0.0.5` with sharing on and no device key → 401.
- [ ] **Step 2:** Run `npx vitest run packages/server/test/cloud-mode.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit with message `server: cloud mode`.

### Task 3: The cloud server — routing, setup codes and read-only

**Files:**
- Create:
  - `apps/cloud/package.json` (name `@ffgp/cloud`; deps `@ffgp/server`, `@ffgp/shared`, `fastify`, `@fastify/static`, `zod`; scripts `dev: "tsx src/dev.ts"`, `admin:create: "tsx src/admin-create.ts"`);
  - `apps/cloud/tsconfig.json`, copied from `packages/server`;
  - `apps/cloud/src/admin-db.ts`, `src/garages.ts`, `src/server.ts`, `src/dev.ts`.
- Modify: the root `package.json` typecheck script (add `tsc -p apps/cloud`); `.gitignore` (`apps/cloud/.cloud-data`).
- Test: `apps/cloud/test/server.test.ts`, `apps/cloud/test/helpers.ts`

**Interfaces — Produces:**
- **`admin-db.ts`:**
  - `class AdminDb` wraps its own `DatabaseSync` with its own migration list, never the garage migrations.
  - **Tables:**
    - `garages`: id, garage_code UNIQUE, name, status, trial_ends_at, paid_until, paused_at, setup_code, setup_code_expires_at, notes, created_at, updated_at, last_sync_at;
    - `staff`: id, username UNIQUE NOCASE, name, password_hash, active, created_at;
    - `staff_sessions`: token_hash PK, staff_id, expires_at;
    - `audit`: id, staff_id, garage_id, action, detail JSON, at.
  - **Methods:**
    - `garageByCode(code): GarageRow | undefined`, `garageById(id)`;
    - `createGarage({code, name, notes, now}): GarageRow`, which sets the trial end to now + 60 days and creates a new setup code;
    - `newSetupCode(id, now): string`;
    - `updateGarage(id, patch)`;
    - `listGarages(): GarageRow[]`;
    - `addStaff`, `staffLogin(username, password): token | null`, `staffForToken(token)`, `audit(...)`.
  - Passwords use `hashPassword` and `verifyPassword` from `@ffgp/server`. Export those two from `packages/server/src/index.ts`.
- **`garages.ts`:**
  - `class GarageHost(dataDir: string, maxOpen = 50)`;
  - `get(garageId: string): Promise<GarageApp>`, which builds `buildApp({dataDir: <data>/garages/<id>, cloud: true, now})`, awaits `ready()` and caches it;
  - evicting the least recently used garage calls `app.close()`;
  - `closeAll()`.
- **`server.ts`:**
  - `createCloudServer(o: { dataDir: string; webDir?: string; maxOpen?: number; now?: () => number }): Promise<{ server: http.Server; admin: AdminDb; host: GarageHost; close(): Promise<void> }>`.
  - It doesn't listen; `dev.ts` calls `server.listen(PORT ?? 4790)`.
  - `dev.ts` reads env `PORT` (default 4790), `FFGP_CLOUD_DATA` (default `apps/cloud/.cloud-data`) and
    `FFGP_CLOUD_WEB` (`webDir`, default `apps/desktop/dist-web` if it exists). Task 7 adds `FFGP_CLOUD_STAFF`.
  - **Front handler, in order:**
    1. **`/admin/api/*` and `/api/cloud/*`** go to the cloud Fastify app (`cloudApp.routing`); Task 4 fills in its admin routes.
    2. **`/api/*`:**
       - normalise `x-ffgp-garage`; unknown → 404 `{error:"No garage with that ID", code:"unknown_garage"}`;
       - `POST /api/setup` needs a matching, unexpired `x-ffgp-setup-code`, else 403 `{error:"Enter the setup code Fleet Fix gave you", code:"setup_code"}`;
       - when `licenceState(...).state === "read_only"` and the method isn't GET, HEAD or OPTIONS and the path isn't `/api/auth/login` or `/api/auth/logout` → 402 `{error:"This garage's subscription has ended. You can still view and print. Contact Fleet Fix to renew.", code:"read_only"}`;
       - otherwise `(await host.get(id)).routing(req, res)`.
    3. **Anything else** is served from `webDir` by the cloud app (`@fastify/static`, with `index.html` as fallback). With no `webDir` → 404.
  - **`GET /api/cloud/licence`** (needs `x-ffgp-garage`) → `{garage:{code,name}, state, endsAt, graceEndsAt, daysLeft}`.
- **`test/helpers.ts`:** `startCloud(opts?)`, which listens on port 0 and returns `{url, admin, close}`; `api(url, method, path, {garage?, token?, setupCode?, body?})`, which returns `{status, body}`.

- [ ] **Step 1:** Write the tests in `server.test.ts`. Garages are created with `admin.createGarage` directly; Task 4 adds the HTTP admin.
  - **"setup needs the setup code; then the garage works in the browser API":**
    - POST `/api/setup` with no code → 403;
    - with a wrong code → 403;
    - with the right code → 200 and a token;
    - a second setup → 409;
    - customers and job-card calls with that token and garage → 200.
  - **"an expired setup code is refused":** move `now` past 14 days → 403.
  - **"garage ID is case- and space-insensitive":** header `" AlQuoz-Auto "` reaches `alquoz-auto`.
  - **"unknown garage"** → 404 with `code:"unknown_garage"`.
  - **"a token from garage A doesn't work on garage B":** set up A and B; A's token with header B on `/api/customers` → 401; then create a customer in A and check that B's list is empty.
  - **"read-only after trial + grace":** `now` = creation + 75 days:
    - login → 200;
    - GET `/api/customers` → 200;
    - POST `/api/customers` → 402 `read_only`;
    - logout → 200;
    - `/api/cloud/licence` → `state:"read_only"`.
  - **"evicted garages reopen":** `maxOpen: 1`; alternate requests between A and B five times → all 200.
- [ ] **Step 2:** Run `npx vitest run apps/cloud`. Expected: FAIL.
- [ ] **Step 3:** Run `npm install` for the new workspace, then implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5:** Commit with message `cloud: per-garage server, setup codes, read-only`.

### Task 4: Fleet Fix admin API and first staff account

**Files:**
- Create: `apps/cloud/src/admin-routes.ts`, `apps/cloud/src/admin-create.ts`
- Modify: `apps/cloud/src/server.ts` (register the admin routes on the cloud app)
- Test: `apps/cloud/test/admin.test.ts`

**Interfaces — Produces** (all need `Authorization: Bearer <staff token>` except login):
- `POST /admin/api/login {username, password}` → `{token, staff:{name}}`; a wrong password → 401.
- `GET /admin/api/garages` → `{garages: [{id, code, name, status, state, endsAt, graceEndsAt, trialEndsAt, paidUntil, setUp: boolean, setupCode (only while not set up), setupCodeExpiresAt, userCount, lastSyncAt, createdAt}]}`.
  - `setUp` and `userCount` are read from the garage's database through `host`.
- `POST /admin/api/garages {code, name, notes?}` → `{garage}` with its setup code. A bad code → 400 with the pattern explained; a duplicate → 409.
- `PATCH /admin/api/garages/:id {paidUntil?: "YYYY-MM-DD" | null, status?: "active" | "paused", name?, notes?}`:
  - setting `paidUntil` sets status `active`;
  - `status:"paused"` sets `pausedAt = now`;
  - `status:"active"` clears `pausedAt`.
- `POST /admin/api/garages/:id/setup-code` → a new code. Once the garage is set up → 409.
- `POST /admin/api/garages/:id/reset-owner-password` → `{username, temporaryPassword}` (12 characters). It updates the first active owner in the garage's database, so the owner signs in and changes it.
- Every write adds an `audit` row.
- `admin-create.ts`: `npm run admin:create -w @ffgp/cloud -- <username> "<name>" <password>` adds a staff account to `admin.db`.

- [ ] **Step 1:** Write the tests:
  - **"staff create a garage and see it awaiting setup":** after login, POST creates `alquoz-auto` → the list shows `state:"trial"`, `setUp:false`, an 8-character `setupCode` and `trialEndsAt` = created + 60 days.
  - **"set up garage shows users, hides code":** after the browser setup through `/api/setup` → the list shows `setUp:true`, `userCount:1`, and no `setupCode`.
  - **"paid until and pause":**
    - PATCH `paidUntil` → `state:"active"`;
    - PATCH `status:"paused"` with `now` + 15 days → `read_only`;
    - PATCH `status:"active"` → `active`.
  - **"reset owner password":** returns a temporary password; garage login with it → 200; with the old password → 401.
  - **"no staff token"** → 401 on every `/admin/api` route except login.
  - **"bad and duplicate garage IDs"** → 400 and 409.
- [ ] **Step 2:** Run `npx vitest run apps/cloud/test/admin.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit with message `cloud: Fleet Fix admin API`.

### Task 5: Browser app in cloud mode

**Files:**
- Modify:
  - `apps/desktop/src/renderer/lib/api.ts`;
  - `lib/auth.tsx`;
  - `App.tsx`;
  - `pages/SetupPage.tsx`, `pages/LoginPage.tsx`;
  - `components/Layout.tsx` (the licence banner);
  - `env.d.ts`;
  - `apps/desktop/vite.web.config.mts`;
  - `apps/desktop/package.json` (script `web:cloud: "vite build --config vite.web.config.mts --mode cloud"`, output `apps/desktop/dist-web`).
- Create: `apps/desktop/src/renderer/pages/GaragePage.tsx`, `apps/desktop/.env.cloud` (`VITE_FFGP_CLOUD=1`, `VITE_API_BASE=`)

**Interfaces:**
- **`lib/api.ts`:**
  - `export const isCloud = import.meta.env.VITE_FFGP_CLOUD === "1"`;
  - `getGarageCode()` and `setGarageCode(code | null)`, stored in localStorage `ffgp.garage`;
  - `api()` adds the `x-ffgp-garage` header when `isCloud`;
  - `setupCode` is passed through an optional `headers` argument on `post`.
- **`lib/auth.tsx`:**
  - new phase `{ phase: "garage"; error?: string }`, entered when `isCloud` and there is no stored garage code, or when a response carries `code:"unknown_garage"`;
  - `chooseGarage(code)` stores the code and reloads;
  - `licence` state comes from `GET /api/cloud/licence` after sign-in;
  - `can(action)` returns false for every action except `reports.view` and `costs.view` while `licence.state === "read_only"`.
- **`GaragePage`:** a "Garage ID" field and a Continue button. Below it: "Your garage ID is in the welcome email from Fleet Fix."
- **`SetupPage`** in cloud mode adds a "Setup code" field, sent as `x-ffgp-setup-code`.
- **`LoginPage`** in cloud mode shows "Garage: alquoz-auto · Change".
- **`Layout` banner:**
  - `trial` in its last 14 days → "Trial ends in N days";
  - `grace` → amber "Subscription ended — N days left to renew";
  - `read_only` → red "Read-only: subscription ended. Contact Fleet Fix to renew."
- **`DocumentPage`:** `editable` becomes false when read-only.
- **`vite.web.config.mts`:** multi-page build with inputs `index.html` and `admin.html` (Task 6 adds `admin.html`), `build.outDir = ../../dist-web`.

- [ ] **Step 1:** Run `npm run typecheck`. Expected: PASS.
- [ ] **Step 2:** Build with `npm run web:cloud -w @ffgp/desktop`. Run `FFGP_CLOUD_WEB=apps/desktop/dist-web npm run dev -w @ffgp/cloud`, create a garage with a quick script against `/admin/api`, then check by eye in a browser at `http://localhost:4790`:
  - the Garage ID screen;
  - setup with the code;
  - the dashboard;
  - a job card with a part;
  - a print preview.
- [ ] **Step 3:** Commit with message `desktop: browser app in cloud mode`.

### Task 6: Admin console screens

**Files:**
- Create: `apps/desktop/src/renderer/admin.html`, `apps/desktop/src/renderer/admin/main.tsx`, `admin/AdminApp.tsx`
- Modify: `apps/desktop/vite.web.config.mts`

**Behaviour:**
- **Sign in** with Fleet Fix staff credentials (token in sessionStorage `ffgp.admin`).
- **Garages table:** Garage ID, Name, Status (badge: Trial / Active / Grace / Read-only / Paused), Ends, Users, Set up (yes, or the code with its expiry and a Copy button).
- **"New garage"** dialog: Garage ID and Name. It then shows the setup code and a ready-to-send line: "Garage ID: alquoz-auto · Setup code: K7QM2XPA · Open http://localhost:4790".
- **Row dialog:** set paid-until (date), Pause / Reactivate, New setup code, Reset owner password (shows the temporary password once).
- Reuse `components/ui.tsx` and the Fleet Fix brand header.

- [ ] **Step 1:** Implement, then run `npm run typecheck`. Expected: PASS.
- [ ] **Step 2:** Build with `npm run web:cloud -w @ffgp/desktop`, open `http://localhost:4790/admin.html` and check by eye: sign in, create a garage, set paid-until, pause, reset password.
- [ ] **Step 3:** Commit with message `admin console`.

### Task 7: End-to-end in the browser, README

**Files:**
- Create: `playwright.cloud.config.ts`, `apps/desktop/test/cloud.spec.ts`
- Modify:
  - `apps/desktop/test/flow.ts`: `setUpGarage(page, shot?, opts?: { setupCode?: string })` fills "Setup code" when given, and `garageDay(page, shot, opts?)` passes `opts` to it;
  - the root `package.json` (scripts `cloud: "npm run web:cloud -w @ffgp/desktop && npm run dev -w @ffgp/cloud"` and `e2e:cloud: "playwright test -c playwright.cloud.config.ts"`);
  - `README.md`.

- **Config:** `webServer` builds the web app and starts the cloud on port 4791 with a fresh temp data dir; `baseURL http://localhost:4791`.
- **`cloud.spec.ts`:**
  - **"cloud garage day":**
    1. Create a staff account with `admin.create` through the CLI script before the server starts (via env `FFGP_CLOUD_STAFF=fleetfix:Fleet Fix Admin:admin-pass-1`, read by `dev.ts`).
    2. In `/admin.html`: sign in, create `alquoz-auto`, read the setup code from the screen.
    3. At `/`: enter Garage ID `AlQuoz-Auto` (garageDay then sets up with the code).
    4. Run `garageDay(page, shot, { setupCode })`, then `stockDay`.
    5. Screenshot `cloud-*`.
  - **"wrong garage ID":** "nope-garage" → "No garage with that ID".
- [ ] **Step 1:** Run `npm run e2e:cloud`. Expected: PASS.
- [ ] **Step 2:** Run `npm test && npm run typecheck && npm run e2e`. Expected: all PASS (desktop unaffected).
- [ ] **Step 3:** README: a "Fleetfix Cloud (development)" section with `npm run cloud`, `admin:create`, the URLs, and what Stage 2 adds.
- [ ] **Step 4:** Commit with message `e2e: cloud garage day; README cloud`.
