# Document Editor Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current document editor and add SL No, a unit per line, descriptions on labour/other lines, add buttons under the last line, an overall discount with a confirmation above a limit, a Progress card, a clearer Vehicle card and auto-save; remove the language box; fix part details wrapping and VAT/Total alignment.

**Architecture:** One migration (25) adds line `details`/`unit` and the document's manual discount. The manual discount reuses the promo machinery: `promoShares` spreads it over the lines into the existing `promo_fils` column, so totals, books, VAT return, sync recompute and credit notes work unchanged; a document has a promo **or** a manual discount. The editor's line table moves to its own file; auto-save is a hook that keeps a local copy and saves to the server with a stale-write check.

**Tech Stack:** TypeScript, Fastify + `node:sqlite` (packages/server), zod schemas (packages/shared), React + Tailwind (apps/desktop renderer), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-document-lines-polish-design.md`

## Global Constraints

- Migration **25**; deploy the cloud before the garage PCs (note it in the README's migrations list).
- Money in integer fils; VAT rounding through `lineTotals` as today.
- Line `details`: labour and other lines only, up to **2,000** characters, line breaks kept; `null` when empty.
- Line `unit`: up to **12** characters; suggestions **Pc, Set, Pair, Box, Litre, Kg, Metre, Hr, Job**; defaults labour **Hr**, other **Pc**, linked part = the part's unit with `each` shown/stored as **Pc**.
- A field a client doesn't send is kept (older screens on the garage network).
- Discount limit: `settings.pricing.discountConfirmAbovePct`, default **25**, measured as discount ÷ (bill after line discounts, before VAT) — confirmation needed when **strictly above** it. Remark **3–300** characters.
- A document has either a promo code or a manual discount, never both; credit notes take no manual discount of their own.
- No icons added on the document screen (the user doesn't want icons there); keep the current look.
- Widths: works at 1024–1440 px; summary beside the lines only at 1440 px and up (as today).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An amount discount that grows past the limit when lines are removed** (AED 100 off a 500 bill is 20%; delete a line and it's 40%) — the document must show the confirmation again and an invoice must refuse to issue until it's confirmed. Test in Task 2.
2. **Auto-save racing a new document's creation** — typing continues while the first create is in flight; the second change must PATCH the created document, never create a second one, and nothing typed is lost. Test in Task 6.
3. **Auto-save hitting an approval (line discount over the role's limit, credit limit on a new job card)** — it must stop and show "Needs the owner's approval" with an "Approve and save" button, not pop a dialog mid-typing or loop. Test in Task 6.
4. **A save from a screen opened before another PC's change** — refused with "changed on another computer — reload", local copy kept; a client that sends no `baseUpdatedAt` (older screen) still saves. Test in Task 6.
5. **Converting and crediting with a manual discount and descriptions** — the job card/invoice keep the discount, its confirmation, descriptions and units; a part credit returns that line's share exactly. Tests in Tasks 1–2.

---

### Task 1: Line descriptions and units (migration 25, schemas, server)

**Files:**
- Modify: `packages/server/src/migrations.ts` (append migration 25)
- Modify: `packages/shared/src/schemas.ts` (`lineSchema`), `packages/shared/src/settings.ts` (`pricing`)
- Create: `packages/shared/src/units.ts` (export from `packages/shared/src/index.ts`)
- Modify: `packages/server/src/routes/documents.ts` (`writeLines`, `full`, convert, credit notes)
- Test: `packages/server/test/document-details.test.ts`, `packages/sync/test/document-details.test.ts`, `packages/shared/test/units.test.ts`

**Interfaces:**
- Produces: `lineSchema` gains `details?: string | null` and `unit?: string | null` (both optional: absent = keep). Document output lines gain `details: string | null`, `unit: string | null`.
- Produces: `UNIT_SUGGESTIONS: readonly string[]` and `defaultUnit(kind: LineKind, partUnit?: string | null): string` in `packages/shared/src/units.ts`.
- Produces: `settings.pricing.discountConfirmAbovePct: number` (0–100, default 25) — used by Task 2.
- Migration 25 SQL (Task 2 relies on these columns):
  ```sql
  ALTER TABLE document_lines ADD COLUMN details TEXT;
  ALTER TABLE document_lines ADD COLUMN unit TEXT;
  ALTER TABLE documents ADD COLUMN discount_kind TEXT CHECK (discount_kind IN ('percent','amount'));
  ALTER TABLE documents ADD COLUMN discount_value REAL;
  ALTER TABLE documents ADD COLUMN discount_confirmed_by TEXT REFERENCES users(id);
  ALTER TABLE documents ADD COLUMN discount_confirmed_at TEXT;
  ALTER TABLE documents ADD COLUMN discount_remark TEXT;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/units.test.ts`:
```ts
it("defaults: labour Hr, other Pc, a part its own unit with each as Pc", () => {
  expect(defaultUnit("labour")).toBe("Hr");
  expect(defaultUnit("other")).toBe("Pc");
  expect(defaultUnit("part", "litre")).toBe("litre");
  expect(defaultUnit("part", "each")).toBe("Pc");
  expect(defaultUnit("part", null)).toBe("Pc");
  expect(UNIT_SUGGESTIONS).toEqual(["Pc", "Set", "Pair", "Box", "Litre", "Kg", "Metre", "Hr", "Job"]);
});
```
`packages/server/test/document-details.test.ts` (use `makeApp`, `setUp`, `call` from `./helpers`):
- `"labour and other lines keep a description and a unit; part lines take no description"` — create an estimate with lines `{kind:"labour", description:"Front brakes", details:"Pads and discs\nBleed brakes", unit:"Hr", qty:1.5, …}`, `{kind:"other", description:"Disposal", unit:"Job", …}`, `{kind:"part", description:"Filter", details:"x", unit:"Pc", …}`; expect lines[0] `{ details: "Pads and discs\nBleed brakes", unit: "Hr" }`, lines[1].details `null`, lines[2] `{ details: null, unit: "Pc" }`.
- `"a save that doesn't send details or unit keeps them"` — PATCH the same lines without `details`/`unit` keys; expect both kept on the matching lines (same position, kind and title).
- `"rejects a description over 2,000 characters and a unit over 12"` — 400.
- `"descriptions and units go with the work: estimate → job card → invoice → credit note"` — convert twice, issue, credit everything; each document's lines carry `details`/`unit`.

`packages/sync/test/document-details.test.ts` (pattern of `packages/sync/test/tracked.test.ts`): `"a line's description and unit reach the cloud"` — `applyAtCloud(C.db, "P1", localChanges(A.db, 0))` then the cloud's line has the same `details` and `unit`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/shared/test/units.test.ts packages/server/test/document-details.test.ts packages/sync/test/document-details.test.ts`
Expected: FAIL (`defaultUnit` not exported; `details` undefined in output).

