# Fleetfix Garage Pro — Fleetfix Cloud & Browser App — Design

## Why
Fleet Fix sells the system to independent garages and wants two ways to run it (user: "I want both versions"):
- **The PC app**, which works fully without internet, for small garages with one PC, syncing to the cloud
  whenever there is internet.
- **A browser app with the same features**, for garages that don't want to install anything, for owners
  checking from a phone or home, and for tablets and other devices in the garage.

Garages with several users usually have internet (user), but neither side may compromise: **both can edit at
any time** (user), and offline changes merge when the PC reconnects. Fleet Fix sets each garage up and bills it
outside the app (user: no online payments). This also lays the ground for phase 2 (Fleet Fix sending work and
part requests to network garages) on the same cloud.

## Goals
1. **Cloud server** hosting every garage, serving the same API and the same screens in a browser.
2. **Fleet Fix admin console** (browser, Fleet Fix staff only):
   - create a garage with a garage ID, owner name, username and temporary password;
   - see every garage with its plan status, trial or paid-until date, last sync and user count;
   - set the paid-until date, pause and reactivate a garage, reset the owner's password.
3. **Licence:**
   - a new garage gets a **60-day free trial** (user);
   - after that, Fleet Fix sets a paid-until date;
   - an expired or paused garage gets a **14-day grace period**, then becomes **read-only** everywhere (see and
     print everything, create or change nothing);
   - data is never deleted.
4. **PC app "Connect to Fleetfix cloud":**
   - signing in once links a PC to its cloud garage;
   - a new PC downloads the garage's data;
   - an existing standalone PC garage uploads its data into a new, empty cloud garage, losing nothing.
5. **Two-way sync:**
   - the PC syncs automatically when online (on change, and every 30 s while connected);
   - changes made while offline queue and go up when the connection returns;
   - the PC must check its licence with the cloud at least every **30 days**, or it asks to connect.
6. **No clashes:**
   - invoice numbers are never duplicated;
   - stock and payments never conflict;
   - edits to the same record merge field by field, with the latest save winning, and both are kept in history;
   - issued invoices and payments are never overwritten.
7. **Main-computer mode stays as it is.** In a multi-PC garage that is linked to the cloud, only the main computer
   syncs; its client PCs work through it, as today.
8. **Browser app:**
   - same screens and roles (Owner, Accountant, Advisor), with usable layouts on tablets (≥ 768 px);
   - sign-in uses **garage ID + username + password**, and the browser remembers the garage ID;
   - printing and PDF use the browser's print dialog.

## Non-goals
- Online payments and garage self sign-up.
- Native mobile apps.
- Phase 2 job and part-request routing between Fleet Fix and garages (a later project on this cloud).
- Accounting (project 3).
- Reports across several garages, beyond the admin list.
- Real-time co-editing; sync every few seconds is enough.

## Anti-goals
- **One garage seeing another's data.**
- **A duplicated tax-invoice number.**
- **Losing an edit silently**, or changing an issued invoice or a recorded payment.
- **The PC app needing internet to do daily work.**
- **Breaking existing standalone garages.** They keep working unconnected, exactly as now.

## Constraints
- UAE first: AED, 5% VAT, integer fils, and UAE tax-invoice rules (unique, sequential-per-series numbers).
- Builds on the existing code:
  - npm workspaces;
  - Fastify with built-in `node:sqlite`;
  - React screens, so the browser app is the same renderer, served from the cloud;
  - every record already has a UUID and timestamps.
- Windows PC app (Electron). It must keep starting and working with no network at all.
- The user prefers short docs and building as we go.

## Approaches
1. **Picked: one SQLite file per garage in the cloud, a copy of the PC's file.** The cloud runs the same server
   code. A small admin database holds garages, staff and licences. Sync exchanges change logs between the PC's
   file and the cloud's file.
   - It reuses nearly all the code and tests.
   - Garages are physically separated.
   - Backups, restores and handing a garage its own data are simple.
   - One UAE-region server covers hundreds of garages.
2. Rejected: one shared PostgreSQL for all garages. It means a second database dialect kept in step with SQLite,
   and a "this garage only" filter on every query, which is a leak risk.
3. Rejected: a third-party sync product (PowerSync, ElectricSQL or CouchDB). It means rebuilding the data layer,
   a monthly fee and lock-in, and the numbering and stock rules still have to be built on top.

## How it works

### Cloud server (`apps/cloud`, new)
- **One Node process** (Fastify) behind HTTPS.
- **Admin database** `admin.db`:
  - `garages` (id, garage_code unique, name, status `trial|active|paused`, trial_ends_at, paid_until, created_at,
    last_sync_at);
  - `staff` (Fleet Fix admin users);
  - `devices` (PCs linked to a garage, with the device code `P1`, `P2`… and a key hash);
  - `audit` (who changed which licence, and when).
- **Garage files:** each garage has `garages/<id>/garage.db`, opened through the existing `Db` class and
  migrations.
- **Requests:**
  - a request carries a session token that belongs to exactly one garage;
  - the server opens that garage's `Db` (kept in an LRU cache of open handles);
  - it runs the **existing route modules unchanged** against it.
  - The route registration is refactored so that `buildApp` can be given a "Db for this request" resolver,
    instead of one `Db`. This is the one structural change to `packages/server`.
- **Sign-in:** garage ID + username + password. `garage_code` is chosen by Fleet Fix at setup (e.g. `alquoz-auto`).
- **A new garage starts empty, with a one-time setup code** (shown in the admin console, valid 14 days).
  *(My call: this avoids two competing owner accounts when an existing PC garage uploads.)* The code is used in
  one of two ways:
  - **in the browser:** garage ID + setup code opens today's first-run setup screen (garage profile and owner
    account), and the garage then lives in the cloud;
  - **on a PC that already has data:** Connect, then garage ID + setup code uploads that PC's garage, including
    its users, into the empty cloud garage.
  - A PC with no data simply signs in and downloads.
