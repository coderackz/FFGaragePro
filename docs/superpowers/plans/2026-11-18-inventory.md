# Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parts list, stock that comes off the shelf when a part is on a job card, suppliers (Fleet Fix built in), purchase orders with receiving, job cost/margin, and "Supplied by Fleet Fix" lines.

**Architecture:** New tables in migration 3. One server module `stock.ts` owns every stock movement and average-cost update; document routes call it on job-card saves and invoice issue. Purchasing lives in its own route file. The desktop app gets Parts, Suppliers and Purchase-order pages plus a part picker on the document editor.

**Tech Stack:** Existing: npm workspaces; Fastify 5 with `node:sqlite`; Zod 4; Vitest; React 19 with Tailwind 4; Playwright; Windows CI.

**Spec:** `docs/superpowers/specs/2026-11-18-inventory-design.md`

## Global Constraints
- **Migrations:** never edit migrations 1–2; add migration 3 (and later ones) in `packages/server/src/migrations.ts`.
- **Money:** integer fils only; average cost is rounded to whole fils with `roundFils`.
- **Quantities:** REAL; `on_hand` is rounded to 3 decimals after each movement (`Math.round(x*1000)/1000`).
- **Keys and timestamps:** every new row has a UUID (`newId()`) and created/updated ISO timestamps.
- **Writes:** every write runs inside one `db.tx`.
- **Cost fields** (`avgCostFils`, `unitCostFils`, `costFils`, `marginFils`, PO amounts) are left out of API responses unless `can(role, "costs.view")`. Advisors don't have that permission.
- **New permissions:** `inventory.edit` and `purchases.manage`, for Owner and Accountant only.
- **Stock history:** movements are append-only; never UPDATE or DELETE a `stock_movements` row.
- **Commits:** end each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Saving the same job card twice** (double-click, or two PCs) must not move stock a second time. Test in Task 3.
2. **Swapping a line's part from A to B** returns A and takes B. Setting the qty to 0 returns everything. Test in Task 3.
3. **Fractional litres** (4.5 + 0.7 − 5.2) must leave on-hand at exactly 0, not 1e-16. Test in Task 3.
4. **Over-receiving** (more than ordered, or receiving a fully received line again) → 400 with "more than ordered". Test in Task 4.
5. **An advisor fetching** `/api/parts`, `/api/documents/:id` or `/api/purchase-orders/:id` sees no cost fields. Test in Tasks 2, 3 and 4.

---

### Task 1: Shared rules, schemas, average cost

**Files:**
- Modify: `packages/shared/src/rules.ts`, `packages/shared/src/schemas.ts`, `packages/shared/src/money.ts`
- Test: `packages/shared/test/rules.test.ts`, `packages/shared/test/money.test.ts`, new `packages/shared/test/inventory.test.ts`

**Interfaces — Produces:**
- **Actions:** `"inventory.edit"` and `"purchases.manage"` added to `ACTIONS`. Owner gets all actions; accountant gets both new ones; advisor gets neither.
- `DOC_TYPES` is unchanged. Add `PO_STATUSES = ["draft","sent","part_received","received","cancelled"]` and `formatPoNumber(n) → "PO-00001"`.
- `averageCost(onHand: number, avgFils: number, qtyIn: number, costFils: number): number`. If `onHand <= 0`, it returns `costFils`; otherwise it returns `roundFils((onHand*avgFils + qtyIn*costFils)/(onHand+qtyIn))`.
- **Line fields:** `lineSchema` gains `partId: uuid().nullable().optional()`, `suppliedBy: enum(["garage","fleetfix"]).default("garage")` and `poLineId: uuid().nullable().optional()`. It refines so that `suppliedBy === "fleetfix"` requires `kind === "part"`.
- **Part schema:** `partSchema` has `partNo` (text 60, required), `name` (text 200, required), `brand?`, `unit` (default `"each"`), `stocked: boolean`, `sellPriceFils` (int ≥ 0), `reorderLevel` (≥ 0, default 0), `location?`, `fits?` and `active` (default true).
- **Supplier schema:** `supplierSchema` has `name` (required), `trn?`, `phone?`, `email?`, `address?` and `notes?`.
- **Adjustment schema:** `adjustmentSchema` has `qty` (non-zero number), `reason` (enum `count|damaged|lost|opening|other`) and `note?`.
- **PO line schema:** `poLineSchema` has `partId?`, `description` (required), `qty` (> 0), `unitCostFils` (int ≥ 0, default 0) and `jobDocumentId?`.
- **PO schema:** `poSchema` has `supplierId` (uuid), `notes?` and `lines` (array of `poLineSchema`, max 200).
- **Receive schema:** `receiveSchema` has `supplierInvoiceNo?`, `supplierInvoiceDate?`, `vatFils` (int ≥ 0) and `lines: {poLineId, qty>0, unitCostFils}[]` (min 1).
- **Request schema:** `requestPartSchema` has `documentId`, `position` (int ≥ 0), `supplierId` and `qty` (> 0). It also has `alreadyBought: boolean` (default false), plus `unitCostFils?` and `supplierInvoiceNo?`, which are used when `alreadyBought` is true.
- Export everything from `index.ts`.

