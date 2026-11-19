# Settings Part 1 (Settings and printing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the thin Settings page with the tiles-based Settings feature of Part 1: settings storage, garage/documents/numbering/tax/pricing/inventory/security sections, A4 printing driven by those settings with a live preview, Users moved in, activity log, idle lock, PC backups and About & support.

**Architecture:** Settings are validated `section.field` keys in the existing `settings` table (one Zod schema per section in `packages/shared`), read with defaults by one `readSettings()`; they sync like any row, `local.`/`network.` keys stay on their PC. The server enforces numbering, VAT-inclusive pricing, discount limits and stock blocking; print templates read the settings. PC backups live in the Electron main process.

**Tech Stack:** TypeScript, Zod 4, Fastify 5, `node:sqlite`, React 19 + react-router, Tailwind, Electron 45, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-settings-design.md` (Goals A, B, G, H; "Rollout" Part 1; "Ready for the insurance add-on").

## Global Constraints
- Only the Owner (`settings.manage`) sees Settings and changes settings; every change is written to the audit log.
- Money is integer fils; VAT 5% (`VAT_RATE_BP = 500`), shown, not editable.
- Never edit migrations 1–6; this plan adds migration 7 only.
- An invoice number never goes backwards and no two documents share a number.
- An issued invoice is never edited.
- A4 only. Images PNG/JPG up to 500 KB, stored in settings (they sync).
- `network.` and `local.` settings keys never leave their PC.
- Support email: **garagepro@fleetfix.ae**.
- Copy is plain English for garage staff; no jargon in messages.
- Tablet ≥ 768 px must stay usable (tiles 3 columns on PC, 2 on tablet, 1 on phone).

**Plan-level rulings (deviations from the spec's wording, decided here):**
- *Print count:* the spec says `documents.print_count`. An issued invoice is frozen in sync, so bumping a column on it would be refused by the cloud. Prints are instead rows in a new insert-only table `document_prints`; the count is `COUNT(*)`, which also adds up across PCs.
- *Keys are flat per section* (`numbering.invoicePrefix`, not `numbering.invoice.prefix`) so each section is one flat Zod object.
- *No secrets in Part 1:* the only secret (SMTP password) arrives with Messages in Part 3.
- *Stock "warn"* keeps today's behaviour; only "block" changes anything.

## Review Focus
1. Two owners saving *different* sections on two PCs at once: neither save may overwrite the other's keys (per-key rows) — test in Task 3.
2. A logo that is not PNG/JPG, or is over 500 KB, or is a broken data URL: refused with "Use a PNG or JPG image under 500 KB", nothing written — test in Tasks 1 and 3.
3. A settings row written by a newer app version (unknown key) or a corrupt value arriving by sync: ignored, defaults used, the page still loads — test in Task 1.
4. Setting the next invoice number below one already used, or two document types on the same prefix: refused with a plain message; a cloud-reserved number still never goes below the chosen start — test in Task 4.
5. Restoring a file that isn't a garage backup, or comes from a newer app version: refused before anything is touched; current data stays — test in Task 12.

---

### Task 1: Settings schemas and defaults (shared)

**Files:**
- Create: `packages/shared/src/settings.ts`
- Modify: `packages/shared/src/index.ts` (export it), `packages/shared/src/rules.ts` (number kinds, prefixes, `audit.view`)
- Test: `packages/shared/test/settings.test.ts`, `packages/shared/test/rules.test.ts`

**Interfaces:**
- Produces:
  - `SETTINGS_SECTIONS = ["garage","documents","numbering","tax","pricing","inventory","security"] as const`, `type SettingsSection`
  - `settingsSchemas: Record<SettingsSection, z.ZodObject>` — every field has a default, so `settingsSchemas[s].parse({})` gives that section's defaults:
    - `garage`: `tradeLicence` (text ≤40|null), `bankName` (≤80|null), `accountName` (≤120|null), `iban` (spaces removed, upper-cased; `^AE\d{21}$` or null; message "A UAE IBAN is AE followed by 21 digits")
    - `documents`: `logo`, `stamp`, `signature` (`imageSchema`|null), `paper` (`"plain"|"letterhead"`, default plain), `letterheadTopMm` (int 10–120, default 45), `terms` (≤1000|null), `warranty` (≤300|null), `estimateValidDays` (int 1–365, default 14), `showPartNumbers` (default true), `showLabourHours` (default true), `jobCardSignature` (default true)
    - `numbering`: `estimatePrefix` "EST", `jobcardPrefix` "JC", `invoicePrefix` "INV", `purchaseOrderPrefix` "PO" (each `^[A-Z]{1,6}$`), `estimateStart`, `jobcardStart`, `invoiceStart`, `purchaseOrderStart` (int ≥1, default 1); refine: the four prefixes are different ("Each document type needs its own prefix")
    - `tax`: `pricesIncludeVat` (default false), `returnPeriod` (`"quarterly"|"monthly"`, default quarterly), `firstPeriodStart` (`YYYY-MM-DD`|null)
    - `pricing`: `labourRateFils` (int ≥0|null, default null), `partsMarkupPct` (0–1000|null, default null), `maxDiscountAccountantPct` (0–100, default 100), `maxDiscountAdvisorPct` (0–100, default 100)
    - `inventory`: `belowZero` (`"warn"|"block"`, default warn), `defaultReorderLevel` (number ≥0, default 0)
    - `security`: `idleLockMinutes` (int 0–240, default 15; 0 = never)
  - `imageSchema`: `data:image/(png|jpeg);base64,<data>` whose decoded size ≤ 500 × 1024 bytes; message "Use a PNG or JPG image under 500 KB"
  - `type Settings = { [S in SettingsSection]: z.output<(typeof settingsSchemas)[S]> }`, `DEFAULT_SETTINGS: Settings`
  - `readSettings(rows: { key: string; value: string }[]): Settings` — per field: JSON-parse, validate with that field's schema, else the default; unknown keys and unknown sections ignored; never throws
  - `sectionRows(section: SettingsSection, value: unknown): { key: string; value: string }[]` — parses with the section schema (throws ZodError), returns one row per field, key `${section}.${field}`, value `JSON.stringify`
  - `LOCAL_SETTING_PREFIXES = ["network.", "local."] as const`
  - rules.ts: `NUMBER_KINDS = ["estimate","jobcard","invoice","purchase_order"] as const`, `type NumberKind`; `formatDocNumber(type, n, series = "", prefix = PREFIX[type])`; `formatPoNumber(n, series = "", prefix = "PO")`; `prefixOf(settings: Settings, kind: NumberKind): string`; `startOf(settings, kind): number`; action `"audit.view"` (Owner only)

- [ ] **Step 1: Write the failing tests** in `packages/shared/test/settings.test.ts`:
  - `"every section has defaults"`: `readSettings([])` equals `DEFAULT_SETTINGS`; `DEFAULT_SETTINGS.documents.estimateValidDays === 14`, `.numbering.invoicePrefix === "INV"`, `.security.idleLockMinutes === 15`, `.inventory.belowZero === "warn"`, `.pricing.maxDiscountAdvisorPct === 100`.
  - `"reads stored values and ignores what it doesn't know"`: rows `[{key:"pricing.labourRateFils",value:"18000"},{key:"pricing.futureThing",value:"1"},{key:"marketing.x",value:"1"},{key:"tax.returnPeriod",value:"\"weekly\""},{key:"documents.terms",value:"not json"}]` → `labourRateFils === 18000`, `tax.returnPeriod === "quarterly"`, `documents.terms === null`, no throw.
  - `"sectionRows writes one row per field"`: `sectionRows("inventory", { belowZero: "block" })` equals `[{key:"inventory.belowZero",value:"\"block\""},{key:"inventory.defaultReorderLevel",value:"0"}]`.
  - `"images: PNG/JPG under 500 KB only"`: a 1×1 PNG data URL passes; `data:image/gif;base64,R0lG` throws "Use a PNG or JPG image under 500 KB"; a PNG data URL of 600 KB throws the same; `"data:image/png;base64,%%%"` throws.
  - `"IBAN is normalised and checked"`: `"ae07 0260 0010 1234 5678 901"` → `"AE070260001012345678901"`; `"GB00 1234"` throws "A UAE IBAN is AE followed by 21 digits"; `""` → null.
  - `"prefixes must differ"`: numbering with `invoicePrefix:"JC"` throws "Each document type needs its own prefix"; `"inv"` throws (upper case only).
  - rules.test.ts: `formatDocNumber("invoice", 12, "", "TI") === "TI-00012"`; `formatDocNumber("invoice", 3, "P1") === "INV-P1-00003"`; `can("owner","audit.view")` true, accountant/advisor false.

- [ ] **Step 2: Run** `npx vitest run packages/shared` — Expected: FAIL (module `../src/settings` not found).

- [ ] **Step 3: Implement** `packages/shared/src/settings.ts` and the rules.ts additions per Interfaces.

- [ ] **Step 4: Run** `npx vitest run packages/shared` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "shared: settings sections, defaults and safe reading; configurable number prefixes"`

