# Used Parts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A part on a job can be marked Used, bought for that job with its seller, date, VAT and warranty, and printed as used; its cost never disappears from the job, and no VAT is claimed that wasn't on a bill.

**Architecture:** A `condition` on document lines and purchase order lines, and warranty days on purchase order lines. Buying a used part makes a one-line purchase order already received, through the existing `createPo` / `addLine` / `receive`, so cost, supplier balance, books and sync work unchanged. Warranty end, VAT default and print wording are pure functions in `packages/shared`.

**Tech Stack:** TypeScript, zod (packages/shared), Fastify + `node:sqlite` (packages/server), packages/sync, React + Tailwind (apps/desktop renderer), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-used-parts-design.md`

## Global Constraints

- Branch `feature/used-parts` from `main` (492af8b). Migration **28** only adds columns. The cloud is updated before the PCs.
- A used line never has a part, units or a kit, and is never supplied by Fleet Fix; the server enforces it.
- An older screen that leaves out `condition` keeps what's stored. A line linked to a used purchase is always used.
- Warranty is one date: purchase date + days, inclusive (26 Nov + 7 = through 3 Dec). The purchase date is `goods_receipts.supplier_invoice_date`. Dates are Dubai's (`dubaiDate`).
- Warranty choice is required: 1–365 days, or `null` for none. The screen preselects nothing.
- Costs, sellers and VAT only to roles with `costs.view`, in the API too. Buying needs `purchases.manage`; ticking Used needs `documents.edit`.
- Seller, price paid and PO number never print for the customer. Issued invoices never change.
- Purchases already recorded and sales VAT are not changed. No profit margin scheme.
- Fleet Fix always starts at the garage's VAT rate; another supplier with no TRN starts at 0.
- Line ids change on every save: the API names a line by `documentId` + `position` + `description`, as Request part does.
- Works offline, PC and browser app, 1024–1440 px. Follow the code around each change.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is pushed or deployed by this plan.

## Review Focus

1. **Two computers buy the same used line offline** — after sync both purchases are kept; the one not on the line shows under "Bought for this job, not charged". Test in Task 4.
2. **A job card becomes an invoice before its used part is bought** — the cost shows as pending, not 0, and converting asks first. Tests in Tasks 4 and 6.
3. **A line's text is edited after it was bought** — it stays used, linked, with its warranty. Test in Task 2.
4. **Buying with a quantity below the line's** — refused, so the job never shows cost for parts nobody bought. Test in Task 3.
5. **A purchase entered at 2 am Dubai, or dated in a locked month** — the date is Dubai's; the books take a locked date as they do for any receipt. Test in Task 3.

## Files

- Create: `packages/shared/src/used.ts`, `packages/server/src/used.ts`, `apps/desktop/src/renderer/components/BuyUsedPartDialog.tsx`, `apps/desktop/src/renderer/components/UsedPartsToBuy.tsx`, `playwright.used.config.ts`, `apps/desktop/test/used.spec.ts`
- Tests: `packages/shared/test/used.test.ts`, `packages/server/test/used-parts.test.ts`, `packages/sync/test/used-parts.test.ts`

---

### Task 1: Rules (shared)

**Files:** Create `packages/shared/src/used.ts` (exported from `index.ts`), `packages/shared/test/used.test.ts`. Modify `packages/shared/src/schemas.ts` (`lineSchema`, new `usedPurchaseSchema`).

**Interfaces (produces):**
- `LINE_CONDITIONS = ["new", "used"] as const`; `type LineCondition`.
- `warrantyUntil(purchasedOn: string, days: number | null): string | null`
- `warrantyState(until: string | null, today: string): "none" | "ok" | "ending" | "ended"` — ending = the last day and the day before.
- `usedPartText(l: { condition: LineCondition; purchasedOn: string | null; warrantyDays: number | null }, docType: DocType, onDate: string): { en: string; ar: string } | null`
- `defaultPurchaseVat(netFils: number, supplier: { trn: string | null; isFleetfix: boolean }, rateBp: number): number`
- `lineSchema.condition: LineCondition | undefined`. Refine: used needs kind `part`, no `partId`, no `unitIds` ("A used part isn't linked to the parts list") and `suppliedBy` garage ("A used part can't be supplied by Fleet Fix").
- `usedPurchaseSchema`: `{ documentId, position, description, qty, seller: { supplierId } | { name, phone }, unitCostFils, purchasedOn: ymd, bill: null | { trn: 15 digits, invoiceNo: 1–60, vatFils }, warrantyDays: int 1–365 | null (required) }`.

- [ ] **Step 1: Failing tests**

```ts
expect(warrantyUntil("2026-11-26", 7)).toBe("2026-12-03");
expect(warrantyUntil("2026-11-26", null)).toBeNull();
expect(["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"].map((d) => warrantyState("2026-12-03", d))).toEqual(["ok", "ending", "ending", "ended"]);
expect(warrantyState(null, "2026-12-01")).toBe("none");
const used = { condition: "used" as const, purchasedOn: "2026-11-26", warrantyDays: 7 };
expect(usedPartText(used, "jobcard", "2026-12-01")).toEqual({ en: "Used part", ar: "قطعة مستعملة" });
expect(usedPartText(used, "invoice", "2026-12-03")!.en).toBe("Used part, warranty until 3 Dec 2026");
expect(usedPartText(used, "invoice", "2026-12-04")!.en).toBe("Used part, no warranty remaining");
expect(usedPartText({ ...used, warrantyDays: null }, "invoice", "2026-12-01")!.en).toBe("Used part, no warranty");
expect(usedPartText({ ...used, purchasedOn: null, warrantyDays: null }, "invoice", "2026-12-01")!.en).toBe("Used part"); // not bought yet
expect(usedPartText({ ...used, condition: "new" }, "invoice", "2026-12-01")).toBeNull();
expect(defaultPurchaseVat(15000, { trn: null, isFleetfix: false }, 500)).toBe(0);
expect(defaultPurchaseVat(15000, { trn: "100123456700003", isFleetfix: false }, 500)).toBe(750);
expect(defaultPurchaseVat(15000, { trn: null, isFleetfix: true }, 500)).toBe(750);
```
Also: `lineSchema` refuses used + `partId`, used + fleetfix, used labour; `usedPurchaseSchema` refuses a missing `warrantyDays`, 0, 366, and a bill with a 14-digit TRN; accepts `warrantyDays: null` and `bill: null`.

- [ ] **Step 2:** `npx vitest run packages/shared/test/used.test.ts` — FAIL (no module).
- [ ] **Step 3:** Implement the functions and schemas above. Arabic endings: `الضمان حتى {date}`, `انتهى الضمان`, `بدون ضمان`.
- [ ] **Step 4:** Same command — PASS.
- [ ] **Step 5:** Commit `feat(used): rules for used parts, their warranty and purchase VAT`.

### Task 2: Used on document lines (migration 28, server)

**Files:** Modify `packages/server/src/migrations.ts`, `packages/server/src/routes/documents.ts` (`writeLines`, `keepDetails`, `full`, convert at ~518, `currentLines` at ~763, credit note insert at ~676). Test `packages/server/test/used-parts.test.ts`, `packages/sync/test/used-parts.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces: `document_lines.condition` and `po_lines.condition` (`TEXT NOT NULL DEFAULT 'new' CHECK (condition IN ('new','used'))`), `po_lines.warranty_days INTEGER`. Each line of `full()` gains `condition`, `purchasedOn: string | null`, `warrantyDays: number | null`, `warrantyUntil: string | null` (visible to every role; from the linked used po line and its latest receipt date, null otherwise).

