# Estimates from job cards, approval, and the workshop steps — design

**Date:** 2026-11-27 · **Status:** agreed with the user ("Yup it looks fine … make it 2 way"; "No new estimate we can add re estimate with a hypen numeber") — building Stage 1. *(my call)* marks builder decisions.

## How the user's garages work
1. The advisor inspects the vehicle and makes a **job card**.
2. The accountant makes the **estimate (quotation)** from it and sends it to the client.
3. The client **approves** — by signing a link, or over a phone call.
4. The accountant raises the **PO** for the parts.
5. Parts are delivered.
6. The job is done, **QC**.
7. The **invoice** is made.

Rarely, an estimate comes first and becomes a job card — that stays (**both ways**).

## Today (main cf9c510)
- Documents go one way only: estimate → job card → invoice; each converts once (`documents.source_id`, unique).
- Estimate approval is a status set by hand; nothing records how, who or when. No signing link.
- Parts requests ask vendors and order; nothing stops ordering before the client approves.
- Shelf parts leave stock as soon as they're on a job card.
- Job card: Open → In progress → Completed; no QC.

## Stages
**Stage 1 (this design, built first):** estimate from a job card; recording approval; approved lines back on the job card; vendor prices on the estimate; a warning before ordering unapproved work.
**Stage 2 (own design later):** job card steps Open → Approved → In progress → QC → Completed; QC by whom and when; shelf parts leave stock from Approved on.
**Stage 3 (own design later):** the client signs a link from the cloud (a public page; expiry and checks to design).

## Stage 1 goals

### 1. One estimate per job card, re-estimated with a hyphen (job card → estimate)
- On an open job card with no estimate: **Create estimate**. It makes an estimate for the same customer and vehicle with the job card's lines. The estimate says "For JC-00031"; the job card shows its estimate and where it stands.
- **No second estimate** (the user): a change after it was approved, or extra work found later, is a **Re-estimate** — the same estimate, numbered **EST-00012-1**, then **-2**. On the job card, "Re-estimate" brings in the job card's lines not on the estimate yet.
- The version before is kept with its lines, totals and approval, and can be viewed and printed ("Versions: EST-00012 · approved by phone 27 Nov · PDF").
- A draft or sent estimate is edited as it is; an approved one only through Re-estimate *(my call)*.
- Anyone who edits documents may create or re-estimate *(my call: the advisor may need to when the accountant is away)*.
- The old way stays: **Convert to job card** on an estimate made first. An estimate made from a job card doesn't convert to another one. Extra work on a job card that came from an estimate re-estimates that same estimate *(my call)*.
- The job card's and the estimate's lines are matched by their kind and text (in order, for repeats) — the way the app already keeps a line's details and order links across saves *(my call: line ids change on every save)*.

### 2. Vendor prices on the estimate
- A part line that is on a parts request with vendors' prices shows them under the line to those who see costs: "Gulf Parts 180.00 · Sajaa 165.00 — suggested 198.00 (markup 20%) · Use". The markup is Settings → Pricing's parts markup. Advisors see nothing of it.

### 3. Sending
- As today ("Estimate ready", with the PDF). A re-estimate that was sent before goes as **"Extra work needs approval"** *(existing message)*.

### 4. Recording approval
- **Record approval** on a sent or draft estimate:
  ```
  Approved by  [Ahmed (customer) ▾]  ← the customer, a contact, or typed
  How          (•) Phone call  ( ) In person  ( ) Signed copy  ( ) WhatsApp / email reply
  When         [27 Nov 2026 10:42]
  Lines        [✓] Front brake pads      [✓] Brake fluid      [ ] AC re-gas (declined)
  Note         [...]
  ```
- Saved with who recorded it (the signed-in user). The estimate shows "Approved by phone · Ahmed · 27 Nov 10:42 · recorded by Sara"; declined lines show as declined on screen and print.
- Anyone who edits documents may record it *(my call: whoever took the call)*.
- Once approved, the estimate can't be edited; a change is a Re-estimate (the user). Declined lines don't count in its total. Undoing an approval is out of Stage 1.
- Setting the status to Approved the old way (an older screen) still works and records "status set by hand" with who did it *(my call)*.

### 5. Approval goes back to the job card
- When an estimate **for a job card** is approved (made from it, or re-estimated for it):
  - its approved lines update their job card lines (description, quantity, price, discount);
  - approved new lines are added to the job card;
  - declined lines that came from the job card are **taken off** it (the work isn't done) *(my call)*; a part already bought follows today's rules (its cost stays on the job, "Bought for this job, not charged").
- Job card lines not on the estimate (added after it) are left as they are.
- The job card shows its estimate: "EST-00012-1 · approved by phone · 27 Nov".
- An estimate made first and converted (the rare way) works as today.

### 6. Ordering unapproved work
- **Order** on a parts request whose job card has an estimate not yet approved asks: "EST-00012 isn't approved yet. Order anyway?" A job card with no estimate (walk-in) doesn't ask *(my call)*.

## Constraints
- Migration 31: `documents.for_job_id` (an estimate's job card), `documents.revision`, approval fields (`approved_at`, `approved_via`, `approved_by_name`, `approval_note`, `approval_recorded_by`), `document_lines.declined`, and `document_versions` (an estimate's earlier versions as they were, insert-only). The number becomes EST-00012-1 in place (numbers stay unique by series and sequence). Synced; the cloud is updated before PCs.
- Advisors never see vendors or costs (vendor prices show only to `costs.view`).
- Offline on a PC; issued invoices never change; stock rules unchanged in Stage 1.

## Approaches
- **A. Link the estimate to its job card, revised in place (picked):** `for_job_id`, one estimate per job card, Re-estimate keeps the earlier version and adds a hyphen number; approval writes back. Keeps the one-conversion rule for estimate → job card → invoice.
- **B. Reuse `source_id`:** impossible — a job card's invoice already uses it, and it allows one.
- **C. Estimates as a tab inside the job card (no separate document):** loses the estimate number, PDF and the existing sending.

## Non-goals (Stage 1)
Several separate estimates per job card (the user: re-estimate instead); undoing an approval; signing links (Stage 3); job card steps, QC and stock timing (Stage 2); insurance claims.

## Anti-goals
A declined line invoiced; an approval with no record of how and who; advisors seeing vendor prices; a job card getting a second job card from its own estimate.

## Left to the builder
Layout and wording; tests: server (create from job card, several estimates, approval write-back incl. declined and bought parts, converted-first path unchanged, order warning, permissions, sync), e2e (advisor job card → accountant estimate with vendor price → phone approval → job card updated → order → invoice).