---

### Task 2: Migration 7, audit log, prints, local keys stay local

**Files:**
- Modify: `packages/server/src/migrations.ts` (migration 7), `packages/server/src/db.ts` (`device` field), `packages/server/src/app.ts` (set `db.device`)
- Create: `packages/server/src/audit.ts`
- Modify: `packages/sync/src/tables.ts`, `packages/sync/src/capture.ts`, `packages/sync/src/index.ts`, `apps/cloud/src/upload-check.ts`
- Test: `packages/server/test/audit.test.ts`, `packages/sync/test/capture.test.ts`

**Interfaces:**
- Migration 7 SQL:
  ```sql
  ALTER TABLE documents ADD COLUMN prices_include_vat INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE document_prints (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
    user_id TEXT REFERENCES users(id), printed_at TEXT NOT NULL);
  CREATE INDEX document_prints_doc ON document_prints(document_id);
  CREATE TABLE audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT,
    before TEXT, after TEXT, user_id TEXT REFERENCES users(id), device TEXT, created_at TEXT NOT NULL);
  CREATE INDEX audit_log_created ON audit_log(created_at);
  ```
- `Db.device: string` (default `"this PC"`); `buildApp` sets it to `"Fleetfix cloud"` when `options.cloud`, else `os.hostname()`.
- `audit(db: Db, e: { action: AuditAction; entity: string; entityId?: string | null; before?: unknown; after?: unknown; userId: string | null }): void` — JSON-encodes before/after, stamps `db.device` and `now()`.
- `type AuditAction = "settings.change" | "discount.approve" | "user.create" | "user.update" | "backup.restore"`
- tables.ts: append `{ name: "document_prints", key: "id", insertOnly: true }`, `{ name: "audit_log", key: "id", insertOnly: true }`; replace `LOCAL_SETTING_PREFIX` with `LOCAL_SETTING_PREFIXES` re-exported from `@ffgp/shared`; capture's settings WHEN-clause skips every prefix; upload-check's cleanup deletes `network.%` **and** `local.%`.

