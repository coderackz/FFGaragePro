# Parts requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Advisors request parts without a vendor; Owner/Accountant ask several vendors for prices (WhatsApp/email with the vehicle and VIN, Mulkiya when ticked), choose per part, order and send the order; advisors never see vendors.

**Architecture:** A request is a `purchase_orders` row with `supplier_id NULL` and `job_document_id` set. Vendors asked are `po_quotes`, their prices `po_quote_prices` (deterministic ids so two PCs never duplicate). Ordering assigns vendors, moving lines to new POs per extra vendor. Messages to vendors reuse the outbox (email) and the WhatsApp click-to-chat, tagged with `po_id`/`supplier_id` and hidden from roles without `purchases.manage`.

**Tech Stack:** Electron + React/TS + Tailwind; Fastify + node:sqlite; npm workspaces; Vitest; Playwright.

**Spec:** docs/superpowers/specs/2026-11-26-parts-requests-design.md

## Global Constraints

- Migration 29; SCHEMA_VERSION gates sync; the cloud is updated before the PCs.
- Money in integer fils; costs only for `costs.view`; vendors only for `purchases.manage` (supplier list/details, PO list/details, vendor messages, used-parts-to-buy list).
- A PO without a vendor can't be received, marked sent, or sent to anyone; it can be cancelled.
- Fleet Fix is never preselected.
- Vendor messages carry no customer name and no plate; Mulkiya only when ticked.
- Works offline, PC and browser app, 1024–1440 px.

## Review Focus

1. Two PCs offline: both request on the same job card, or both ask the same vendor — no duplicate quotes, no lost lines after sync.
2. A job card line removed or its text changed after it was requested, then the request is ordered — the job card keeps or drops the link sensibly (existing unlinkJobs rules), no crash.
3. Order with some parts unpriced, and with every part from one vendor — the request keeps its number, the leftovers start a new request.
4. An advisor calling vendor APIs directly (supplier list, PO by id, messages list with a vendor message) — refused or filtered.
5. A request asked to vendors, then a new part requested on the same job card — it joins the request and shows as not sent to the vendors already asked.

---

### Task 1: Migration 29, shared schemas and types, sync tables

**Files:** packages/server/src/migrations.ts; packages/shared/src/schemas.ts (+ index export); packages/sync/src/tables.ts; apps/desktop/src/renderer/lib/types.ts; tests packages/server/test/parts-requests.test.ts (migration part), packages/sync/test/parts-requests.test.ts.

**Produces:**
- Migration 29 (foreignKeysOff `purchase_orders`, `po_lines`, `goods_receipts`): `purchase_orders` rebuilt with `supplier_id TEXT REFERENCES suppliers(id)` (nullable) and `job_document_id TEXT REFERENCES documents(id)`; index `purchase_orders_supplier` recreated, `purchase_orders_job` on (job_document_id, status).
  `po_quotes(id PK = poId + ':' + supplierId, po_id NOT NULL REFERENCES purchase_orders, supplier_id NOT NULL REFERENCES suppliers, asked_at TEXT, created_by, created_at, updated_at)`;
  `po_quote_prices(id PK = quoteId + ':' + poLineId, quote_id NOT NULL REFERENCES po_quotes, po_line_id NOT NULL REFERENCES po_lines, unit_cost_fils INTEGER NULL, created_at, updated_at)`;
  `vehicle_files(id PK = vehicleId + ':' + kind, vehicle_id NOT NULL REFERENCES vehicles, kind CHECK IN ('mulkiya_front','mulkiya_back'), file_name, data_base64, created_at, updated_at)`;
  `messages.po_id`, `messages.supplier_id`.
- SYNC_TABLES: `vehicle_files` after vehicles; `po_quotes`, `po_quote_prices` after po_lines.
- Shared: `requestPartSchema.supplierId` optional (required when `alreadyBought`); `requestPartsSchema {documentId}`; `askVendorsSchema {vendors: ({supplierId} | {name, phone, email})[] min 1}`; `quotePricesSchema {prices: {supplierId, poLineId, unitCostFils: money|null}[]}`; `orderRequestSchema {version, choices: {poLineId, supplierId}[] min 1}`; `vehicleFileSchema {kind, fileName, base64 ≤ 3 MB, jpeg/png}`; `messageInputSchema` event adds `parts_request`, `purchase_order`, optional `poId`, `supplierId`.

- [ ] Tests: a v28 database migrates with POs, lines, receipts and suppliers intact and `supplier_id` now nullable; sync: a vendorless PO, a quote with prices and a Mulkiya file reach the other computer; the same quote made on two PCs is one row.
- [ ] Implement, typecheck, commit.

### Task 2: Server — advisors see no vendors; Request part without a vendor

**Files:** packages/server/src/routes/purchases.ts, parts.ts (supplier list), payables.ts (supplier by id), messages outbox/routes, documents.ts (orderStatus); test packages/server/test/parts-requests.test.ts.