- [ ] **Step 1: Failing tests** (server)
  - "used carries from estimate to job card to invoice to credit note": `condition` is `"used"` on each.
  - "an older screen keeps used": PUT lines without `condition`, same kind and text → `"used"`; with a picked `partId` and other text → `"new"`.
  - "used with a part, or from Fleet Fix, is refused": 400.
  - "a bought used line can't become new and survives a text edit": link a used po line in the database; PUT `condition: "new"` with its `poLineId` and different text → `condition "used"`, same `poLineId`, same `warrantyUntil`.
  - "a used line moves no stock": job card with a used line → no rows in `stock_movements`.
  - migration: a version-27 database with lines opens at 28 with every line `"new"`.
  - (sync) a used line and a po line with `warranty_days: 7` arrive on the other side unchanged.
- [ ] **Step 2:** `npx vitest run packages/server/test/used-parts.test.ts packages/sync/test/used-parts.test.ts` — FAIL.
- [ ] **Step 3:** Implement. `keepDetails` keeps `condition` by its existing same-line rule; then a line whose resolved `poLineId` is a used po line is forced to `"used"` with part, units and kit cleared; a line that isn't kind `part` is `"new"`.
- [ ] **Step 4:** Same command, then `npx vitest run packages/server packages/sync` — PASS.
- [ ] **Step 5:** Commit `feat(used): used parts on estimates, job cards, invoices and credit notes`.

