# Used parts bought for a job — design

**Date:** 2026-11-26 · **Status:** approved by the user 2026-11-26 · **Part 1 of 2** (part 2: purchase order to inventory, its own design)

## Why

The user: "Garages most often purchase used parts how this is handled?" Today it isn't: nothing marks a part as used, the warranty has nowhere to go, and VAT is added to purchases that had none.

## Decided by the user (2026-11-26)

- Used parts are bought for a particular job. They are never stocked.
- They come with 3–30 days' warranty, mostly without a VAT bill.
- The warranty starts from the purchase time.
- Service Advisors don't create parts.
- Approach A: extend "Request part / Already bought".

Everything marked *(my call)* is a proposal.

## Today (main 492af8b, tried on a throwaway database as Owner)

- A typed part line recorded as "Already bought" with VAT 0 gives the right job cost and profit, with no part in the Parts list.
- VAT left out becomes 5%, even when the supplier has no TRN; the Request part and Receive delivery screens fill in 5% too.
- The purchase date is the day of entry, in UTC, so before 4 am in Dubai it is the day before.
- A bought line can be removed from a job card with no warning. The job's cost drops to 0, while the purchase stays recorded against the job.

## Goals

### 1. "Used" on a part line
- Part lines on estimates, job cards and draft invoices get a **Used** tick. Advisors may use it.
- A used line is never linked to the Parts list, so it can't move stock: ticking Used unlinks a picked part and keeps its text. It can't also be "Supplied by Fleet Fix". The server enforces both.
- Used carries over from estimate to job card to invoice to credit note.
- Once the part is bought, Used can't be unticked on that line. *(My call.)*

### 2. Buying it
- Every used line on an open job card that isn't bought yet appears in **Used parts to buy**: a list on the Purchase orders page, with a count. The advisor only ticks Used and saves; no seller or draft order is needed first. *(My call: the advisor usually doesn't know the seller yet.)*
- Owner or Accountant presses **Buy used part** on the line or in that list. Advisors don't see prices paid.

```
Buy used part — JC-00012 · Alternator
Seller    [Al Sajaa Used Parts]   Phone [05x xxx xxxx]
Price     [150.00]   Qty [1]      Bought on [26 Nov 2026]
VAT bill? (•) No  ( ) Yes → TRN, invoice no., VAT
Warranty  [3] [7] [15] [30] days  [Other] [None] → until 3 Dec 2026
```

- **Seller:** pick a saved supplier, or type a name and phone to save a new one in the same step. A saved supplier with the same phone is offered first.
- **Bought on:** today in Dubai; may be earlier, not later than today.
- **Warranty:** must be chosen (a number of days, 1–365, or None); nothing is preselected. *(My call: so a wrong warranty isn't saved by accident.)*
- Saving makes a one-line purchase order, already received, as "Already bought" does now. The purchase orders list tags it **Used part**.
- A used line left unbought shows "cost pending", so the profit isn't overstated.

### 3. Warranty
- Ends on the purchase date plus the days: bought 26 Nov with 7 days is valid through 3 Dec.
- One date for the seller's and the customer's warranty.
- The job card line shows "Warranty until 3 Dec 2026", amber in the last 2 days, red when ended.
- Issuing an invoice with an ended warranty asks: "Warranty on Alternator ended on 3 Dec 2026. The invoice will print no warranty remaining." It can still be issued. *(My call.)*

### 4. Prints
- "Used part" always prints on estimates, job cards, invoices and credit notes; with Arabic on two-language documents (قطعة مستعملة).
- Invoices add one of: "warranty until 3 Dec 2026", "no warranty remaining" (ended before the issue date) or "no warranty". An issued invoice never changes afterwards.
- The seller, price paid and purchase order number never print for the customer.

### 5. VAT on purchases
- **No VAT bill:** VAT is 0. **VAT bill:** seller's TRN (15 digits), invoice number and VAT are required; the TRN is saved on the supplier if it had none.
- For every purchase (Request part, Receive delivery, and the server's default): a supplier with no TRN starts at VAT 0, with the note "No TRN saved for this supplier". Typing VAT is allowed, with a warning. Fleet Fix always starts at the garage's rate. *(My call.)*
- Purchases already recorded are not changed. Sales are not changed: 5% on the full selling price. The profit margin scheme is out.

### 6. A bought part's cost never disappears
- Removing a bought line that isn't shelf stock asks first: "This part was bought for this job. Its cost stays on the job." *(My call.)*
- The job's cost then shows it under **Bought for this job, not charged**, with **Put back on the job**. The same counts for a quantity charged that is lower than the quantity bought. Job cost then agrees with the books, which already keep the purchase on the job.
- Advisors see the item there without amounts.

### 7. Dates
- "Already bought" and Receive delivery use Dubai's date. "Already bought" gets a Bought on date.

## Constraints

- **Migration 28:** line condition on document lines and purchase order lines; warranty days on purchase order lines. The purchase date is the goods receipt's existing supplier invoice date; the warranty end is worked out, not stored. Existing lines become "new".
- The cloud is updated before the PCs; a PC that isn't updated stops syncing until it is, as today. All PCs on a garage's network run the main computer's server: an older screen that leaves out the new fields keeps what's stored.
- Works offline, in the PC app and the browser app, 1024–1440 px. Costs stay hidden from roles without `costs.view`, in the API and not only on screen.
- Money in fils; stock and existing invoices untouched.

## Approaches

- **A. Extend "Request part / Already bought" (picked by the user).** Job cost, supplier balance, books and sync already work through it. Each used part makes a small purchase order in the background.
- **B. A separate Used purchases section.** A clean list, but repeats the cost, VAT, books and sync work.
- **C. Labels only.** Quickest, but leaves the VAT, cost and removed-part problems.

## Non-goals

Used stock or used part numbers; a separate customer warranty; the profit margin scheme; new/used price choices on one estimate. **Planned next, not here:** warranty alerts on the dashboard; "Part failed" (exchange, refund, lost); paid cash or bank at once (until then a purchase shows as owed until a supplier payment is entered); receipt photo; fixing past purchase order lines; undo delivery.

## Anti-goals

A used part moving shelf stock; VAT claimed that wasn't on a bill; a cost that vanishes from a job; a warranty promised past the seller's; an issued invoice changing; advisors seeing costs.

## Left to the builder

Layout and exact wording; column names; tests: unit for warranty dates and VAT default; server for used lines, purchase, removal, permissions, older screens and conversion; sync with two computers; e2e from estimate (used) to job card, purchase, invoice and print.