**Interfaces:** `POST /api/purchase-requests` without `alreadyBought` → the job card's open request (`supplier_id IS NULL AND job_document_id = doc AND status = 'draft'`) or a new one; `supplierId` ignored. With `alreadyBought` → `supplierId` required ("Choose the supplier"). `POST /api/purchase-requests/all {documentId}` → every requestable line not linked to a stocked part; 400 "Nothing to request" when none. Document line `orderStatus`: `"requested"` when its PO has no vendor.

- [ ] Tests: advisor 403 on GET /api/suppliers, /api/suppliers/:id, /api/purchase-orders, /api/purchase-orders/:id, /api/used-parts-to-buy; vendor messages absent from the advisor's GET /api/messages and 404 by id. Request part by an advisor → PO with no vendor, line "requested"; a second line joins it; Request all takes the rest, skips stocked/used/Fleet Fix/linked; a supplierId sent anyway is ignored; Already bought without a supplier 400.
- [ ] Implement, commit.

### Task 3: Server — asking vendors, prices, ordering, sending

**Interfaces:**
- `GET /api/purchase-orders/:id` adds `supplier: null` for a request, `jobDocument {id, number, vehicle {make, model, year, engine, vin}, mulkiya {front, back}: boolean}`, `quotes: {supplierId, name, phone, email, askedAt, prices: {poLineId, unitCostFils|null}[]}[]` (prices only with costs.view), `messages` (sent to vendors about this PO).
- `GET /api/parts-requests` → open requests: `{id, number, createdAt, jobDocumentNumber, vehicle, lineCount, asked, priced}` oldest first.
- `POST /api/purchase-orders/:id/quotes` (askVendorsSchema) → adds vendors (new ones saved as suppliers; same phone = same supplier); idempotent per vendor.
- `PUT /api/purchase-orders/:id/quote-prices` (quotePricesSchema).
- `POST /api/purchase-orders/:id/order` (orderRequestSchema) → groups by vendor in line order; group 1 keeps this PO (vendor set, lines priced, status sent); others get new POs (sent) with lines moved; unchosen lines move to a new request (same job). Returns `{ purchaseOrders: [...] }`. Refuses: not a request, version changed, a chosen vendor not asked or without a price for that line.
- `POST /api/purchase-orders/:id/sent-to {supplierId, channel, recipient}` → records `asked_at` for a request's quote, or marks a draft PO sent; messages carry `po_id`, `supplier_id`.
- Receive / mark sent on a PO without a vendor → 409 "Choose the vendor first".

- [ ] Tests for each, incl. Review Focus 3 and 5; prices hidden without costs.view.
- [ ] Implement, commit.

### Task 4: Server — Mulkiya on the vehicle

**Interfaces:** `PUT /api/vehicles/:id/files/:kind` (vehicleFileSchema, `customers.edit`), `DELETE` same, `GET /api/vehicles/:id/files/:kind` → `{fileName, base64}`; vehicle out gains `mulkiya: {front, back}` booleans.

- [ ] Tests: put, replace, get, delete; advisor may; bad type 400.
- [ ] Implement, commit.

### Task 5: Screens — job card, menu, vehicle, shelf hint

**Files:** LinesTable.tsx, DocumentPage.tsx, RequestPartDialog.tsx → AlreadyBoughtDialog, nav.ts, App routes guard, forms.tsx (VehicleFormModal Mulkiya), PartPicker.tsx, BuyUsedPartDialog (unchanged), PurchaseOrderPage (no Fleet Fix default).

- [ ] Request part = one click (toast "Requested on PO-…"); "Request parts (N)" on the job card; "Already bought" for purchases.manage; badges Requested/On order/Received; advisors' menu without Purchases and Suppliers; Mulkiya front/back in the vehicle form (shrunk to 1600 px JPEG); shelf hint "On the shelf: … — Use it".

### Task 6: Screens — requests, vendors' prices, order, send

**Files:** PurchaseOrdersPage.tsx (Parts requests card), PurchaseOrderPage.tsx (request view), new components AskVendorsDialog.tsx, QuoteTable.tsx, SendToVendorDialog.tsx; print/templates.ts `renderPriceRequestHtml`; messages helpers for vendors.

- [ ] Request view as in the spec sketch; Ask vendors → per vendor Send by WhatsApp/email (PDF; Mulkiya when ticked); price grid with cheapest preselected; Order confirm; Send to vendor on ordered POs.

### Task 7: E2E, help, README

- [ ] `apps/desktop/test/parts-requests.spec.ts` + `playwright.requests.config.ts` + `npm run e2e:requests`: advisor requests two parts (no vendor anywhere), accountant asks two vendors (email + WhatsApp logged), types prices, orders (two POs), sends one, receives; job card shows Received; advisor 403 on vendor screens. Update used.spec (advisor no longer sees the Purchases list). Help guide "Purchases and stock" and README.
