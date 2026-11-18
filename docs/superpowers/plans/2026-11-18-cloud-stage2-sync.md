# Fleetfix Cloud — Stage 2 (sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PC garage links to its Fleetfix Cloud garage. Edits on the PC (online or offline) and in the browser merge both ways. An offline PC issues numbers from its own series. The PC checks its licence at least every 30 days.

**Architecture:**
- **Change capture:** SQLite triggers in every garage database write a `change_log`. The trigger SQL is generated from the table definitions, so routes don't change.
- **Merging:**
  - The cloud applies a PC's pushed changes field by field. Arrival order counts as "latest wins".
  - The PC applies the cloud's rows in full, except fields it changed and hasn't pushed yet.
  - Derived values (stock on hand, average cost, document totals, paid amounts) are recomputed, never merged.
- **First link:** whole database files move once, as a snapshot download (new PC) or upload (existing PC garage into an empty cloud garage). After that, only change logs move.
- **Engine:** `packages/sync` holds it, as pure functions over `Db`, used by the cloud and the Electron main process.

**Tech Stack:** Node 24 `node:sqlite` (triggers, `VACUUM INTO`), Node `crypto` Ed25519, Fastify 5, Vitest, Electron 45, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-cloud-design.md` (Sync, Numbering, PC app changes). Stage 1 is on main.

## Global Constraints
- **Synced tables:**
  - garage, users, customers, vehicles;
  - documents, document_lines, payments;
  - parts, suppliers, purchase_orders, po_lines, goods_receipts, goods_receipt_lines, stock_movements;
  - settings, except keys starting `network.` (device-local).
- **Never synced:** sessions, devices, counters, schema_migrations, and the sync tables themselves.
- **Insert-only tables** (never conflict): stock_movements, payments, goods_receipts, goods_receipt_lines.
- **Derived columns** (excluded from captured changes, recomputed after applying):
  - `parts.on_hand` and `parts.avg_cost_fils`;
  - `documents.net_fils`, `vat_fils`, `gross_fils` and `paid_fils`;
  - `purchase_orders.net_fils` and `purchase_orders.version`.
- **document_lines** sync as a **set per document**: the later save of a document's lines wins as a whole.
- **Issued invoices are frozen:** a change to an invoice (or its lines) that is not `draft` on the receiving side is refused and recorded as a sync issue. Payments are only added.
- **Unique clashes** (vehicles.plate, users.username, active parts.part_no): keep the first one received and rename the incoming one with ` (2)` (then ` (3)` and so on). The rename is recorded as the receiving side's own change, so it reaches the origin, and a sync issue is recorded.
- **Numbers:**
  - online: the cloud's main series (`INV-00012`);
  - offline linked PC: its device series (`INV-P1-00003`);
  - a never-linked PC: unchanged.
- **Sync loop:** push then pull, in pages of at most 500 entries, every 30 s while linked, and within 5 s of a local change.
- **Licence:** an Ed25519-signed token on every sync. The PC is read-only past grace, or when 30 days have passed since the last successful check.
- **Schema versions must match** for push and pull. Otherwise `409 {code:"update_app"}` (PC older) or `{code:"update_cloud"}`.
- **The cloud URL** is a setting, default `http://localhost:4790`.
- **Unchanged:** the existing 130 tests and the e2e suites stay green, and never-linked PCs behave exactly as today.
- **Commits:** end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **The connection drops after a push succeeded but before the pull:** the next sync neither applies anything twice nor loses anything. Test in Task 5.
2. **The same customer edited in two places:**
   - PC offline changes the phone while the browser changes the name: both changes are kept.
   - Both change the name: the later arrival at the cloud wins.

   Test in Task 3 (engine) and Task 5 (end to end).
3. **Both sides add plate `DXB A 1` while offline:** both end with `DXB A 1` and `DXB A 1 (2)`, identical on both sides, plus one sync issue. Test in Task 3 and Task 5.
4. **A draft invoice issued in the browser while the offline PC edits its lines:** after sync, both sides show the issued invoice with the browser's lines, and the PC has a sync issue. Test in Task 3.
5. **The cloud updated but the PC app not (schema mismatch):** sync stops with "Update Fleetfix Garage Pro to keep syncing" and the PC keeps working offline. Test in Task 4 and Task 5.

---

### Task 1: Number series