- [ ] **Step 3: Implement**
- `units.ts`: the two exports above.
- `lineSchema`: `details: z.string().max(2000).nullable().optional().transform(v => v === undefined ? undefined : (v?.trim() ? v.replace(/\s+$/, "") : null))`, `unit: z.string().trim().max(12).nullable().optional().transform(v => v === undefined ? undefined : v || null)`.
- `settings.pricing`: `discountConfirmAbovePct: z.number().min(0).max(100).default(25)`.
- Migration 25 as above, with a one-line comment.
- `writeLines`: before the DELETE, read the old lines (`position, kind, description, details, unit`); for each input line with `details === undefined` / `unit === undefined`, take the old line's value at the same position when its kind and trimmed description match, else `null`. Part lines always store `details = null`. INSERT gains `details, unit`.
- `full()`: lines gain `details: l.details ?? null, unit: l.unit ?? null`.
- Convert: the mapped `lines` carry `details` and `unit`. Credit notes: the INSERT copies `line.details` and `line.unit` (add both to `SourceLine`).

- [ ] **Step 4: Run them to see them pass, then the whole server and sync suites**

Run: `npx vitest run packages/shared packages/server packages/sync`
Expected: all PASS.

- [ ] **Step 5: Commit** — `feat(documents): descriptions on labour and other lines, a unit on every line (migration 25)`

---

### Task 2: Overall discount (server and shared)

**Files:**
- Modify: `packages/shared/src/promo.ts` (or new `packages/shared/src/discount.ts`, exported from index), `packages/shared/src/schemas.ts`
- Modify: `packages/server/src/routes/documents.ts`
- Test: `packages/server/test/document-discount.test.ts`, `packages/shared/test/discount.test.ts`