- [ ] **Step 1: Write the failing tests:**
  - audit.test.ts `"audit writes who, what, where"`: after `setUp`, `audit(app.db, {action:"settings.change", entity:"settings", entityId:"pricing", before:{a:1}, after:{a:2}, userId: ownerId})` → row has `before === '{"a":1}'`, `device` non-empty, `created_at` ISO.
  - audit.test.ts `"migration 7 adds prices_include_vat defaulting to 0"`: `PRAGMA table_info(documents)` includes it; an existing document reads 0.
  - capture.test.ts `"local and network settings are never captured"`: with capture installed, inserting `local.backup.folder` and `network.sharing` adds no change_log rows; `pricing.labourRateFils` adds one.
  - capture.test.ts `"prints and audit rows travel insert-only"`: inserting into both tables logs one `insert` each.

- [ ] **Step 2: Run** `npx vitest run packages/server/test/audit.test.ts packages/sync/test/capture.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (whole suite; `SCHEMA_VERSION` is now 7 — fix any test that pinned 6).
- [ ] **Step 5: Commit** `git commit -m "server: migration 7 (VAT-inclusive flag, document prints, audit log); local settings never sync"`

---

### Task 3: Settings API and activity log API

**Files:**
- Create: `packages/server/src/settings.ts`, `packages/server/src/routes/settings.ts`
- Modify: `packages/server/src/routes/setup.ts` (move GET/PATCH `/api/settings` out; PATCH audited), `packages/server/src/routes/users.ts` (audit create/update), `packages/server/src/app.ts`, `packages/server/src/index.ts`
- Test: `packages/server/test/settings.test.ts`

**Interfaces:**
- Consumes: `readSettings`, `sectionRows`, `settingsSchemas` (Task 1); `audit` (Task 2).
- Produces:
  - `getSettings(db: Db): Settings` — reads all rows not starting with a local prefix.
  - `saveSection(db: Db, userId: string, section: SettingsSection, input: unknown): Settings` — in one transaction: validate, upsert only that section's rows, audit `settings.change` with `entityId = section` and only the changed fields in before/after (image values written as `"(image)"`). Numbering is validated by Task 4's hook `checkNumbering`.
  - `GET /api/settings` (any signed-in user) → `{ garage, settings: Settings }`
  - `PATCH /api/settings` (settings.manage) — unchanged body; now audited as `settings.change` / `entityId:"profile"`.
  - `PUT /api/settings/:section` (settings.manage) → `{ settings }`; unknown section → 404 "Unknown settings section".
  - `GET /api/settings/overview` (settings.manage) → `{ nextNumbers: Record<NumberKind, string>, users: number, changesThisWeek: number }`
  - `GET /api/audit?userId&action&from&to` (audit.view) → `{ entries: { id, action, entity, entityId, before, after, user: string | null, device, createdAt }[] }`, newest first, at most 500.

- [ ] **Step 1: Write the failing tests** in `settings.test.ts`:
  - `"anyone signed in reads settings with defaults"`: advisor GET → `settings.numbering.invoicePrefix === "INV"`.
  - `"only the owner saves a section"`: accountant PUT `/api/settings/pricing` → 403; owner PUT `{labourRateFils:18000}` → 200 and GET shows 18000.
  - `"saving one section never touches another"` (Review Focus 1): owner PUT pricing, then owner PUT inventory → pricing still 18000; the rows changed by the second save are only `inventory.*`.
  - `"bad input is refused and nothing written"` (Review Focus 2): PUT documents `{ logo: "data:image/gif;base64,R0lG" }` → 400 with error "Use a PNG or JPG image under 500 KB"; GET logo still null.
  - `"every change is in the activity log"`: after the pricing save, GET `/api/audit` as owner → first entry `action "settings.change"`, `entityId "pricing"`, `before {labourRateFils:null}`, `after {labourRateFils:18000}`, `user "Owner One"`; accountant GET `/api/audit` → 403.
  - `"logo changes are logged without the image"`: after saving a logo, the entry's `after.logo === "(image)"`.
  - `"overview"`: fresh garage → `nextNumbers.invoice === "INV-00001"`, `users === 1`, `changesThisWeek` counts this week's entries.
  - `"user changes are logged"`: creating a user writes `user.create` with the username in `after` and no password hash.

- [ ] **Step 2: Run** `npx vitest run packages/server/test/settings.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "server: settings sections API, overview and activity log"`

---

### Task 4: Numbering prefixes and next numbers

**Files:**
- Modify: `packages/server/src/numbering.ts`, `packages/server/src/settings.ts`, `packages/server/src/routes/documents.ts`, `packages/server/src/routes/purchases.ts`
- Test: `packages/server/test/numbering-settings.test.ts`

**Interfaces:**
- Consumes: `getSettings`, `prefixOf`, `startOf`, `formatDocNumber`, `formatPoNumber`.
- Produces:
  - `takeNumber` (same signature): main series (`""`) uses `seq = max(counter, MAX(seq)+1, startOf(settings, kind))`; device series ignore the start. This also runs in the cloud for `/api/cloud/sync/numbers`, so a reserved number honours the start.
  - `previewNumber(db: Db, kind: NumberKind): number` — what `takeNumber` would give the main series, without writing.
  - `checkNumbering(db: Db, next: Settings["numbering"]): void` — throws `badRequest` "INV can't go back: the next number is INV-00143" (actual prefix and number) when a start is below `previewNumber`; changing a start that wasn't touched is allowed.
  - Documents and POs format with the current prefix at creation; old documents keep their stored numbers.

- [ ] **Step 1: Write the failing tests:**
  - `"a new prefix applies to new documents only"`: create INV-00001, set `invoicePrefix:"TI"`, issue a new invoice → `TI-00002`; the first still reads `INV-00001`.
  - `"next number can jump forward"`: set `invoiceStart: 500` → next invoice `INV-00500`, the one after `INV-00501`.
  - `"next number never goes back"` (Review Focus 4): with INV-00001…00003 used, PUT `invoiceStart: 2` → 400 "INV can't go back: the next number is INV-00004"; `invoiceStart: 4` → 200.
  - `"two types can't share a prefix"`: PUT `jobcardPrefix:"INV"` → 400 "Each document type needs its own prefix".
  - `"offline series ignore the start"`: with `numbers: { next: async () => null, offlineSeries: "P1" }` and `invoiceStart: 500` → `INV-P1-00001`.
  - `"the cloud's reserved number honours the start"`: call `takeNumber(db, "invoice", null, undefined)` after saving `invoiceStart: 900` → seq 900.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/numbering-settings.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "numbering: prefixes and next numbers from settings; never backwards"`