**Files:**
- Modify:
  - `packages/server/src/migrations.ts` (migration 5; the runner supports `{ foreignKeysOff: true }`);
  - `packages/shared/src/rules.ts`;
  - `packages/server/src/app.ts`;
  - `packages/server/src/routes/documents.ts`, `routes/purchases.ts`.
- Test: `packages/server/test/series.test.ts`, `packages/shared/test/rules.test.ts`

**Interfaces — Produces:**
- **Migration runner:** a migration flagged `foreignKeysOff` runs outside a transaction as `PRAGMA foreign_keys=OFF; BEGIN; …; COMMIT; PRAGMA foreign_key_check; PRAGMA foreign_keys=ON`. It throws if the check returns rows.
- **Migration 5:**
  - rebuilds `documents` with `series TEXT NOT NULL DEFAULT ''` and `UNIQUE (type, series, seq)` instead of `UNIQUE (type, seq)`;
  - rebuilds `purchase_orders` with `series` and `UNIQUE (series, seq)`;
  - keeps every column, index and the `documents_one_conversion` index.
- **Number formats:**
  - `formatDocNumber(type, seq, series = "")` → `INV-00012`, or `INV-P1-00003` when there is a series;
  - `formatPoNumber(seq, series = "")` likewise.
- **`AppOptions.numbers?`:** `{ next(kind: DocType | "purchase_order"): Promise<{ series: string; seq: number } | null>; offlineSeries: string }`.
  - Routes that create documents or POs call `next()` **before** `db.tx`.
  - `null` (or no `numbers` option) uses the local counter: main series when there is no `offlineSeries`, otherwise `offlineSeries` with counter key `${kind}@${series}`.
  - With no option, behaviour is exactly as today.

- [ ] **Step 1:** Write the tests:
  - **"offline series numbers separately and never clashes":**
    - `numbers.next` returns null and `offlineSeries` is `P1`: two invoices get `INV-P1-00001` and `INV-P1-00002`, with `series:"P1"`;
    - `next` returning `{series:"",seq:12}` gives `INV-00012`;
    - an invoice `INV-00001` and `INV-P1-00001` coexist.
  - **"existing databases migrate":** a database built at migration 4 with documents, lines, payments and POs → after migrating, the rows, the foreign keys and the conversion uniqueness all hold. `PRAGMA foreign_key_check` is empty.
  - **Shared:** `formatDocNumber("invoice", 3, "P1") === "INV-P1-00003"`.
- [ ] **Step 2:** Run `npx vitest run packages/server/test/series.test.ts packages/shared`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5:** Commit with message `server: number series and offline numbering`.

### Task 2: Change capture

**Files:**
- Create: `packages/sync/package.json` (`@ffgp/sync`, deps `@ffgp/server`, `@ffgp/shared`), `packages/sync/tsconfig.json`, `packages/sync/src/capture.ts`, `src/tables.ts`, `src/index.ts`
- Modify:
  - `packages/server/src/migrations.ts` (migration 6: the sync tables);
  - the root typecheck script (`tsc -p packages/sync`).
- Test: `packages/sync/test/capture.test.ts`, `packages/sync/test/helpers.ts`

**Interfaces — Produces:**
- **Migration 6 (sync tables):**
  - `change_log`: seq INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, origin_seq INTEGER, table_name, row_id, op `insert|update|delete|set`, data JSON (the whole row; for `set`, an array of rows), changed JSON (array of column names, update only), at TEXT. Plus `UNIQUE(origin, origin_seq)` where origin_seq is not null.
  - `sync_ctx`: a single row with `origin TEXT NOT NULL DEFAULT 'local'` and `origin_seq INTEGER`.
  - `sync_state`: key PK, value — for last_pushed_seq, last_pulled_seq, licence and similar.
  - `sync_issues`: id, at, kind `unique_rename|frozen_invoice|apply_failed`, table_name, row_id, message, detail JSON, dismissed_at.
  - `sync_peers`: device_code PK, last_origin_seq (cloud only).