- [ ] **Step 1: Write the failing tests**
  - **`averageCost`:** `averageCost(1, 4000, 1, 5000) === 4500`; `averageCost(0, 4000, 2, 5000) === 5000`; `averageCost(-2, 4000, 3, 6000) === 6000`.
  - **Roles:** `can("advisor","inventory.edit") === false`, `can("accountant","purchases.manage") === true`.
  - **Line schema:** `lineSchema.parse({kind:"labour", suppliedBy:"fleetfix", ...})` throws.
  - **PO number:** `formatPoNumber(7) === "PO-00007"`.
- [ ] **Step 2:** Run `npx vitest run packages/shared`. Expected: these tests FAIL.
- [ ] **Step 3:** Implement the interfaces above.
- [ ] **Step 4:** Run `npx vitest run packages/shared && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit with message `shared: inventory rules, schemas, average cost`.

### Task 2: Migration 3, parts, suppliers and adjustments API

**Files:**
- Modify: `packages/server/src/migrations.ts`, `packages/server/src/app.ts`
- Create: `packages/server/src/stock.ts` (movement core only), `packages/server/src/routes/parts.ts`
- Test: `packages/server/test/parts.test.ts`

**Migration 3 tables:** as in the spec's Data section. Also:
- `parts.part_no` gets a unique index (`COLLATE NOCASE`) among active parts.
- `document_lines` gets new columns `part_id`, `supplied_by TEXT NOT NULL DEFAULT 'garage'` and `po_line_id`.
- `stock_movements` gets indexes on `(part_id, created_at)` and `(document_id)`.
- The migration inserts the Fleet Fix supplier: name `"Fleet Fix"`, `is_fleetfix = 1`, fixed id `00000000-0000-4000-8000-0000000f1ee7`.

**Interfaces — Produces (`stock.ts`):**
- `postMovement(db, m: {partId, qty, reason: "receive"|"job"|"invoice"|"adjust"|"opening", unitCostFils?: number, documentId?: string|null, poLineId?: string|null, note?: string|null, userId: string}): void`
  - Inserts the movement. For `qty > 0` with a `unitCostFils`, it updates `avg_cost_fils` via `averageCost` before adding.
  - Outgoing movements store the current `avg_cost_fils` as their `unit_cost_fils`.
  - It then updates `on_hand` (rounded to 3 decimals) and `updated_at`.
  - Must be called inside `db.tx`.

**Routes (`partRoutes(app, db)`):**
- `GET /api/parts?q=&lowStock=1&active=` searches part_no, name, brand and fits, limit 300. `lowStock` means stocked and `on_hand <= reorder_level`.
- `GET /api/parts/:id` returns the part plus its last 200 movements, each with document number and user name.
- `POST /api/parts` and `PATCH /api/parts/:id` require `inventory.edit`.
  - Changing `stocked` while `on_hand != 0` → 409 "Bring the stock to zero before changing this".
  - A duplicate `part_no` → 409.
- `POST /api/parts/:id/adjustments` requires `inventory.edit` and posts reason `adjust`, or `opening` when the reason is `opening`. An opening adjustment takes `unitCostFils`.
- `GET /api/suppliers`, `POST /api/suppliers` and `PATCH /api/suppliers/:id`. The two writes require `purchases.manage`. The Fleet Fix row can be edited but not renamed (409 "Fleet Fix's name can't be changed").
- `partOut(row, showCost)` omits `avgCostFils` and `stockValueFils` when `showCost` is false.

- [ ] **Step 1: Write the failing tests** in `parts.test.ts`:
  - **"owner creates a stocked part, opening stock sets cost":** POST a part, adjustment `{qty:10, reason:"opening", unitCostFils:4000}` → `onHand 10`, `avgCostFils 4000`; the part page shows 1 movement.
  - **"advisor sees parts without cost and can't edit":** the GET list has no `avgCostFils` key; POST → 403.
  - **"low stock filter":** reorder level 5, on hand 3 → listed; on hand 6 → not listed.
  - **"can't switch stocked with stock on hand":** 409.
  - **"Fleet Fix supplier exists after setup":** listed with `isFleetfix: true`.
- [ ] **Step 2:** Run `npx vitest run packages/server/test/parts.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the migration, `postMovement` and the routes; register `partRoutes` in `app.ts`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: all PASS, including the 39 existing tests.
- [ ] **Step 5:** Commit with message `server: parts, suppliers, stock adjustments`.