---

### Task 5: Prices typed including VAT

**Files:**
- Modify: `packages/shared/src/money.ts`, `packages/server/src/routes/documents.ts`, `apps/desktop/src/renderer/lib/types.ts`
- Test: `packages/shared/test/money.test.ts`, `packages/server/test/documents-vat.test.ts`

**Interfaces:**
- Produces:
  - `lineTotals(line, vatRateBp = VAT_RATE_BP, includeVat = false)`, `docTotals(lines, vatRateBp, includeVat = false)`. Including VAT: `gross = roundFils(qty × price × (1 − disc/100))`, `net = roundFils(gross × 10000 / (10000 + rate))`, `vat = gross − net`.
  - A document copies `settings.tax.pricesIncludeVat` into `prices_include_vat` when created; a converted document copies its source's flag; `writeLines` uses the document's flag. `full()` returns `pricesIncludeVat: boolean`. `DocumentFull` type gains it.
- [ ] **Step 1: Write the failing tests:**
  - money.test.ts `"including VAT: the typed price is the total"`: `{qty:1, unitPriceFils:10500}` incl. → `{net 10000, vat 500, gross 10500}`; `{qty:1, unitPriceFils:999}` → `{net 951, vat 48, gross 999}`; `{qty:3, unitPriceFils:1000, discountPct:10}` → gross 2700, net 2571, vat 129.
  - documents-vat.test.ts `"the setting is copied, not followed"`: set `pricesIncludeVat:true`, create an estimate with one line 10500 → totals `{10000, 500, 10500}`; switch the setting off; edit the same estimate's lines unchanged → totals unchanged; convert → job card `pricesIncludeVat true` and same totals.
- [ ] **Step 2: Run** `npx vitest run packages/shared/test/money.test.ts packages/server/test/documents-vat.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "documents: prices typed including VAT, fixed per document"`

---

### Task 6: Discount limits with the Owner's approval; stock can be blocked below zero

**Files:**
- Modify: `packages/shared/src/schemas.ts`, `packages/server/src/routes/documents.ts`, `packages/server/src/stock.ts`, `packages/server/src/app.ts` (share one `LoginThrottle` between setup and documents routes)
- Test: `packages/server/test/discounts.test.ts`, `packages/server/test/stock-block.test.ts`

**Interfaces:**
- Produces:
  - `approvalSchema = z.object({ username: text(60).min(1), password: z.string().min(1).max(200) })`; `documentCreateSchema`, `documentUpdateSchema` and the PUT-lines body gain `approval: approvalSchema.optional()`.
  - Discount rule in `writeLines` callers: limit = 100 for owner, else `settings.pricing.maxDiscount{Accountant|Advisor}Pct`. A line needs approval when `discountPct > limit`, unless the document already had a line at the same position with a discount ≥ it. Without a valid approval → `HttpError(403, "A discount over {limit}% needs the Owner's approval", "discount_approval")`. A valid approval is an active owner's username and password, checked through the shared `LoginThrottle` (same lockout as sign-in); it writes `audit discount.approve` with `{ document: number, lines: [{description, discountPct}], approvedBy: ownerName }`.
  - `reconcileDocumentStock(db, docId, userId, opts: { block?: boolean } = {})`: with `block`, before posting an outgoing movement for a stocked part whose `on_hand − diff < 0`, throw `HttpError(409, "Only {on_hand} {unit} of {part_no} in stock", "out_of_stock")`. Routes pass `block: settings.inventory.belowZero === "block"`; sync's recompute never passes it.