- **`tables.ts`:** `SYNC_TABLES: { name, insertOnly?: boolean, derived?: string[], key: "id" | "document_id" }[]` with the lists from Global Constraints. `garage` and `settings` use their primary key (`id` and `key`).
- **`capture.ts`:**
  - `installCapture(db: Db, origin: "local" | "cloud"): void` (re-)creates the triggers from `PRAGMA table_info`, so a later migration that adds a column only needs a re-install, and sets `sync_ctx.origin`.
  - It is idempotent and safe to run at every start.
  - Each synced table except document_lines gets AFTER INSERT, UPDATE and DELETE triggers. They write `origin`/`origin_seq` from `sync_ctx`, and `data = json_object(...)` with all non-derived columns.
  - The UPDATE trigger fires only when a non-derived column changed (`WHEN OLD.a IS NOT NEW.a OR …`). Its `changed` is the list of non-derived columns that changed.
  - document_lines triggers write op `set`, `row_id = document_id`, `data =` the json_group_array of that document's lines (ordered by position).
  - `settings` triggers skip keys starting `network.`.
- `removeCapture(db)` drops the triggers (used by a never-linked PC to stay as today).
- **Exports:** `localChanges(db, afterSeq: number, limit = 500): ChangeEntry[]` (origin = this database's own origin) and `type ChangeEntry = { seq; origin; originSeq; table; rowId; op; data; changed; at }`.

- [ ] **Step 1:** Write the tests in `capture.test.ts`. Build a garage with `buildApp`, set it up, then `installCapture(app.db, "local")`.
  - **"creating a customer logs an insert with the whole row".**
  - **"editing only the phone logs an update with changed ['phone','updated_at']".**
  - **"a stock movement logs the movement insert but no update of parts.on_hand/avg_cost".** The parts row is logged only if a non-derived column changed.
  - **"saving a job card's lines logs `set` entries whose last data equals the saved lines".**
  - **"network.* settings are not logged".**
  - **"re-installing is harmless"** (no duplicate entries).
  - **"entries written while sync_ctx.origin is 'P1' carry origin 'P1'".**
- [ ] **Step 2:** Run `npx vitest run packages/sync`. Expected: FAIL.
- [ ] **Step 3:** Implement. Run `npm install` for the new workspace.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit with message `sync: change capture`.

### Task 3: Applying changes (merge engine)

**Files:**
- Create: `packages/sync/src/apply.ts`, `packages/sync/src/recompute.ts`
- Test: `packages/sync/test/apply.test.ts`

**Interfaces — Produces:**
- `recomputePart(db, partId)`: `on_hand` = round3(Σ qty). `avg_cost_fils` replays the part's movements in `created_at, rowid` order: incoming movements that carry a cost use `averageCost`, and outgoing movements keep their stored cost.
- `recomputeDocument(db, docId)`: totals from lines. For an invoice, also `paid_fils` from payments, and status `part_paid`/`paid`/`issued` when it isn't a draft.
- `applyAtCloud(db, from: string, entries: ChangeEntry[]): { applied: number; lastOriginSeq: number; issues: number }`:
  - runs in one transaction;
  - skips entries with `originSeq <= sync_peers.last_origin_seq` for that origin;
  - sets `sync_ctx` to (from, originSeq) for each entry, so the cloud's log records it for other devices, then resets it to `cloud`.
  - **insert:** insert the row. If it already exists, treat it as an update of every field.
  - **update:** apply only the `changed` columns onto the current row. A missing row is treated as an insert, from the data.
  - **delete:** delete if present.
  - **set:** replace the document's lines.
  - **Frozen invoices:** refused when the target invoice's local status isn't `draft`, with these exceptions: an update whose changed columns include `status` to `issued`, `issued_at` or `updated_at` is applied; payments are always applied. Refusals are recorded in `sync_issues`.
  - **Unique clashes:** the incoming row is renamed as Global Constraints says. An extra update with `sync_ctx` origin `cloud` is written, so the rename reaches the origin.
  - **Afterwards:** recompute the parts touched by stock_movements, and the documents touched by lines or payments.
  - **Foreign-key failures:** issue kind `apply_failed`; the entry is skipped and doesn't block the rest.
- `applyAtPc(db, entries: ChangeEntry[]): { applied: number; lastSeq: number; issues: number }` applies cloud entries with `sync_ctx` origin `cloud`:
  - updates replace the whole row, **except** columns that have a local `change_log` entry (origin `local`) with seq above `sync_state.last_pushed_seq`; those keep the local value and are pushed next time;
  - `set` entries are skipped when the document has an unpushed local `set`;
  - frozen-invoice, unique and recompute rules as at the cloud;
  - returns the highest cloud seq applied.

- [ ] **Step 1:** Write the tests in `apply.test.ts`. Two databases A (pc) and C (cloud) start from the same snapshot (helper `twin()` copies a garage file with `VACUUM INTO`). Install capture on both (`local` and `cloud`).
  - **"different fields of one customer both survive"** (Review Focus 2).
  - **"same field: the later push wins at the cloud; the PC keeps an unpushed local edit".**
  - **"same plate added on both sides offline → `(2)` on the incoming one, one sync issue, the rename logged as the cloud's own change"** (Review Focus 3).
  - **"lines of an invoice issued at the cloud are not replaced by an offline PC's edit; a sync issue is recorded"** (Review Focus 4).
  - **"stock: movements from both sides → on_hand and avg_cost recomputed identically on both"** (A takes 2 filters; C receives 5 at a new cost).
  - **"payments from both sides add up; the invoice status becomes paid".**
  - **"applying the same batch twice changes nothing"** (idempotent through sync_peers).
  - **"a line whose part never arrived is skipped as apply_failed and the rest applies".**
- [ ] **Step 2:** Run `npx vitest run packages/sync/test/apply.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `sync: merge engine`.

### Task 4: Cloud sync API, devices and the licence token

**Files:**
- Create: `apps/cloud/src/sync-routes.ts`, `apps/cloud/src/licence-token.ts`
- Modify:
  - `apps/cloud/src/admin-db.ts` (migration 2: `devices` = id, garage_id, device_code, name, key_hash UNIQUE, created_at, last_sync_at, revoked_at);
  - `apps/cloud/src/garages.ts`: garage apps get `installCapture(db,"cloud")` after build;
  - `apps/cloud/src/server.ts`;
  - `apps/cloud/src/admin-routes.ts` (garage list `lastSyncAt` comes from devices).
- Test: `apps/cloud/test/sync-api.test.ts`

**Interfaces — Produces:**
- **`licence-token.ts`:**
  - `loadOrCreateKey(dataDir)` keeps an Ed25519 key in `<data>/licence-key.pem`;
  - `signLicence(key, payload: { garageId: string; garageCode: string; state; endsAt; graceEndsAt; checkedAt: string })` returns `base64url(json).base64url(sig)`;
  - `verifyLicence(publicKeyPem, token): payload | null` lives in `packages/sync/src/licence.ts`, so the PC uses it too.
- **Routes**, all under `/api/cloud/sync/` with header `x-ffgp-garage`. After linking they need `x-ffgp-device-key`; a wrong or revoked key → 401 `{code:"device_not_linked"}`.
  - **`POST link {mode:"download", username, password, deviceName}`:**
    - the user must exist in the garage database, be active, and the password must match (the garage's login throttle applies);
    - the garage must be set up, otherwise 409.
  - **`POST link {mode:"upload", setupCode, deviceName}`:** the garage must not be set up and the setup code must be valid.
  - **Both link modes** return `{deviceCode:"P<n>", deviceKey, publicKey, licence: token, schema}`.
  - **`GET snapshot`:** the garage database via `VACUUM INTO` a temp file, as `application/octet-stream`, with header `x-ffgp-sync-seq` = the cloud's max change_log seq at the snapshot.
  - **`PUT upload`** (octet-stream, body limit 200 MB; allowed only for the device that linked with `upload`, and only while the garage isn't set up). The cloud:
    - closes the garage app;
    - writes the file;
    - clears `change_log`, `sync_peers` and `sync_issues` and sets `sync_ctx` to `cloud`;
    - re-opens the garage, and clears the setup code.
    - It returns `{ seq: 0 }`.
  - **`POST push {schema, entries}`** → `applyAtCloud`, then returns `{lastOriginSeq, receivedAt, licence}`.
  - **`GET pull?since=&limit=500`** → `{entries, more, licence}`, excluding the device's own origin.
  - **`POST numbers {kind}`** → `{series:"", seq}` from the cloud garage's own counters, inside its transaction.
- **Common to these routes:**
  - Every push and pull updates `devices.last_sync_at` and `garages.last_sync_at`.
  - A schema mismatch (the garage database's max migration id against `schema`) → 409, as in Global Constraints.
  - **Read-only:** push is still accepted (the PC stays read-only on its own), but `numbers` → 402.

- [ ] **Step 1:** Write the tests:
  - **"download link needs a real user":** a wrong password → 401; the right one → a device code `P1`, then `P2` for the next PC.
  - **"upload link needs the setup code and an empty garage".**
  - **"snapshot is a working garage database".** Open it with `new Db(path)`, and the customers are there.
  - **"upload replaces the empty garage; browser sign-in then works with the PC's users".**
  - **"push/pull round trip, own entries excluded".**
  - **"schema mismatch → 409 update_app"** (Review Focus 5).
  - **"licence token verifies with the returned public key; tampering fails".**
  - **"revoked device → 401".**
  - **"numbers come from the cloud's main series and continue after browser-created invoices".**
- [ ] **Step 2:** Run `npx vitest run apps/cloud/test/sync-api.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit with message `cloud: sync API, devices, licence tokens`.

### Task 5: PC sync client

**Files:**
- Create:
  - `packages/sync/src/client.ts`;
  - `packages/sync/src/licence.ts`;
  - `packages/server/src/routes/sync-issues.ts` (`GET /api/sync-issues`, `POST /api/sync-issues/:id/dismiss`, Owner only).
- Modify: `packages/server/src/app.ts` (register the sync-issue routes).
- Test: `packages/sync/test/client.test.ts`, which runs a real cloud (`createCloudServer`) and a "PC" `buildApp` in the same process.

**Interfaces — Produces:**
- **`interface CloudLink`:** `{ url: string; garageCode: string; deviceCode: string; deviceKey: string; publicKey: string }`.
- **`linkDownload(o: { url, garageCode, username, password, deviceName, dataDir }): Promise<CloudLink>`:**
  - links;
  - writes the snapshot over `<dataDir>/garage.db`, before the local app has opened it;
  - sets `last_pulled_seq` to the snapshot seq;
  - installs capture (`local`).
- **`linkUpload(o: { url, garageCode, setupCode, deviceName, db }): Promise<CloudLink>`:**
  - links;
  - `VACUUM INTO` a temp file and uploads it;
  - installs capture;
  - sets `last_pushed_seq` to the current max local seq and `last_pulled_seq` to 0.
- **`class SyncClient(db: Db, link: CloudLink, o: { fetch?, now? })`:**
  - `syncOnce(): Promise<SyncResult>`, where `SyncResult = { ok: true; pushed; pulled; issues } | { ok: false; reason: "offline" | "update_app" | "update_cloud" | "not_linked" | "error"; message }`.
  - **Order:** push all pages, store `last_pushed_seq` only after each page succeeds, then pull pages with `applyAtPc` and store `last_pulled_seq`, and store the licence token from every response.
  - `status(): { linked, lastSyncAt, pending: number, licence: LicenceView | null, readOnly: boolean, issues: number }`.
  - `numbers(): AppOptions["numbers"]` tries `POST numbers` with a **2 s timeout**, else null; `offlineSeries` = deviceCode.
- **`licenceView(token, publicKey, now)` → `{ state, endsAt, graceEndsAt, checkedAt, readOnly }`:**
  - readOnly when the state is `read_only`, or now > graceEndsAt, or now − checkedAt > 30 days;
  - a bad signature also counts as readOnly, so a tampered file can't extend the licence.
- **`readOnlyGuard(client)`** → an `AppOptions.guard` with the same rule as the cloud's (writes except login and logout → 402 `read_only`) while `status().readOnly`.

- [ ] **Step 1:** Write the end-to-end tests in `client.test.ts`. The "cloud" is set up in the browser API; the "PC" uses `linkDownload` unless stated.
  - **"PC and browser edits meet":**
    - the PC creates a customer → after sync the browser API lists it;
    - the browser renames it → after sync the PC has the new name.
  - **"offline PC numbers from its own series and syncs later":**
    - the cloud is stopped, so `fetch` throws;
    - an invoice is created through the PC app with `numbers()` → `INV-P1-00001`;
    - the cloud is started again → after sync the browser lists `INV-P1-00001`;
    - a browser invoice is `INV-00001`.
  - **"push succeeded, pull failed → next sync applies nothing twice"** (Review Focus 1). Inject a fetch that fails the first pull. Then the counts are exact: one customer, not two.
  - **"same plate offline on both sides → both sides end identical with `(2)`"** (Review Focus 3).
  - **"existing PC garage uploads into an empty cloud garage; browser sign-in works with the PC owner's password".**
  - **"PC older than cloud → update_app, and the PC still saves locally"** (Review Focus 5).
  - **"licence: 31 days without a check → read-only guard returns 402; a fresh token lifts it; a tampered token is read-only".**
- [ ] **Step 2:** Run `npx vitest run packages/sync/test/client.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit with message `sync: PC client, licence check, sync issues`.

### Task 6: PC app — Connect, sync loop, Cloud settings

**Files:**
- Create:
  - `apps/desktop/src/main/cloud.ts`;
  - `apps/desktop/src/renderer/components/CloudCard.tsx`, `components/CloudConnectDialog.tsx`;
  - `apps/desktop/src/renderer/components/SyncIssues.tsx`.
- Modify:
  - `apps/desktop/src/main/index.ts`: config `cloud?: CloudLink`. When linked, start the server with `numbers` and `guard` from the SyncClient; only a `local` or `main` PC syncs, never a `client`.
  - `apps/desktop/src/preload/index.ts` and `env.d.ts`: bridge `cloudStatus()`, `cloudLink(args)`, `cloudSyncNow()`, `cloudUnlink()`, and the event `ffgp:cloud-status`.
  - `pages/SettingsPage.tsx` (CloudCard for Owners); `pages/SetupPage.tsx` ("Connect to Fleetfix cloud" next to "Connect to main computer"); `components/Layout.tsx` (read-only banner from the PC licence too); `apps/desktop/package.json` (dep `@ffgp/sync`).

**Behaviour:**
- **`cloud.ts`:**
  - links, starts, stops and restarts the local server around a download (the download replaces `garage.db` while the server is stopped);
  - runs the loop: `syncOnce` every 30 s, plus within 5 s of a local change (poll `MAX(seq)` every 5 s), with back-off up to 5 minutes while offline;
  - sends status to the window;
  - **Unlink:** stops the loop, removes `config.cloud` and `removeCapture`, and keeps the data.
- **Connect dialog:**
  - fields: cloud address (default `http://localhost:4790`), garage ID, and this PC's name;
  - **first-run (no data):** username and password → download, then the sign-in screen;
  - **from Settings (has data):** the setup code → upload. The dialog explains: "Your garage's data will be copied to Fleetfix cloud. The cloud garage must be new."
- **Cloud card:**
  - Linked to `alquoz-auto` as P1;
  - Last sync, with "Sync now";
  - "N changes waiting" when offline;
  - Licence until or read-only;
  - "Disconnect from cloud";
  - an error line for `update_app`: "Update Fleetfix Garage Pro to keep syncing".
- **Sync issues** list: what happened, what was kept, Dismiss. Also shown in the browser's Settings.

- [ ] **Step 1:** Implement, then run `npm run typecheck`. Expected: PASS.
- [ ] **Step 2:** Run `npm run build -w @ffgp/desktop && npm run e2e:electron`. Expected: the existing tests PASS, so never-linked PCs are unchanged.
- [ ] **Step 3:** Commit with message `desktop: connect to Fleetfix cloud, sync loop, cloud settings`.

### Task 7: End-to-end PC ↔ cloud, README

**Files:**
- Create: `apps/desktop/test/cloud-sync.spec.ts`, `playwright.sync.config.ts`
- Modify: the root `package.json` (script `e2e:sync`), `README.md`

- **Config:** a `webServer` builds the web app and starts the cloud on port 4792 with a fresh data folder and `FFGP_CLOUD_STAFF`. The tests launch the Electron app with `launchApp` and `FFGP_USER_DATA` temp folders.
- **"a new PC downloads the cloud garage and edits meet both ways":**
  1. Admin creates the garage; the browser sets it up and adds customer A.
  2. Electron first-run → Connect to Fleetfix cloud (`http://localhost:4792`, `alquoz-auto`, `rashid`) → sign in.
  3. The PC sees customer A and adds customer B; Sync now.
  4. The browser sees B.
  5. Screenshots `sync-*`.
- **"an existing PC garage uploads":** an Electron garage set up locally (with `setUpGarage`) → Settings → Connect with the setup code → the browser signs in as the PC owner and sees its customers.
- [ ] **Step 1:** Run `npm run e2e:sync`. Expected: PASS.
- [ ] **Step 2:** Run `npm test && npm run typecheck && npm run e2e && npm run e2e:cloud && npm run e2e:electron`. Expected: all PASS.
- [ ] **Step 3:** README: Stage 2 in the cloud section — what syncs, the merge rules in plain words, `npm run e2e:sync`.
- [ ] **Step 4:** Commit with message `e2e: PC ↔ cloud sync; README`.
