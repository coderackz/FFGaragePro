# Proper form fields — design

**Date:** 2026-11-24 · **Status:** approved by the user 2026-11-24 · **Branch:** feature/form-fields (from feature/document-editor-refinements)

## Why

The user: "in the garage setup file and other places use proper form types, like address here is just a paragraph box, make actual address box and password unhide option to verify etc. I have seen these issues overall in the app." Staff should type each kind of information right first time, and be able to check a password before saving it.

## Today

About 55 screens have forms. Addresses are one paragraph box (setup, garage details, customer, supplier; plus Arabic copies). None of the 12 password/secret boxes can be shown; a new user's password is typed once. Phone, TRN and plate take any text; some email boxes are plain. Dates, money and most emails are already right.

## Goals

1. **Address:** Unit / shop no., Building, Street, Area, Emirate (list), PO Box — each stored separately, all optional; printed as tidy lines. Setup also asks for the Emirate, which is the garage's emirate for the VAT return (one value, not two). Suppliers also get Country. The Arabic address stays one box (it prints as a block).
2. **Passwords:** Show/Hide on all 12 boxes; "passwords match" on setup; a confirm box for new users and password resets. *(Resets: my call.)*
3. **Checked boxes** with their error beside the box: phone (country code + number), email, TRN (15 digits, counted), IBAN (check digits), VIN (17 characters), year, plate (emirate, code, number), odometer, Emirates ID. Notes, terms and messages stay paragraphs.
4. **Old records:** an existing address goes into Street with nothing lost. A value that was already there and wrong never blocks a save unless it's changed.

## Constraints

- **Migration 27**; deploy the cloud before the PCs. Migration 27 moves nothing that can't be put back: the single `address` column stays, and always holds the printed text made from the parts.
- **Older PCs** on the garage network keep reading and writing `address`. A save from one that changes `address` replaces the parts (it goes into Street); one that sends the same text leaves the parts alone. *(My call.)*
- Phone and plate keep their one text column: search, WhatsApp, messages and fitment use it. The boxes read it apart for editing and write it back. A phone or plate that doesn't fit the pattern is kept exactly as it was and shown in one plain box. *(My call.)*
- Plates from outside the UAE and older formats are allowed ("Other"). *(My call.)*
- Phone: UAE (+971) first, then GCC and common countries; landlines, mobiles and 800/600 numbers accepted. *(My call.)*
- Works offline, in the PC app and the browser app; 1024–1440 px. Current look kept; Show/Hide is text, not an icon.

## Approaches considered

- **A. Each address part in its own column, `address` kept as the printed text (chosen).** Exact, searchable, and older PCs keep working.
- **B. One text, taken apart each time it's edited.** No migration, but it guesses wrong.
- **C. Address search (Google).** Needs internet and payment: no good for offline garages.

## Non-goals

Required addresses; address look-up; changing how printouts look beyond the address lines; new fields on documents; phone or plate in separate columns; redesigning screens.

## Anti-goals

Losing or rewriting any existing address, phone or plate; a save blocked by an old value nobody touched; two emirates that can disagree.

## Left to the builder

Component names and files; exact error words; country list; where the address lines break in print; tests (unit for parse/format/validate and migration, server and sync for older saves, e2e for setup, customer, supplier, vehicle, users).

## Added 2026-11-24 (approved by the user): a vehicle without leaving the job card

**Why:** the user: "when I add a fresh jobcard I have an option to add new customer but a new customer comes with 0 vehicles so if I want to add a vehicle I have to abandon the jobcard and go to the vehicle side bar."

On estimates, job cards and draft invoices (one screen):
1. **New customer:** the vehicle form opens straight after saving; **Skip** for counter sales.
2. **Existing customer:** "+ New vehicle" in the Vehicle list at any time, including on a saved job card.
3. **After saving:** the vehicle is selected and its odometer filled in; the lines stay as they were.
4. **Fewer clicks:** a customer with one vehicle gets it selected; searching by plate picks that vehicle along with its customer.
5. **Plate already registered:** the message says whose it is.

No migration; advisors already may add vehicles. Ruled out: typing the vehicle straight into the job card (duplicates the form); customer and vehicle in one long form (slows counter sales).