**Interfaces:**
- Consumes: migration 25 columns; `settings.pricing.discountConfirmAbovePct`.
- Produces: `discountSchema = z.object({ kind: z.enum(["percent","amount"]), value: z.number().positive(), confirmed: z.boolean().optional(), remark: z.string().trim().min(3).max(300).optional() })` (percent ≤ 100; amount integer fils).
- Produces: `discountPct(discountFils: number, baseNetFils: number): number` (0 when base is 0; two decimals) and `needsConfirmation(pct: number, limitPct: number): boolean` (`pct > limitPct`).
- Produces routes: `PUT /api/documents/:id/discount` (body `discountSchema`, `documents.edit`) and `DELETE /api/documents/:id/discount`; both return `{ document }`.
- Produces in `full()`: `discount: null | { kind, value, discountFils, pct, applied: boolean, confirmedBy: string | null, confirmedAt: string | null, remark: string | null, needsConfirmation: boolean }` (`applied` false while a promo code is on the document).

- [ ] **Step 1: Write the failing tests** (`document-discount.test.ts`; bill = one labour line 1 × AED 500.00 unless stated)
- `"10% off: spread over the lines, VAT after the discount"` — PUT `{kind:"percent", value:10}` → totals `{ netFils: 45000, vatFils: 2250, grossFils: 47250 }`, `discount.discountFils` 5000, lines' `promoFils` sum 5000.
- `"AED 50 off the whole bill across two lines"` — lines 300 + 200, `{kind:"amount", value:5000}` → shares 3000/2000, net 45000.
- `"an advisor can give it; above 25% it needs the tick and a remark"` — as advisor: `{percent, 30}` → 400 mentioning "remark"; `{percent, 30, confirmed:true, remark:"ok"}` → 400 (remark too short); `{percent, 30, confirmed:true, remark:"Fleet customer, agreed"}` → 200 with `confirmedBy` = advisor's name, `remark` kept, `needsConfirmation:false`; audit_log has action `discount.confirm`. Exactly 25% needs nothing.
- `"the limit follows Settings → Pricing"` — set `discountConfirmAbovePct: 10`; 15% now needs confirmation.
- `"an amount discount that grows past the limit asks again; an invoice won't issue until confirmed"` — invoice with lines 300 + 200, AED 100 off (20%); PATCH lines to only the 200 line → `discount.needsConfirmation` true (50%); `POST /issue` → 409 mentioning "discount"; PUT again with confirmation → issue succeeds.
- `"promo or discount, not both"` — with a promo applied, PUT discount → 409 "Remove the promo code first"; with a discount, POST promo → 409 "Remove the discount first".
- `"the discount and its confirmation go with the work"` — 30% confirmed on an estimate; convert to job card → invoice; each has the same `discount` (kind, value, confirmedBy, remark) and the same totals.
- `"a credit note returns each line's share"` — issue an invoice with 10% off two lines; credit the first line in full → credit note net equals that line's discounted net exactly.
- `"DELETE removes it and the totals go back"`.
- `"a promo and a discount that both arrive (sync) — the promo applies, the discount waits"` — set `promo_*` and `discount_*` directly in the db, re-save the lines; totals follow the promo and `discount` is returned with `discountFils: 0` and `applied: false`.

- [ ] **Step 2: Run to see them fail** — `npx vitest run packages/server/test/document-discount.test.ts packages/shared/test/discount.test.ts` → FAIL (404 on the route).

- [ ] **Step 3: Implement**
- `writeLines`: `const terms = promo terms ?? (doc.discount_kind ? { kind: doc.discount_kind, value: doc.discount_value, appliesTo: "all" } : null)`; spread with `promoShares` as today; `promo_discount_fils` stores whichever applied.
- PUT: refuse when `promo_code` is set or the document isn't editable; compute shares on current lines; `pct = discountPct(discountFils, baseNetFils)`; above the limit require `confirmed === true` and `remark`; store kind/value and, when confirmed, `discount_confirmed_by/at/remark` (cleared when not above the limit); `writeLines` with the current lines; `audit(db, { action: "discount.confirm", entity: "document", entityId, after: { document, pct, remark }, userId })` when confirmed.
- `full()`: `discount` as in Interfaces; `needsConfirmation = needsConfirmation(pct, limit) && !(discount_confirmed_at)`; a confirmation counts only for the stored kind/value (PUT with a new kind/value clears it before checking).
- PATCH with lines: after `writeLines`, if the discount is now above the limit and its confirmation was given at or below the limit, clear the confirmation (so `needsConfirmation` shows).
- Issue: refuse with 409 `"The discount is above the limit: confirm it with a remark first"` when `needsConfirmation`.
- Promo POST: 409 `"Remove the discount first"` when `discount_kind` is set.
- Convert: copy `discount_*` to the new document before its `writeLines` (as the promo block does).