### Task 3: Buying, VAT and dates (server)

**Files:** Create `packages/server/src/used.ts`. Modify `packages/server/src/routes/purchases.ts`. Test `packages/server/test/used-parts.test.ts`, `packages/server/test/purchases.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `POST /api/used-purchases` (`usedPurchaseSchema` → `{ document }`); `GET /api/used-parts-to-buy` → `{ items: { documentId, documentNumber, position, description, qty, customerName, plate }[] }` (used part lines with no po line on job cards not converted; no costs; any signed-in role); `purchaseOrders[].usedPart: boolean` (every line used). `POST /api/purchase-requests` accepts optional `purchasedOn`.
- `used.ts`: `usedPartsToBuy(db)`, `resolveSeller(db, seller, bill): string` (supplier id). A typed seller whose phone digits match a saved supplier uses that supplier; otherwise one is created. The bill's TRN is saved on a supplier that has none; a different saved TRN → 409 "This seller has another TRN saved".

- [ ] **Step 1: Failing tests**
  - "no VAT bill": AED 150, 7 days, bought 2026-11-26 → receipt `{ net_fils: 15000, vat_fils: 0, supplier_invoice_date: "2026-11-26" }`; po `received`, `usedPart: true`; line `costFils: 15000`, `warrantyUntil: "2026-12-03"`; no `parts` row made; supplier made with name and phone.
  - "VAT bill": TRN and 750 VAT stored; TRN now on the supplier.
  - refused: advisor (403); date after today in Dubai (400); line not used (400); already bought (400); job card converted (400); quantity below the line's (400 "Buy at least the 2 on the job card"); text changed on another PC (409).
  - "same phone, typed another way, is the same seller": `0501234567` then `+971 50 123 4567` → one supplier.
  - "2 am in Dubai" (fake clock 2026-11-25T22:30Z): `purchasedOn: "2026-11-26"` accepted; "Already bought" without a date stores `2026-11-26`.
  - "a purchase dated in a locked month" posts on the first open day with its original date, as a goods receipt does.
  - "VAT left out": supplier without TRN → 0; with TRN → 5%; Fleet Fix → 5%.
  - Request part on a used line → 400 "Use Buy used part".
  - "used parts to buy": lists an unbought used line; gone once bought, unticked or converted; carries no cost key.
- [ ] **Step 2:** `npx vitest run packages/server/test/used-parts.test.ts packages/server/test/purchases.test.ts` — FAIL.
- [ ] **Step 3:** Implement with the existing `createPo`, `addLine` (gains `condition`, `warrantyDays`) and `receive`, in one `db.tx`; reserve the PO number first, as `purchase-requests` does. Apply the supplier's advance as receiving does.
- [ ] **Step 4:** Same command, then `npx vitest run packages/server` — PASS.
- [ ] **Step 5:** Commit `feat(used): buy a used part for a job; purchase VAT follows the supplier's TRN`.

### Task 4: A bought part's cost stays on the job (server)