### Task 3: Stock follows job cards and invoices

**Files:**
- Modify: `packages/server/src/stock.ts`, `packages/server/src/routes/documents.ts`
- Test: `packages/server/test/stock.test.ts`

**Interfaces:**
- **Consumes:** `postMovement` (Task 2).
- **Produces:** `reconcileDocumentStock(db, docId: string, userId: string): void` in `stock.ts`.
  - **Chain:** the document itself, plus its `source_id` document when that source is a job card. Estimates are never part of a chain.
  - **Wanted:** for each part, the sum of `qty` of this document's lines with `part_id` not null, `supplied_by = 'garage'` and `parts.stocked = 1`.
  - **Taken:** for each part, `-SUM(qty)` of the movements whose `document_id` is in the chain.
  - **Post:** for each part in wanted ∪ taken where `round3(wanted − taken) != 0`, post `qty = -(wanted − taken)` with `documentId = docId`. The reason is `job` for a job card and `invoice` for an invoice.

**Document route changes:**
- **`writeLines`:**
  - Stores `part_id`, `supplied_by` and `po_line_id`.
  - A `fleetfix` line is saved with `unit_price_fils = 0` and `discount_pct = 0`, whatever was sent.
  - An unknown `partId` → 400 "Part not found".
- **Saves:** after `writeLines` on a **job card** (both PATCH and PUT lines), call `reconcileDocumentStock`.
- **Issue:** on **invoice issue**, call `reconcileDocumentStock`. Convert copies `partId`, `suppliedBy` and `poLineId`, and moves nothing.
- **`full()` line output:**
  - Adds `partId`, `partNo`, `suppliedBy` and `poLineId`.
  - Adds `orderStatus`: `"on_order"` while `received_qty < qty` on the PO line, `"received"` once received, otherwise null.
  - With `costs.view`, also adds per-line `costFils` and the document-level `partsCostFils`, `marginFils` and `costPending: boolean`.