- [ ] **Step 4: Run to pass, then `npx vitest run packages`** → all PASS.

- [ ] **Step 5: Commit** — `feat(documents): overall discount — % or AED, spread over the lines, confirmation with a remark above the limit`

---

### Task 3: Printouts

**Files:**
- Modify: `apps/desktop/src/renderer/print/templates.ts`, `apps/desktop/src/renderer/lib/types.ts` (`DocLine.details`, `DocLine.unit`, `DocumentFull.discount`)
- Test: `apps/desktop/test/templates.test.ts`

**Interfaces:** Consumes the output fields of Tasks 1–2.

- [ ] **Step 1: Failing tests** in `templates.test.ts`:
- `"a line's unit prints beside its quantity and its description under its title"` — HTML contains `1.5 Hr` and `Pads and discs<br>Bleed brakes` (escaped, line breaks as `<br>`), on the invoice and the job card.
- `"a manual discount prints above VAT"` — `doc.discount = { kind: "percent", value: 10, discountFils: 5000, … }` → `Discount 10%` and `−AED 50.00`/`−50.00` in the totals; per-line note says `Discount −` not `Promo −`. Amount kind prints `Discount`.
- `"no unit: as before"` — labour without unit still prints `1 h` when `showLabourHours`.

- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/templates.test.ts` → FAIL.
- [ ] **Step 3: Implement** — `qty(l)` → `${l.qty} ${l.unit}` when a unit is set, else today's rule; description cell appends `<div class="d">${esc(details).replace(/\n/g, "<br>")}</div>` (smaller, `white-space: normal`); per-line share label `doc.discount ? "Discount" : "Promo"`; totals row for `doc.discount` (label `Discount ${value}%` or `Discount`) in place of the promo row. Arabic layouts use the same cells.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(print): units, line descriptions and the overall discount on printouts`

---

### Task 4: Lines table (SL No, unit, description, add buttons, part details, alignment)

**Files:**
- Create: `apps/desktop/src/renderer/components/document/LinesTable.tsx` (move `LinesTable` and `PartControls` out of `DocumentPage.tsx`)
- Modify: `apps/desktop/src/renderer/pages/DocumentPage.tsx`, `apps/desktop/src/renderer/components/PartPicker.tsx` (`PartLink`)

**Interfaces:**
- Produces: `LinesTable` props as today plus `onAdd: (kind: LineKind) => void` (renders the add buttons under the last line when `editable`).
- Consumes: `UNIT_SUGGESTIONS`, `defaultUnit` (Task 1).

- [ ] **Step 1: Move the two components unchanged; run `npm run typecheck` and `npm run e2e` → PASS (pure move).**
- [ ] **Step 2: Implement the changes**
- First column `#` (`w-10`, 1-based, numbers only the lines that will be saved — skip blank lines like `cleanLines`).
- Unit: an `Input` (`w-[64px]`, `list="unit-suggestions"`, `aria-label="Unit"`, maxLength 12) after Qty; one `<datalist id="unit-suggestions">`. New lines get `unit: defaultUnit(kind)`; picking a part sets `unit: defaultUnit("part", p.unit)`; changing kind resets an untouched default unit.
- Description: under the title for labour/other — a text link "Add description" that reveals an auto-growing `Textarea` (`aria-label="Line description"`, maxLength 2000); shown directly when the line has text; read-only shows the text with line breaks.
- Add buttons: "+ Labour · + Part · + Other" as text buttons in a row under the last line (remove them from the Card `actions`); the new line copies the customer's discount % as today.
- `PartLink`: each piece in its own `whitespace-nowrap` span inside a `flex flex-wrap gap-x-1.5` container (part no, shelf text, unlink, "Fits this vehicle").
- Alignment: VAT, Total and delete cells use `leading-8` (the 32 px input height) so their text sits level with the inputs' middle.
- `save()` body sends `details` (labour/other only) and `unit`.
- [ ] **Step 3: Check by eye** — `npm run e2e` (screens in `test-results/screens/`) and look at `05-jobcard.png`, `10-jobcard-parts.png` at 1440; resize check at 1280 via the workflow's small-screen shot.
- [ ] **Step 4: `npm run typecheck && npm run e2e && npm run e2e:catalogue && npm run e2e:tracked`** → PASS.
- [ ] **Step 5: Commit** — `feat(documents): SL no, unit and description on lines, add buttons under the last line, tidy part details`

---

### Task 5: Right column — Discount row, Progress, Vehicle; no language box; Settings