- [ ] **Step 1: Write the failing tests:**
  - discounts.test.ts `"advisors stay within their limit"`: set `maxDiscountAdvisorPct: 10`; advisor creates an estimate with a 15% line → 403 code `discount_approval`; with `approval: {username:"owner", password:"owner-pass-1"}` → 200 and an audit `discount.approve` entry naming "Owner One".
  - `"a wrong owner password doesn't approve"`: approval with a wrong password → 403 `discount_approval`; approval by an accountant's credentials → 403.
  - `"an approved discount isn't asked again"`: after the approved save, the advisor changes another line's description → 200 without approval.
  - `"the owner needs no approval"`: owner saves 50% → 200, no audit entry.
  - stock-block.test.ts `"block refuses to go below zero"`: part with 2 on hand, `belowZero:"block"`, job card line qty 3 → 409 "Only 2 each of {partNo} in stock" and on_hand still 2; qty 2 → 200, on_hand 0.
  - `"warn keeps today's behaviour"`: default setting, qty 3 → 200, on_hand −1.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/discounts.test.ts packages/server/test/stock-block.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "documents: discount limits per role with Owner approval; optional stock block"`

---

### Task 7: Printing from settings, with COPY and PAID watermarks

**Files:**
- Modify: `apps/desktop/src/renderer/print/templates.ts`, `apps/desktop/src/renderer/print/print.ts`, `packages/server/src/routes/documents.ts`, `apps/desktop/src/renderer/pages/DocumentPage.tsx`, `apps/desktop/src/renderer/pages/PurchaseOrderPage.tsx`, `apps/desktop/test/workflow.spec.ts` (call sites)
- Create: `apps/desktop/src/renderer/print/sample.ts`
- Test: `apps/desktop/test/templates.test.ts`

**Interfaces:**
- Consumes: `Settings` (Task 1), `pricesIncludeVat` (Task 5).
- Produces:
  - `POST /api/documents/:id/prints` (any signed-in user) → `{ count: number }`; records a row only for issued/part-paid/paid invoices; for anything else returns `{ count: 0 }` and writes nothing. `full()` returns `printCount`.
  - `renderDocumentHtml(doc: DocumentFull, garage: Garage, settings: Settings, opts: { copy?: boolean } = {}): string`; `renderPurchaseOrderHtml(po, garage, settings)`.
  - `printDocument(doc, garage, settings, mode)` — for an issued invoice, calls `/prints` first and passes `copy: count > 1`.
  - `SAMPLE_DOCUMENTS: Record<DocType, DocumentFull>` in sample.ts (Al Quoz Auto Care style data: oil filter, engine oil 7 L, 1.5 h labour) used by the preview and the test page.
  - Layout rules: logo `<img class="logo">` (max 22 mm high) left of the garage block; letterhead paper → no logo and no garage block, a blank top of `letterheadTopMm` mm, title block kept; trade licence under TRN; bank line (bank · account name · IBAN) and terms in the footer of invoices; warranty line under totals on invoices; estimate note uses `estimateValidDays`; stamp and signature images above "For {garage}" on estimates and invoices; job card with `jobCardSignature` gets a box "I authorise the work above" with a signature line; `showPartNumbers` adds "Part no. X" under the description; `showLabourHours` prints labour qty as "1.5 h"; incl.-VAT documents label the price column "Unit price (incl. VAT)"; watermark "COPY" when `opts.copy`, "PAID" when status is paid (both: two lines).
- [ ] **Step 1: Write the failing tests** (`templates.test.ts`, vitest, string checks on the HTML):
  - `"logo and bank details print on a plain-paper invoice"`: settings with a logo, bank and terms → HTML contains `<img class="logo"`, the IBAN and the terms.
  - `"letterhead leaves the top blank"`: `paper:"letterhead", letterheadTopMm:45` → no garage name `<h1>`, contains `height:45mm`.
  - `"estimate validity follows the setting"`: `estimateValidDays: 30` → "valid for 30 days".
  - `"watermarks"`: issued invoice with `{copy:true}` → contains `COPY`; paid invoice → contains `PAID`; draft → neither.
  - `"part numbers and labour hours can be hidden"`: both false → no "Part no.", labour qty without " h".
  - `"job card authorisation box"`: true → "I authorise the work above"; false → absent.
  - server test in `packages/server/test/documents.test.ts` `"prints are counted for issued invoices only"`: estimate → `{count:0}`; issued invoice twice → `{count:1}` then `{count:2}`; `full().printCount === 2`.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/templates.test.ts packages/server/test/documents.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; DocumentPage and PurchaseOrderPage read `settings` from `useAuth()` (Task 8 adds it; until then fetch `/api/settings`).
- [ ] **Step 4: Run** `npm test && npm run e2e` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "printing: logo, letterhead, bank, terms, warranty, stamp, signature box, COPY/PAID"`