- **Line cost:** a stocked line costs −(sum of `qty × unit_cost_fils` of the chain's movements for that part) × (line qty / wanted qty for that part). A non-stocked line with a received PO line costs `po_lines.unit_cost_fils × qty`. A non-stocked line with no received PO line → `costPending`. Fleet Fix lines and free-text lines cost 0. **Margin** = `net_fils − partsCostFils`.
- `full()` takes `showCost: boolean`, which callers pass from `can(user.role, "costs.view")`.

- [ ] **Step 1: Write the failing tests** in `stock.test.ts`. Use a helper `onHand(app, token, partId)`. Start each test from stocked part A (10 on hand, cost 40.00) and part B (5 on hand).
  - **"estimate never moves stock":** an estimate with 2×A leaves A at 10.
  - **"job card takes, edits and returns":** JC with 2×A → 8; qty 3 → 7; save the same lines again → still 7 with 2 movements total; qty 0 → 10.
  - **"swapping a line's part returns A and takes B":** 1×A changed to 1×B → A 10, B 4.
  - **"convert moves nothing; issue moves only the extra":** JC 2×A → INV (A still 8); add 1×A on the draft invoice (A still 8); issue → 7.
  - **"counter-sale invoice takes stock at issue":** draft 1×A → 10; issue → 9.
  - **"Fleet Fix and free-text lines never move stock; Fleet Fix line is zero-priced":** send `unitPriceFils 9900` with `suppliedBy:"fleetfix"` → saved as 0; A unchanged.
  - **"stock can go negative":** JC 12×A → −2.
  - **"fractional litres":** a stocked oil part with 10 L; JC lines 4.5 and 0.7 → 4.8, then change to 5.2 total → exactly 4.8; `onHand` is `toBe(4.8)`.
  - **"advisor sees no cost on documents; owner sees margin":** JC 2×A sold at 60.00 → owner `partsCostFils 8000`, `marginFils 4000`; the advisor response has no `partsCostFils` or `costFils` keys.
- [ ] **Step 2:** Run `npx vitest run packages/server/test/stock.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the reconcile function and the route changes.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5:** Commit with message `server: stock follows job cards and invoices`.

### Task 4: Purchase orders, requests from jobs, receiving

**Files:**
- Modify: `packages/server/src/migrations.ts` (only if a column is missing: add migration 4, never edit 3 once committed), `packages/server/src/app.ts`
- Create: `packages/server/src/routes/purchases.ts`
- Test: `packages/server/test/purchases.test.ts`

**Interfaces:**
- **Consumes:** `postMovement`; the schemas from Task 1.
- **Numbering:** PO numbers come from `counters` with type `"purchase_order"` and `formatPoNumber`.

**Routes:**
- **`GET /api/purchase-orders?status=&supplierId=`** returns a list. Advisors may read it, without amounts.
- **`GET /api/purchase-orders/:id`** returns the PO with its lines (and job document numbers) and receipts.
- **`POST /api/purchase-orders` and `PATCH /api/purchase-orders/:id`:**
  - Both require `purchases.manage`.
  - Lines can be edited only while the PO is `draft`.
  - Status can be set by hand to `sent` or `cancelled`. Cancelling is allowed only when nothing has been received.
- **`POST /api/purchase-orders/:id/receive`:**
  - Requires `purchases.manage`; takes `receiveSchema`.
  - Each line qty must be ≤ `qty − received_qty`; otherwise 400 "Receiving more than ordered".
  - Creates a `goods_receipts` row (net = Σ qty × cost, the given VAT, gross) and its lines, and updates `po_lines.received_qty` and `unit_cost_fils`.
  - For stocked parts, calls `postMovement({reason:"receive", qty, unitCostFils, poLineId})`.
  - Sets the PO status to `part_received` or `received`.
- **`POST /api/purchase-requests`:**
  - Requires `documents.edit`; takes `requestPartSchema`.
  - The document must be an editable job card. The line at `position` must be a garage-supplied part line with no `po_line_id`; otherwise 400 "This line is already requested".
  - Finds the supplier's newest `draft` PO or creates one, then adds a PO line with `partId`, the line's description and qty, and `jobDocumentId`. It sets `document_lines.po_line_id`.
  - With `alreadyBought`, which also requires `purchases.manage` (otherwise 403), it immediately receives that one line at `unitCostFils`, records `supplierInvoiceNo`, and marks the PO `received`.
  - Returns `{ document: full(...) }`.

- [ ] **Step 1: Write the failing tests** in `purchases.test.ts`:
  - **"advisor requests a part from a job card; accountant prices, sends, receives; job cost appears":**
    1. Use non-stocked part C. The JC line 1×C reads `orderStatus "on_order"`.
    2. The draft PO for Fleet Fix holds the line, and `PO-00001` exists.
    3. Receive at 120.00 → the line becomes `"received"`, the owner sees `partsCostFils 12000`, and `costPending false`.
  - **"receiving a stocked part averages the cost":** A has 1 on hand at 40.00; receive 1 at 50.00 → `avgCostFils 4500`, `onHand 2`.
  - **"part receiving and over-receiving":** order 5; receive 2 → `part_received`; receive 4 → 400 with message containing "more than ordered"; receive 3 → `received`; receive 1 → 400.
  - **"already bought, one step":** the accountant requests with `alreadyBought: true, unitCostFils 3000` → PO `received`, job line `received`. An advisor sending `alreadyBought` → 403.
  - **"advisor sees no PO amounts":** the advisor GETs the PO → no `unitCostFils` or totals keys.
  - **"can't request the same line twice":** 400.
- [ ] **Step 2:** Run `npx vitest run packages/server/test/purchases.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the routes; register `purchaseRoutes` in `app.ts`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5:** Commit with message `server: purchase orders, part requests, receiving`.

### Task 5: Parts CSV import

**Files:**
- Modify: `packages/server/src/routes/parts.ts`
- Create: `packages/server/src/csv.ts`
- Test: `packages/server/test/parts-import.test.ts`

**Interfaces — Produces:**
- `parseCsv(text: string): string[][]` handles quoted fields, `""` escapes, CRLF and a BOM.
- **`POST /api/parts/import`:**
  - Takes `{ csv: string, dryRun: boolean }` and requires `inventory.edit`.
  - Header columns are matched case-insensitively: `part_no`, `name`, `brand`, `unit`, `stocked` (yes/no/1/0), `sell_price` (AED), `cost` (AED), `qty`, `reorder_level`, `location` and `fits`.
  - Returns `{ created, updated, errors: {row, message}[] }`. If there are any errors, nothing is written.
  - An existing `part_no` updates the part's details. A `qty` posts an `opening` movement only for newly created stocked parts.

- [ ] **Step 1: Write the failing tests:**
  - **Valid file:** 3 rows (one quoted name with a comma; one with a BOM header) → `created 3`; opening stock and cost are set.
  - **Bad row:** a row with `sell_price "abc"` → `errors[0].row === 3` and nothing created.
  - **Dry run:** writes nothing.
- [ ] **Step 2:** Run the test file. Expected: FAIL.
- [ ] **Step 3:** Implement the parser and the route.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `server: parts CSV import`.

### Task 6: Desktop — Parts, Suppliers, dashboard

**Files:**
- Create: `apps/desktop/src/renderer/pages/PartsPage.tsx`, `PartPage.tsx`, `SuppliersPage.tsx`, `components/PartImportDialog.tsx`
- Modify: `App.tsx` (routes `/parts`, `/parts/:id`, `/suppliers`), `components/Layout.tsx` (nav "Parts", "Suppliers"), `lib/types.ts`, `pages/DashboardPage.tsx` (a "Low stock: N" tile linking to `/parts?lowStock=1`)

- **Parts page:** a table with columns Part no, Name, Brand, On hand (red when below 0 or at/below reorder level), Sell price, and Cost (only with `costs.view`). It has search, a "Low stock" toggle, and "New part" and "Import CSV" buttons (with `inventory.edit`).
- **Part page:** the edit form, an "Adjust stock" dialog (qty ±, reason, note; plus cost when the reason is opening), and the movement history table (date, reason, document link, qty, user).
- **Suppliers page:** a list with an inline add/edit dialog. Fleet Fix shows a lime "Fleet Fix" badge.
- [ ] **Step 1:** Build the pages using the existing `ui.tsx`/`forms.tsx` components and `useApi`.
- [ ] **Step 2:** Run `npm run typecheck`. Expected: PASS.
- [ ] **Step 3:** Run `npm run dev` and check the pages by eye as owner and as advisor (no cost column, no edit buttons).
- [ ] **Step 4:** Commit with message `desktop: parts, suppliers, low stock`.

### Task 7: Desktop — parts on the document editor

**Files:**
- Create: `apps/desktop/src/renderer/components/PartPicker.tsx`, `components/RequestPartDialog.tsx`
- Modify: `pages/DocumentPage.tsx`, `print/templates.ts`, `lib/types.ts`

- **Picker:** a part line's description field becomes a combobox. Typing searches `/api/parts?q=&active=1`; choosing a part fills `partId`, the description (`"<name> (<partNo>)"`) and `unitPriceFils`. Typing without choosing keeps a free-text line (`partId` null). The dropdown shows on-hand next to each part.
- **Line controls:**
  - A "Supplied by Fleet Fix" checkbox on part lines sets `suppliedBy` and locks the price at 0.
  - A **Request part** button on job-card part lines with no `poLineId` saves first if anything changed, then opens the dialog. The dialog has the supplier (default Fleet Fix), qty and, for `purchases.manage` only, "Already bought" with cost and supplier invoice no.
  - A badge shows "On order" or "Received".
  - A warning appears when a stocked part would go below zero, using the on-hand from the picker.
- **Summary card:** shows "Parts cost", "Margin" and "Cost pending" when the response has them.
- **Print:** Fleet Fix lines print "Supplied by Fleet Fix" under the description, at 0.00.
- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 3:** Check by eye in `npm run dev`. On a JC: pick part A, save, and the Parts page shows on-hand −1. Request a part and the PO appears.
- [ ] **Step 4:** Commit with message `desktop: part picker, Fleet Fix lines, request part, job margin`.

### Task 8: Desktop — purchase orders

**Files:**
- Create: `pages/PurchaseOrdersPage.tsx`, `pages/PurchaseOrderPage.tsx`, `components/ReceiveDialog.tsx`
- Modify: `App.tsx` (`/purchase-orders`, `/purchase-orders/new`, `/purchase-orders/:id`), `Layout.tsx` (nav "Purchases"), `print/templates.ts` (PO template, English with Arabic title "أمر شراء")

- **List:** filters by status and supplier.
- **Editor:** supplier, lines (part picker reused, qty, unit cost), notes, plus Send, Cancel, Print/PDF and Receive.
- **Receive dialog:** a remaining-qty row per line (prefilled), unit cost, supplier invoice no and date, and VAT, prefilled at 5% of net and editable.
- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `npm run typecheck`. Expected: PASS.
- [ ] **Step 3:** Check by eye: create, send, part-receive and receive; print a PDF.
- [ ] **Step 4:** Commit with message `desktop: purchase orders and receiving`.

### Task 9: End-to-end, Windows CI, README

**Files:**
- Modify: `apps/desktop/test/flow.ts`, `apps/desktop/test/workflow.spec.ts`, `apps/desktop/test/electron.spec.ts`, `README.md`

- Add `stockDay(page, shot)` to `flow.ts`, run after `garageDay`:
  1. Create stocked part "Oil filter" (`OF-1001`) with opening stock 10 at AED 18.00, selling at AED 35.00.
  2. Create non-stocked part "Brake disc" (`BD-220`).
  3. On a new JC, pick the oil filter ×1 and the brake disc ×2; request the discs from Fleet Fix.
  4. As owner, receive the PO at AED 150.00.
  5. Convert to an invoice and issue it.
  6. Check: Parts shows the oil filter with **9**; the invoice summary shows parts cost **AED 318.00**.
- [ ] **Step 1:** Implement `stockDay`; call it in workflow.spec and electron.spec, and screenshot the parts page and PO.
- [ ] **Step 2:** Run `npm run e2e && npm run e2e:electron`. Expected: PASS.
- [ ] **Step 3:** Add an Inventory section to the README (what moves stock and when). Commit.
- [ ] **Step 4:** Push the branch; run `gh workflow run windows.yml --ref feature/inventory`; wait; `gh run download <id> -n windows-test-results` and check the screenshots. Expected: green.