**Files:** Modify `packages/server/src/stock.ts` (`documentCost`), `packages/server/src/routes/documents.ts` (`full`). Test `packages/server/test/used-parts.test.ts`, `packages/sync/test/used-parts.test.ts`.

**Interfaces (produces):** `unchargedPurchases(db, docId): { poLineId, partId, description, condition, qty, costFils }[]` — po lines received for this document's chain (not cancelled), whose part is none or not stocked, with received quantity above the quantity on this document's lines linked to them; `qty` is the difference, `costFils` at what was paid. Empty for estimates and credit notes. `full()` gains `uncharged` (without `costFils` unless `costs.view`); `partsCostFils` includes them. A used line without a purchase has cost `null` (pending).

- [ ] **Step 1: Failing tests**
  - Bought 150, sold 300, line removed → `uncharged` one item of 1, `partsCostFils: 15000`; advisor sees the item with no `costFils`.
  - Put back: PUT a line with that `poLineId` → `uncharged: []`, line `condition: "used"`, cost 15000.
  - Bought 2 at 100, line 1 → `uncharged` qty 1, `partsCostFils: 20000`.
  - Removed on the draft invoice only → on the invoice's `uncharged`; the job card's stays empty.
  - Not bought: `costPending: true`, also after converting to an invoice.
  - A stocked part bought for a job and removed is not in `uncharged` (it's back on the shelf).
  - Books on: after the invoice is issued, the cost of parts posted equals the invoice's `partsCostFils`.
  - (sync) two sides buy the same line offline → after sync both have two purchases, one on the line, one in `uncharged`.
- [ ] **Step 2:** `npx vitest run packages/server/test/used-parts.test.ts packages/sync/test/used-parts.test.ts` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run` — PASS (whole suite; `documentCost` is used widely).
- [ ] **Step 5:** Commit `feat(used): a bought part's cost stays on its job when it isn't charged`.

### Task 5: Prints

**Files:** Modify `apps/desktop/src/renderer/print/templates.ts` (the notes on rows), `print/sample.ts`, `lib/types.ts` (`DocLine`). Test `apps/desktop/test/templates.test.ts`.

- [ ] **Step 1: Failing tests:** estimate and job card show "Used part"; issued invoice shows "Used part, warranty until 3 Dec 2026", judged on its issue date; Arabic added only on `en_ar`; a credit note shows "Used part"; a new part shows none; the page has no PO number or seller.
- [ ] **Step 2:** `npx vitest run apps/desktop/test/templates.test.ts` — FAIL.
- [ ] **Step 3:** Add `usedPartText` to `notes`: `onDate` is the issue date in Dubai, or today on a draft.
- [ ] **Step 4:** Same command — PASS.
- [ ] **Step 5:** Commit `feat(used): used parts and their warranty on prints`.

### Task 6: Screens

**Files:** Create `BuyUsedPartDialog.tsx`, `UsedPartsToBuy.tsx`. Modify `components/document/LinesTable.tsx` (`PartControls`), `pages/DocumentPage.tsx`, `lib/documentDraft.ts` (`sentLines` sends `condition`), `lib/types.ts`, `pages/PurchaseOrdersPage.tsx`, `components/ReceiveDialog.tsx`, `components/RequestPartDialog.tsx`, `help/guides.ts`, `README.md`. Test `apps/desktop/test/documentDraft.test.ts`, `apps/desktop/test/used.spec.ts`, `playwright.used.config.ts` (copy `playwright.fields.config.ts`; `testMatch: "used.spec.ts"`), `package.json` script `e2e:used`.

**Interfaces:** Consumes the APIs of Tasks 2–4. `BuyUsedPartDialog({ request, onClose, onDone })`, `request` as in `RequestPartDialog`. Exact words:
- Tick: **Used**. Ticking clears the part, units and Fleet Fix, keeps the text; disabled once bought, and the line type too. With Used ticked, no parts search and no Request part.
- Button: **Buy used part** (only `purchases.manage`, open job card, not bought). Badge: **Warranty until 3 Dec 2026** / **Warranty ended 3 Dec 2026** / **No warranty**.
- List title: **Used parts to buy** with its count, on Purchase orders; a purchase order's tag: **Used part**.
- Removing a received line that isn't shelf stock: "This part was bought for this job. Its cost stays on the job."
- Card **Bought for this job, not charged**, button **Put back on the job** (adds a line with its `poLineId`, price 0).
- Converting with an unbought used part: "Alternator is marked used but its purchase isn't recorded. Convert anyway?"
- Issuing with an ended warranty: "Warranty on Alternator ended on 3 Dec 2026. The invoice will print no warranty remaining."
- VAT: "No TRN saved for this supplier" beside VAT at 0; amber "VAT claimed from a supplier with no TRN" when typed.

- [ ] **Step 1: Failing tests.** Unit: `sentLines` sends `condition` and never a `partId` with used. E2e `used.spec.ts`, as Owner unless said:
  1. Advisor: estimate with Alternator ticked Used → job card → it's in Used parts to buy; no Buy button, no costs.
  2. Owner buys it: new seller, 150, No VAT bill, date today, Save disabled until a warranty is chosen, 7 days → badge shows the end date, cost 150.
  3. Remove the line → confirm → the not-charged card; Put back → gone; price 300.
  4. Invoice, issue → the print holds "Used part, warranty until"; Parts list is still empty.
  5. A part bought 10 days ago with 3 days' warranty → issuing warns and prints "no warranty remaining".
  6. Receive delivery from a supplier without TRN starts at VAT 0 with the note.
- [ ] **Step 2:** `npx vitest run apps/desktop/test/documentDraft.test.ts && npm run e2e:used` — FAIL.
- [ ] **Step 3:** Implement. Help: a "Used parts" section in `purchases-stock`. README: the feature and the test command.
- [ ] **Step 4:** Same commands — PASS. Look at screenshots of the job card, dialog and list at 1024 and 1440 px.
- [ ] **Step 5:** Commit `feat(used): used parts on the job card, buying them, and what's not charged`.

### Task 7 (only if the user says yes): Paid cash or bank at once

**Files:** Modify `packages/server/src/payables/payments.ts` (split out `insertPayment(db, p, paidAt, reserved, userId, numbers): string`), `packages/server/src/used.ts`, `usedPurchaseSchema` (`paidFromAccountId: uuid | null`, null = pay later), `BuyUsedPartDialog.tsx`. Test `packages/server/test/used-parts.test.ts`, `used.spec.ts`.

- [ ] **Step 1: Failing tests:** paid from Cash → supplier owed 0, one payment of 15000 on the purchase date against that receipt; pay later → owed 15000; a bad account → 400 and **nothing** saved (no PO, no supplier); a locked purchase date → 400 and nothing saved; books: payables back to 0 and cash down 150.
- [ ] **Step 2:** `npx vitest run packages/server/test/used-parts.test.ts` — FAIL.
- [ ] **Step 3:** Implement: both numbers reserved first, purchase and payment in one `db.tx`. Dialog: **Paid by** Cash / Bank / Pay later, required. No money accounts yet → only Pay later.
- [ ] **Step 4:** Same command and `npm run e2e:used` — PASS.
- [ ] **Step 5:** Commit `feat(used): a used part paid in cash or by bank at once`.

### Task 8: Whole check

- [ ] **Step 1:** `npm run typecheck && npx vitest run` — all pass.
- [ ] **Step 2:** `npm run e2e && npm run e2e:used && npm run e2e:document && npm run e2e:payables && npm run e2e:books && npm run e2e:sync` — all pass.
- [ ] **Step 3:** `npm run build --workspaces --if-present && npm run e2e:electron` — pass (it doesn't rebuild by itself).
- [ ] **Step 4:** Open a copy of a version-27 database: existing job costs, invoices and prints unchanged, except jobs with a bought part that isn't charged.

Release (cloud first, then push, then the new installer) is separate and needs the user's word.