- The **trial starts when Fleet Fix creates the garage**. *(My call.)*
- **The first Fleet Fix staff account** is created with a command on the server (`npm run admin:create -w apps/cloud`).
- **Licence enforcement:** the cloud returns `402 {code:"read_only"}` to every write when a garage is past grace,
  and the screens show a banner and disable editing. The same check runs inside the PC app (below).
- **Serving:** the cloud serves the web build of `apps/desktop`'s renderer at `/`, and the admin console at
  `/admin` (a separate small React entry in the same app).
- **Backups:**
  - nightly, a consistent snapshot of every `garage.db` (SQLite backup API) plus `admin.db`;
  - kept 30 days;
  - copied off the server.

### Sync (`packages/sync`, new; used by the PC app and the cloud)
- **Change log in every garage database** (new migration):
  - `change_log` (seq INTEGER PK, table_name, row_id, op `insert|update|delete`, columns JSON (changed columns
    and values), origin_device, changed_at, user_id).
  - It is written by **SQLite triggers** generated for each synced table, so routes don't change.
  - Applying a remote change records the remote origin, so the change isn't echoed back.
- **Synced tables:** all business tables, including:
  - garage, users (incl. password hash), customers and vehicles;
  - documents, document_lines and payments;
  - parts, suppliers, purchase_orders, po_lines, goods_receipts and their lines, and stock_movements;
  - settings, except device-local keys.
- **Not synced:** sessions, devices (LAN pairing), counters, schema_migrations, change_log.
- **App versions:** each sync carries the app's schema version. If the PC's version is older than the cloud's,
  sync stops and the PC says "Update Fleetfix Garage Pro to keep syncing". The PC keeps working offline.
  *(My call: only one schema version is live at a time.)*
- **Push and pull:**
  - The PC keeps `last_pushed_seq` (its own log) and `last_pulled_seq` (the cloud's log for this garage).
  - `POST /api/sync` sends the PC's new entries. The cloud applies them in one transaction and returns its entries
    since `last_pulled_seq`, excluding the PC's own.
  - Pages of at most 500 entries, repeated until done.
  - Idempotent: the same entry (origin_device + origin seq) is applied once.
- **Merge rules:**
  - **Insert-only records** (stock_movements, payments, goods receipts and their lines) never conflict.
  - **Ordinary records:** field-by-field, latest `changed_at` wins. The losing value stays in `change_log` as
    history.
  - The PC's clock can be wrong, so the cloud **stamps its receive time** and orders by that.
  - **document_lines** are replaced as a set per document. The later save of a document's lines wins as a whole,
    because merging two people's line lists produces nonsense.
  - **Issued invoices are frozen.** Changes to an invoice that is issued on the receiving side, or to its lines,
    are refused and logged as a sync issue.
  - **Payments are only added.**
  - **Derived values are recomputed, not merged:**
    - parts.on_hand and avg_cost_fils, from stock_movements after applying;
    - document totals and paid_fils, from lines and payments.
  - **Unique clashes** (two devices offline add the same plate, part number or username): keep the first one
    received, rename the second with a ` (2)` suffix, and record a **sync issue**.
- **Sync issues:** the Owner sees them in Settings → Cloud sync with "what happened / what we kept", and can
  dismiss each one.

### Numbering (no duplicate tax invoices)
- `documents` and `purchase_orders` gain a `series` column. The unique key becomes (type, series, seq).
- **Online** (browser, or a PC that can reach the cloud within about 2 s), numbers come from the cloud's main
  series: `INV-00012`. A PC asks for the number with `POST /api/numbers {type}` when it creates the document.
- **An offline PC** numbers from its own device series: `INV-P1-00003`. The device code is given by the cloud at
  link time. A standalone PC that was never linked keeps today's plain series.
- **Linking an existing standalone garage:** its existing numbers become the main series (the cloud starts after
  its highest number), since the cloud garage is new and empty.

### PC app changes (`apps/desktop`)
- **Settings → Cloud** shows the status (linked, last sync, pending changes, licence until), "Sync now" and the
  sync issues. First-run and Settings both offer **Connect to Fleetfix cloud**.
- **Linking:**
  - `config.json` gains `cloud: { url, garageId, deviceCode, deviceKey }`;
  - the local server keeps running as now, and a sync loop in the main process talks to the cloud.
- **Licence:**
  - the cloud returns a **signed licence token** (status, paid_until or trial_ends_at, checked_at) with each
    sync, and the PC stores it;
  - the PC is read-only when past grace, or when 30 days have passed without a check;
  - the signature (Ed25519, public key built into the app) stops tampering with the date.

### Hosting
- One Linux server in a UAE or GCC region, with HTTPS on a Fleet Fix domain. Node runs under a process manager,
  with nightly off-server backups and basic uptime and disk alerts.
- Infrastructure as a short script plus a README, so the server can be rebuilt.

## Stages
1. **Cloud and browser:**
   - the cloud server with per-garage databases and the admin console;
   - trial, licence and read-only;
   - the browser app;
   - browser-only garages work end to end.
2. **Sync:**
   - change logs, sync API and merge rules;
   - number series;
   - PC Connect, upload and download;
   - licence token;
   - sync issues.
3. **Go live:** the server, domain, HTTPS, backups and monitoring, and the installer pointing at the cloud.

## Left to the builder
- Screen layouts for the admin console, Cloud settings and sync-issue list, and tablet breakpoints.
- The sync loop's back-off timing.
- Trigger generation details and the LRU cache size.
- Exact error wording.