---

### Task 8: Settings home (tiles), section shell, Users moved in

**Files:**
- Create: `apps/desktop/src/renderer/pages/settings/SettingsHome.tsx`, `apps/desktop/src/renderer/pages/settings/tiles.ts`, `apps/desktop/src/renderer/pages/settings/SectionShell.tsx`, `apps/desktop/src/renderer/lib/unsaved.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/components/Layout.tsx`, `apps/desktop/src/renderer/lib/auth.tsx` (keep `settings` beside `garage`; `refreshGarage` refreshes both), `apps/desktop/src/renderer/lib/types.ts`, `apps/desktop/src/renderer/pages/UsersPage.tsx`
- Delete: `apps/desktop/src/renderer/pages/SettingsPage.tsx` (its cards move into sections)
- Test: `apps/desktop/test/settings-tiles.test.ts`

**Interfaces:**
- Produces:
  - `useAuth().settings: Settings | null`.
  - `BackupStatus = { folder: string; folderOk: boolean; last: string | null; keepDays: number }` in `renderer/lib/types.ts` (the main process fills it in Task 12; until then `backup` is null).
  - `TileContext = { garage: Garage; settings: Settings; overview: { nextNumbers: Record<NumberKind,string>; users: number; changesThisWeek: number } | null; isCloud: boolean; pcMode: "local"|"main"|"client"|null; backup: BackupStatus | null; cloud: CloudStatus | null; syncIssues: number; version: string; licence: Licence | null }`
  - `TILES: Tile[]` with `Tile = { id: string; group: "garage"|"money"|"running"|"connections"; title: string; blurb: string; coming?: true; show(ctx): boolean; status(ctx): { tone: "ok"|"todo"|"alert"|"muted"; text: string } }`, in this order and wording:
    - garage: `garage` "Garage details" ("Name, TRN, trade licence, address, bank & IBAN") — todo "VAT TRN missing" / todo "Bank details missing" / ok "Complete"; `documents` "Documents & printing" ("Logo, stamp, signature, paper, terms, warranty") — todo "Logo missing" / ok "Plain paper" | "Letterhead paper"; `numbering` "Numbering" ("Prefixes and next numbers") — ok "Next invoice INV-00143"
    - money: `tax` "Tax" — ok "Prices exclude VAT · quarterly"; `pricing` "Pricing & discounts" — todo "No labour rate set" / ok "AED 180.00 / hour"; `customers-credit` "Customers & credit" coming — muted "Coming in Part 2"
    - running: `inventory` — ok "Warn only" | "Block below zero"; `users` "Users & roles" — ok "4 users"; `security` — ok "Locks after 15 min" | "Screen lock off"; `activity` "Activity log" — ok "12 changes this week"; `backups` (only PC holding the garage: `pcMode` local/main) — alert "Backup folder not found" / todo "No backup yet" / alert "Last backup 4 days ago" (> 3 days) / ok "Last backup 2 hours ago"; `messages` coming — muted "Coming in Part 3"
    - connections: `cloud` "Fleetfix cloud" (PC only) — ok "Synced 1 min ago" / muted "Not connected"; `other-pcs` (PC only) — ok "Sharing with other PCs" / muted "Not sharing"; `sync-issues` (browser, only when `syncIssues > 0`) — alert "3 to review"; `about` "About & support" — ok "Version 0.1.0"
  - `gettingReady(ctx): { done: number; total: number; missing: string[] }` — essentials: garage name, VAT TRN, address, phone, bank & IBAN, logo, labour rate, invoice terms, and (PC holding the garage) a working backup folder. Hidden when `done === total`.
  - Routes: `/settings` → `SettingsHome`; `/settings/:section` → that section; `/users` → `<Navigate to="/settings/users" replace />`; the Users menu item is removed.
  - `SectionShell({ title, subtitle, dirty, busy, onSave?, aside?, children })`: "← All settings" link, Save button when `onSave`, preview column when `aside`; registers `dirty` with `UnsavedProvider` so the back link and the main-menu links ask "Leave without saving? Your changes to {title} will be lost." before leaving; `beforeunload` while dirty.
  - Home: tiles grouped under "Your garage", "Money", "Running the garage", "Connections"; status colours green/amber/red/zinc; `coming` tiles faded and not clickable; grid 3/2/1 columns at ≥1024/≥768/<768 px.
- [ ] **Step 1: Write the failing tests** (`settings-tiles.test.ts`): status of each tile for a fresh garage (garage todo "Bank details missing", documents todo "Logo missing", pricing todo "No labour rate set", backups todo "No backup yet" when PC and no backup, alert "Last backup 4 days ago"); `show` hides backups/other-pcs/cloud in the browser and hides backups on a client PC; `gettingReady` on a fresh PC garage → `total 9`, `missing` includes "Logo", "Bank details", "Labour rate", "Invoice terms", "Backup folder"; on the browser → `total 8`.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/settings-tiles.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces (sections not yet built in Task 9/10/11/12 render a "Coming" placeholder only until their task lands).
- [ ] **Step 4: Run** `npm test && npm run e2e` — Expected: PASS (update the e2e steps that open Users or Settings).
- [ ] **Step 5: Commit** `git commit -m "settings: tiles home with status lines, getting-ready bar, Users moved in"`