**Files:**
- Create: `apps/desktop/src/renderer/components/document/DiscountRow.tsx`, `ProgressCard.tsx`, `VehicleCard.tsx`
- Modify: `apps/desktop/src/renderer/pages/DocumentPage.tsx`, `apps/desktop/src/renderer/pages/settings/sections/PricingSection.tsx` (+ `settings/describe.ts` if it lists fields)

**Interfaces:**
- `DiscountRow({ doc, editable, onChanged }: { doc: DocumentFull; editable: boolean; onChanged: (d: DocumentFull) => void })` — calls Task 2's PUT/DELETE.
- `ProgressCard({ type, status }: { type: DocType; status: string })`; steps: estimate Draft/Sent/Approved/Converted; job card Open/In progress/Completed/Invoiced (`converted` = Invoiced); invoice Draft/Issued/Paid (`part_paid` marks Paid as current, labelled "Part paid"); nothing for credit notes.
- `VehicleCard({ vehicle, odometer }: { vehicle: DocumentFull["vehicle"]; odometer: number | null })` — rows: Plate No (large, mono), make model year, `VIN No` (`Not recorded` when empty), `Odometer` (`84,250 km · last 84,250`).

- [ ] **Step 1: Implement**
- Summary: Discount row just above Total — "+ Add discount" (hidden when a promo is applied, and the promo box hidden when a discount is set); editing shows value input + `%`/`AED` select; when `pct > limit` (computed live with Task 2's helpers and `settings.pricing.discountConfirmAbovePct`) show the tick box "I confirm this {pct}% discount is approved" and a remark input (required); applied shows `Discount 10% −AED 53.50` with "Change"/"Remove", and under it "Approved by {name}, {date}: {remark}" when confirmed; `needsConfirmation` shows the confirmation again in amber; `applied: false` shows "Not applied: this document has a promo code".
- Progress and Vehicle cards in the right column (Vehicle card keeps using the draft's odometer while editing).
- Remove the "Document language" select (and the read-only badge) from the screen.
- Settings → Pricing: number field "Confirm discounts above (%)" bound to `discountConfirmAbovePct`.
- [ ] **Step 2: `npm run typecheck && npm run e2e && npm run e2e:promo && npm run e2e:settings`** → PASS (update any spec that relied on the language select or the old vehicle card text).
- [ ] **Step 3: Commit** — `feat(documents): overall discount row, progress card, vehicle card with plate, VIN and odometer; no language box`

---

### Task 6: Auto-save

**Files:**
- Create: `apps/desktop/src/renderer/lib/autosave.ts`
- Modify: `apps/desktop/src/renderer/pages/DocumentPage.tsx`, `packages/shared/src/schemas.ts` (`documentUpdateSchema.baseUpdatedAt`), `packages/server/src/routes/documents.ts` (PATCH)
- Test: `packages/server/test/document-autosave.test.ts`, `apps/desktop/test/autosave.test.ts`

**Interfaces:**
- Server: `documentUpdateSchema` gains `baseUpdatedAt: z.string().optional()`; PATCH refuses with 409 `"This document was changed on another computer. Reload it to see the changes."` when given and ≠ the stored `updated_at`; absent = no check.
- `autosave.ts` exports:
  - `draftKey(garageId: string, docId: string | null, type: DocType): string` → `ffgp.docdraft.${garageId}.${docId ?? `new-${type}`}`
  - `readLocalDraft<T>(key: string): { draft: T; savedAt: string } | null`, `writeLocalDraft<T>(key: string, draft: T): void`, `clearLocalDraft(key: string): void` (all try/catch around `localStorage`)
  - `readyToCreate(d: { customer: unknown; lines: { description: string }[] }): boolean` (customer set and a line with a non-blank title)
  - `useAutosave(opts: { key: string; dirty: boolean; canSave: boolean; save: () => Promise<void>; delayMs?: number }): { state: "idle" | "saving" | "saved" | "error" | "approval" | "conflict"; message: string | null; saveNow: () => Promise<void> }` — debounce 1000 ms; one save in flight at a time (a change during a save schedules one more); saves on unmount and `beforeunload`.

- [ ] **Step 1: Failing tests**
- Server: `"a save based on an old version is refused; no base means no check"` — PATCH with the doc's `updatedAt` → 200; PATCH again with the old `updatedAt` → 409 with the message above; PATCH without `baseUpdatedAt` → 200.
- `apps/desktop/test/autosave.test.ts`: `draftKey` values for a saved and a new document; `readyToCreate` false without a customer, false with only blank lines, true with a customer and a titled line; `writeLocalDraft`/`readLocalDraft` round-trip with a stubbed `localStorage`, and `readLocalDraft` returns null when `localStorage` throws.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/document-autosave.test.ts apps/desktop/test/autosave.test.ts` → FAIL.
- [ ] **Step 3: Implement**
- Server check in PATCH (inside the transaction, before any write).
- `DocumentPage`: remove the Save button and "Unsaved changes"; header shows `data-testid="save-state"` text: "Saving…", "Saved", "Not saved — retrying" (retries every 5 s), "Needs the owner's approval" + button "Approve and save" (runs the save through `approval.withApproval`), or the conflict message + "Reload". Autosave's own saves never open the approval dialog; on an approval-required error it stops at state `approval`.
- New documents: `canSave = readyToCreate(draft)`; the first save POSTs, then `navigate(…, { replace: true })` **without** resetting the draft when changes were typed meanwhile (skip the doc→draft re-init while dirty); later saves PATCH with `baseUpdatedAt = doc.updatedAt`.
- Every `update()` writes the local copy; a successful save clears it. On opening a document (or a new one of that type) with a local copy newer than the document's `updatedAt`, load it, mark dirty and show a bar "Unsaved changes restored" with "Discard" (clears it and reloads).
- Actions that saved first (`onStatus`, `onConvert`, `onIssue`, promo, discount, request part, print, send) call `saveNow()` and stop if it didn't save.
- [ ] **Step 4: Update the e2e flows** — in `apps/desktop/test/flow.ts` add `export async function waitSaved(page: Page) { await expect(page.getByTestId("save-state")).toHaveText("Saved"); }` and replace every click on the document screen's "Save" (flow.ts, catalogue, credit, integrations, payroll, tracked, settings, messages specs — only those on a document page) with filling the fields and `waitSaved(page)`; "Job card saved"/"Estimate saved" toasts are gone.
- [ ] **Step 5: `npm run typecheck && npx vitest run && npm run e2e`, then every e2e suite** (`e2e:settings e2e:credit e2e:messages e2e:books e2e:payables e2e:cloud e2e:sync e2e:vat e2e:payroll e2e:assets e2e:promo e2e:integrations e2e:catalogue e2e:tracked e2e:planning e2e:returns e2e:minors`) → all PASS.
- [ ] **Step 6: Commit** — `feat(documents): auto-save — no Save button, local copy restored after a crash, nothing overwrites another computer's change`

---

### Task 7: End-to-end check, screenshots, README

**Files:**
- Create: `apps/desktop/test/document-editor.spec.ts`, `playwright.document.config.ts` (copy of `playwright.minors.config.ts` with its own data dir), `package.json` script `e2e:document`
- Modify: `README.md` (feature notes; migration 25 — cloud before PCs), help guide for documents if one describes Save (`apps/desktop/src/renderer/help/`)

- [ ] **Step 1: Write the spec** `"a job card without pressing Save: SL no, units, a labour description, a 30% discount with a remark, restored after a reload"`:
  - new job card for a customer with a vehicle; labour line "Front brakes" with description "Pads and discs\nBleed brakes", unit `Hr`, qty 1.5, price 180; `waitSaved`; the URL now has the document id and the number shows.
  - rows show `#` 1 and 2 after adding an Other line "Disposal" (unit `Job`).
  - Add discount 30% → the confirmation shows; without a remark the discount isn't applied; tick + remark "Fleet customer, agreed" → summary shows `Discount 30%` and "Approved by Rashid Khan".
  - type a change in the notes and reload before 1 s passes → "Unsaved changes restored" and the text is there; `waitSaved`.
  - Vehicle card shows `Plate No`, `VIN No`, `Odometer`; no "Document language" on the page.
  - Print preview HTML (via `printDocument` path the other specs use, or the API document rendered by the template) contains `1.5 Hr`, `Bleed brakes`, `Discount 30%`.
  - screenshots `document-1440.png` and, at 1280×800, `document-1280.png`; `pageerror` list empty.
- [ ] **Step 2: Run** `npm run e2e:document` → PASS; look at both screenshots and fix anything that wraps or overlaps.
- [ ] **Step 3: Full check** — `npm run typecheck && npx vitest run` and all e2e suites → PASS.
- [ ] **Step 4: Commit** — `test(e2e): document editor refinements (e2e:document); README and help`
