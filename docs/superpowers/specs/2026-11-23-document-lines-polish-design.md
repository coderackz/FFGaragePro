# Document editor refinements — design

**Date:** 2026-11-23 · **Size:** a project (one round) · **Screens:** the shared document editor (`apps/desktop/src/renderer/pages/DocumentPage.tsx`) for estimates, job cards, invoices and credit notes, and their printouts.

## Why

The user compared the current job card with a full redesign mockup and chose to **keep the current design** with targeted changes: things advisors need every day (line numbers, units, longer work descriptions, an overall discount with a control on big discounts) and things that get in the way (a Save button that loses work if forgotten, a language box that doesn't belong on the document, vehicle details that are hard to read, wrapping part details, misaligned figures).

**Success:** an advisor builds an estimate or job card without pressing Save and without losing work to a power cut; the printout carries numbered lines with units and full labour descriptions; a discount above the limit always has a named person and a reason behind it.

## Goals (what changes)

1. **SL No.** A `#` column (1, 2, 3…) at the start of every line on screen (printouts already number lines). Blank lines dropped at save don't count.
2. **Unit per line ("Qty type").** A small unit box beside Qty: suggestions Pc, Set, Pair, Box, Litre, Kg, Metre, Hr, Job, and the advisor can type their own (up to 12 characters). Defaults: labour **Hr**, other **Pc**, a linked part **the part's own unit** (a part stored as "each" shows as **Pc**). Printed beside the quantity ("2 Pc", "1.5 Hr").
3. **Description on labour and Other lines.** The line keeps its short title; an "Add description" link opens a box under it that grows as you type (up to 2,000 characters, line breaks kept). Printed under the title in smaller text. Part lines don't get one.
4. **Add buttons under the last line.** "+ Labour · + Part · + Other" move from the card header to just below the last line.
5. **Overall discount, just above the Total** (the user picked approach A below).
   - A "Discount" row in the summary, "+ Add discount" when there's none. The user enters a value and picks **%** or **AED**.
   - Anyone who can edit the document can give it (advisors included).
   - **Above the limit (25%, measured against the total after line discounts and before VAT):** a confirmation appears — a tick box ("I confirm this 30% discount is approved") **and a remark** (required, the reason). Without both, the discount can't be saved. The remark, the person and the time are stored with the document, shown under the Discount row ("Approved by Rashid Khan, 23 Nov: Fleet customer, agreed with owner") and written to the activity log. Changing the discount again above the limit asks again.
   - The limit is a garage setting (Settings → Pricing), starting at 25%. *(My call.)*
   - A document has **either a promo code or a manual discount, not both**. *(My call — avoids stacking.)*
   - VAT is worked out after the discount. Printouts show "Discount 10% −AED 53.50" (or "Discount −AED 50.00") above VAT.
   - It carries over estimate → job card → invoice with its confirmation, and a credit note returns each line with its share.
   - Per-line Disc % stays as it is.
   - Credit notes take the invoice's discount shares; no discount is entered on a credit note itself. *(My call.)*
6. **Progress card on the right.** Steps follow the real statuses: estimate Draft → Sent → Approved → Converted; job card Open → In progress → Completed → Invoiced; invoice Draft → Issued → Paid (Part paid shown on the Paid step). Done steps filled, the current one marked. No credit-note card. Changing status stays where it is today. *(The card is read-only — my call.)*
7. **Auto-save, no Save button.**
   - An existing document saves itself about a second after the last change and when leaving the screen; the header shows "Saving…" / "Saved" / "Not saved — retrying".
   - A **new** document is kept only on that PC (no number) until it has a customer and at least one line with a title; then it is created automatically — estimates and invoices as Draft, job cards as Open — and gets its number.
   - Every change is also kept on the PC as it's typed (per document; new documents per type). If the app closes, the power goes or the network drops, reopening the document (or starting a new one of that type) restores the unsaved changes with a notice "Unsaved changes restored" and a way to discard them.
   - **If another PC changed the document meanwhile, nothing is overwritten:** the save is refused, the user is told to reload, and their changes stay kept on the PC.
   - Only documents that can still be edited auto-save (issued invoices and converted documents are read-only as today).
8. **No "Document language" on the document screen.** A document uses its customer's language setting (still on the customer form), as today when it is made.
9. **Vehicle card on the right stays, with clear details:** **Plate No** (large), make, model and year, **VIN No** ("Not recorded" when missing), and **Odometer** — this visit's reading as entered on the document, with the last recorded reading beside it ("84,250 km · last 84,250"). Labels are written out (Plate No, VIN No, Odometer) instead of the current single grey line.
10. **Part details stay on one tidy line.** Under a linked part, "OF-1001 · 9 on shelf · unlink · Fits this vehicle" never splits inside a piece; a whole piece wraps if the column is narrow.
11. **VAT, Total and the delete button line up** with the middle of the input boxes on the same line.

## Non-goals

- The new-look mockup (icons on lines, strip layout, tabs) is **not** being built; the current design stays.
- Descriptions on part lines; units on purchase orders (they already have packs).
- Sending line descriptions or units to Zoho Books / QuickBooks or into message text (the attached PDF carries them). *(My call.)*
- Owner approval workflows for discounts (the user asked for the advisor's own confirmation with a remark).
- Changing how status is changed.

## Anti-goals

- Auto-save that uses up document numbers for abandoned starts, or fills the lists with empty drafts.
- Auto-save that silently overwrites another PC's or the cloud's changes.
- Any change in totals, VAT or the books for documents without the new discount.

## Approaches considered

**Overall discount**
- **A. Spread across the lines (chosen).** The discount is shared over the lines by value, like promo codes today (`promoShares` in `packages/shared/src/promo.ts`, the line's `promo_fils`); each line's VAT is on its discounted value, so VAT is exact to the fil and the books, VAT return and credit notes work unchanged.
- **B. A negative "Discount" line.** Rejected: per-line VAT can be off by a fil, the books would carry negative revenue, a partial credit note can't tell which part to return, and it would take an SL number.

**Line descriptions**
- **A. A separate field per line (chosen).** Titles stay short wherever they're used.
- **B. Multi-line title.** Rejected: purchase orders, part requests, integrations, reports and messages would all carry the paragraph, capped at 500 characters.

**Auto-save** — one sensible way: save to the garage server after a pause, with a copy kept on the PC until the save succeeds. Saving only on the PC (and syncing later) would hide work from other PCs on the garage network; saving only to the server loses work in a power cut.

## Constraints

- **One migration (25):** line `details` and `unit`; the document's manual discount (kind, value) and its confirmation (who, when, remark); the discount limit setting. **Deploy the cloud before the garage PCs**, as for every migration.
- **Older PCs** that save without the new fields must not wipe them (fields not sent are kept), and must not drop or change a manual discount made on an updated PC.
- Sync: the new columns travel with the existing document and line sync; a manual discount and a promo can't end up together after a merge (if both arrive, the earlier one wins and the other is dropped with a sync issue). *(My call.)*
- Money stays in integer fils; VAT rounding as today.
- Works in the Electron app and the browser (cloud) app, at the widths in the e2e checks (1024–1440 px; the summary sits beside the lines only at 1440 px and up, as today).
- No icons added (the user doesn't want icons on this screen).

## Left to the builder

- Storing the manual discount alongside the promo fields (the per-line share column can serve both, since a document has only one of them).
- How the refusal for "changed on another PC" is detected (documents have no version column today — add one, or compare `updated_at`).
- Where the PC-side copy of unsaved changes is kept (browser storage per garage and document), and when it is cleared.
- Exact styling, kept in the current look; screenshots at 1440 and 1280 px.
- Tests: unit tests for the discount (spread, VAT, limit and remark, carry-over, credit note, not with a promo), units and descriptions (save, conversion, credit, sync, older-PC saves), and the refusal on a stale save; e2e: build a job card without pressing Save, add a labour description and unit, give a 30% discount with a remark, check the printout; an auto-save restore after a reload.