---

### Task 9: Form sections — Garage details, Numbering, Tax, Pricing, Inventory, Security, Activity log, About & support; editor defaults

**Files:**
- Create: `apps/desktop/src/renderer/pages/settings/sections/{GarageSection,NumberingSection,TaxSection,PricingSection,InventorySection,SecuritySection,ActivitySection,AboutSection,CloudSection}.tsx`, `apps/desktop/src/renderer/pages/settings/describe.ts`
- Modify: `apps/desktop/src/renderer/pages/DocumentPage.tsx` (labour rate prefill; discount approval dialog), `apps/desktop/src/renderer/pages/PartPage.tsx` (default reorder level; suggested price at markup), `apps/desktop/electron.vite.config.ts` and `apps/desktop/vite.web.config.mts` (`define: { __APP_VERSION__ }` from `apps/desktop/package.json`), `apps/desktop/src/renderer/env.d.ts`
- Test: `apps/desktop/test/describe.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6 APIs, `SectionShell`.
- Produces:
  - Garage section: the existing profile fields (PATCH `/api/settings`) plus trade licence, bank, account name, IBAN (PUT `garage`), one Save that sends both.
  - Numbering: per type a prefix and "Next number" field, with the live example "Next invoice will be TI-00500".
  - Tax: "VAT 5% (UAE standard rate)" read-only; "Prices I type" Excluding / Including VAT (note: "Applies to new documents; existing ones keep theirs"); return period and first period start.
  - Pricing: labour rate (AED/hour), parts markup %, largest discount for Admin / Accountant and Service Advisor ("Above this, the Owner approves with their password").
  - Inventory: Warn / Block, default reorder level. Security: lock after N minutes (Never, 5, 10, 15, 30, 60).
  - Activity log: filters (person, kind, from, to) and a list using `describeAudit(entry): string` — e.g. `"Changed Pricing — Labour rate: not set → AED 180.00"`, `"Approved a 15% discount on EST-00004"`, `"Added user Sara (Service Advisor)"`, `"Restored a backup"`; images read "(image)".
  - About: `__APP_VERSION__`, licence ("Standalone — no subscription needed" when not linked; else state and until-date from `useAuth().licence`), "Support: garagepro@fleetfix.ae" as a `mailto:` link.
  - Cloud section = today's `CloudCard` + `SyncIssues`; Other PCs = `OtherPcsCard`; browser Sync issues = `SyncIssues`.
  - DocumentPage: a new labour line starts at `settings.pricing.labourRateFils`; a 403 `discount_approval` opens "Owner approval" (owner username + password) and retries with `approval`; a 409 `out_of_stock` shows its message.
  - PartPage: new part's reorder level defaults to `settings.inventory.defaultReorderLevel`; with a markup and an average cost, shows "Suggested at {n}% markup: AED x" with "Use".
- [ ] **Step 1: Write the failing tests** (`describe.test.ts`) for the four `describeAudit` examples above and an image change.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/describe.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test && npm run e2e` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "settings: garage, numbering, tax, pricing, inventory, security, activity log, about"`

---

### Task 10: Documents & printing section with live A4 preview

**Files:**
- Create: `apps/desktop/src/renderer/pages/settings/sections/DocumentsSection.tsx`, `apps/desktop/src/renderer/components/ImagePicker.tsx`
- Modify: `apps/desktop/src/renderer/print/print.ts` (export `printHtml`)
- Test: covered by Task 13's e2e

**Interfaces:**
- Consumes: `renderDocumentHtml`, `SAMPLE_DOCUMENTS` (Task 7), `SectionShell` (Task 8).
- Produces:
  - `ImagePicker({ label, value, onChange })`: choose PNG/JPG, read as data URL, refuse over 500 KB in the browser with the same message as the server; Replace and Remove.
  - The section's `aside` is an `<iframe srcDoc>` of `renderDocumentHtml(SAMPLE_DOCUMENTS[kind], draftGarage, draftSettings)` scaled to the column width (A4 = 210 mm), with an Invoice / Estimate / Job card switch, re-rendered on every change of the unsaved form; under it "Print a test page" (prints the same HTML through `printHtml`). On screens < 1024 px the preview sits under the form.
- [ ] **Step 1:** Build the section; check manually with `npm run dev -w @ffgp/desktop` that the preview updates as you type terms and toggle letterhead.
- [ ] **Step 2: Run** `npm test && npm run e2e` — Expected: PASS.
- [ ] **Step 3: Commit** `git commit -m "settings: documents & printing with live A4 preview and test page"`

---

### Task 11: Lock the screen when idle

**Files:**
- Create: `apps/desktop/src/renderer/components/IdleLock.tsx`
- Modify: `apps/desktop/src/renderer/components/Layout.tsx`
- Test: in Task 13's e2e (Playwright clock)

**Interfaces:**
- Produces: `IdleLock({ minutes })` mounted in Layout with `settings.security.idleLockMinutes` (0 = off). After that many minutes without pointer, key, wheel or touch input, a full-screen overlay hides the app: "Locked — {user name}", a password field and "Unlock" (POST `/api/auth/login` with the same username; on success the new token replaces the old one and the overlay closes, form state underneath untouched), and "Sign in as someone else" (signs out). Wrong password: "That password isn't right". Locking also starts on app load if the timer had run out (no bypass by reloading: the lock state is kept in `sessionStorage`).
- [ ] **Step 1:** Implement per Interfaces.
- [ ] **Step 2: Run** `npm test && npm run e2e` — Expected: PASS.
- [ ] **Step 3: Commit** `git commit -m "security: lock the screen after idle minutes"`

---

### Task 12: PC backups and restore

**Files:**
- Create: `apps/desktop/src/main/backups.ts` (no `electron` import, so it is unit-testable), `apps/desktop/src/renderer/pages/settings/sections/BackupsSection.tsx`
- Modify: `apps/desktop/src/main/index.ts` (IPC + schedule), `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/env.d.ts`, `apps/desktop/src/renderer/pages/DashboardPage.tsx`
- Test: `apps/desktop/test/backups.test.ts`

**Interfaces:**
- Produces:
  - `BackupStatus = { folder: string; folderOk: boolean; last: string | null; keepDays: number }`
  - Local settings `local.backup.folder` (default `<Documents>/Fleetfix Backups`) and `local.backup.keepDays` (default 30), read and written by the main process in `server.db`.
  - `backupNow(db: Db, folder: string, garageName: string, now?: Date): string` — `VACUUM INTO` a `.partial` file then renames to `Fleetfix {garage} {YYYY-MM-DD HH-mm}.db`; returns the path.
  - `pruneBackups(folder: string, keepDays: number, now?: Date): number` — deletes only `Fleetfix *.db` files older than `keepDays`.
  - `backupStatus(folder: string, keepDays: number): BackupStatus`
  - `checkRestoreFile(file: string, schemaVersion: number): { garageName: string }` — throws "This file isn't a Fleetfix Garage Pro backup" or "This backup is from a newer version of the app. Update the app first."
  - `scheduleBackups(run: () => void, everyMs = 3_600_000): () => void` — main process runs a backup at start and hourly when the newest is over 24 h old.
  - IPC: `ffgp:backupStatus`, `ffgp:backupNow`, `ffgp:backupChooseFolder`, `ffgp:backupSetKeepDays`, `ffgp:restore`. Restore: refused on a cloud-linked PC with "This PC is linked to Fleetfix cloud. To get the garage back, disconnect and download it again."; else choose file → `checkRestoreFile` → confirm dialog naming the garage → back up current data → stop server → replace `garage.db` (and remove `-wal`/`-shm`) → `startLocal` → audit `backup.restore` → reload window. Client PCs have no backups.
  - Dashboard (PC holding the garage): red notice "Your last backup was {n} days ago" over 3 days, or "The backup folder can't be found (is the USB drive plugged in?)", linking to `/settings/backups`.
- [ ] **Step 1: Write the failing tests** (`backups.test.ts`): `backupNow` writes a readable copy that `checkRestoreFile` accepts and names the garage; `pruneBackups` deletes a 31-day-old `Fleetfix x.db` and keeps a 29-day-old one and an unrelated `notes.txt`; `backupStatus` on a missing folder → `folderOk false`; `checkRestoreFile` on a text file → "This file isn't a Fleetfix Garage Pro backup" (Review Focus 5); on a copy whose `schema_migrations` has id 99 → "…newer version…"; a refused restore leaves the current database unchanged.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/backups.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test && npm run e2e:electron` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "backups: daily copy on the PC, back up now, restore, dashboard warning"`

---

### Task 13: End-to-end check of the Settings feature

**Files:**
- Create: `apps/desktop/test/settings.spec.ts` (browser e2e, `playwright.config.ts`), extend `apps/desktop/test/electron.spec.ts`
- Modify: `README.md` (Settings section: what each tile holds; backups on PCs)

- [ ] **Step 1: Write the e2e:**
  - `settings.spec.ts` `"owner sets up the garage from Settings"`: tiles show "Logo missing" and the Getting ready bar; fill Garage details (IBAN), upload a logo, set terms → the preview frame contains the terms text before saving; Save; set Pricing labour rate 180 and advisor limit 10; set Numbering `invoiceStart` 500; the Getting ready bar disappears once all essentials are set (browser: 8); the activity log lists the changes; an advisor doesn't see Settings and a 15% discount asks for the Owner's approval; the issued invoice prints `INV-00500` with the logo, and a second print carries COPY; `/users` lands on Settings → Users & roles.
  - `"screen locks when idle"`: `page.clock.install()`, set lock to 5 min, `page.clock.fastForward("05:01")` → "Locked" visible; unlock with the password → unsaved text in an open form is still there.
  - `electron.spec.ts` `"backups on the PC"`: Backups tile, Back up now → status "Last backup … ago"; restore a non-backup file is refused with the plain message.
- [ ] **Step 2: Run** `npm run e2e && npm run e2e:electron` — Expected: PASS.
- [ ] **Step 3: Run** `npm test && npm run e2e:cloud && npm run e2e:sync` — Expected: PASS (nothing else broke; settings and new tables sync).
- [ ] **Step 4: Commit** `git commit -m "e2e: settings, printing, idle lock, backups; README"`
