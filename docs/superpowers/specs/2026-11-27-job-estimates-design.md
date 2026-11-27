# Estimates from job cards, approval, and the workshop steps — design

**Date:** 2026-11-27 · **Status:** direction agreed with the user ("Yup it looks fine … make it 2 way"); this document awaits approval. *(my call)* marks builder decisions.

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

### 1. Create estimate (job card → estimate)
- On an open job card: **Create estimate**. It makes an estimate for the same customer and vehicle with the job card's lines — all of them, or the ones ticked (for extra work found later).
- A job card can have **several estimates** (the first, then extra work). Each says "For JC-00031"; the job card lists its estimates and where each stands.
- Each estimate line remembers the job card line it came from. Lines added on the estimate (work the accountant adds) are new.
- Anyone who edits documents may create one *(my call: the advisor may need to, when the accountant is away)*. Prices: the job card's, edited on the estimate.
- The old way stays: **Convert to job card** on an estimate made first. An estimate made from a job card doesn't convert to another job card — its approval goes back to its own *(my call)*.

### 2. Vendor prices on the estimate
- A part line that is on a parts request with vendors' prices shows them under the line to those who see costs: "Gulf Parts 180.00 · Sajaa 165.00 — suggested 198.00 (markup 20%) · Use". The markup is Settings → Pricing's parts markup. Advisors see nothing of it.

### 3. Sending
- As today ("Estimate ready", with the PDF). A second estimate for a job card that already has an approved one goes as **"Extra work needs approval"** *(existing message)*.

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
- Once approved, the estimate can't be edited or approved again *(my call: a change is a new estimate)*. Undoing an approval is out of Stage 1.

### 5. Approval goes back to the job card
- When an estimate **made from a job card** is approved:
  - its approved lines update their job card lines (description, quantity, price, discount);
  - approved new lines are added to the job card;
  - declined lines that came from the job card are **taken off** it (the work isn't done) *(my call)*; a part already bought follows today's rules (its cost stays on the job, "Bought for this job, not charged").
- The job card shows its estimates: "EST-00012 · approved by phone · 27 Nov" / "EST-00015 · sent, waiting".
- An estimate made first and converted (the rare way) works as today.

### 6. Ordering unapproved work
- **Order** on a parts request whose job card has an estimate not yet approved asks: "EST-00012 isn't approved yet. Order anyway?" A job card with no estimate (walk-in) doesn't ask *(my call)*.

## Constraints
- Migration 31: `documents.for_job_id` (an estimate's job card), approval fields on documents (`approved_at`, `approved_via`, `approved_by_name`, `approval_note`, `approval_recorded_by`), `document_lines.declined`. Lines keep using `source_line_id` for the job card line. Synced; the cloud is updated before PCs.
- Advisors never see vendors or costs (vendor prices show only to `costs.view`).
- Offline on a PC; issued invoices never change; stock rules unchanged in Stage 1.

## Approaches
- **A. Link estimates to their job card (picked):** a separate `for_job_id`, many estimates per job card, approval writes back. Keeps the one-conversion rule for estimate → job card → invoice.
- **B. Reuse `source_id`:** impossible — a job card's invoice already uses it, and it allows one.
- **C. Estimates as a tab inside the job card (no separate document):** loses the estimate number, PDF and the existing sending.

## Non-goals (Stage 1)
Undoing an approval; signing links (Stage 3); job card steps, QC and stock timing (Stage 2); insurance claims.

## Anti-goals
A declined line invoiced; an approval with no record of how and who; advisors seeing vendor prices; a job card getting a second job card from its own estimate.

## Left to the builder
Layout and wording; tests: server (create from job card, several estimates, approval write-back incl. declined and bought parts, converted-first path unchanged, order warning, permissions, sync), e2e (advisor job card → accountant estimate with vendor price → phone approval → job card updated → order → invoice).
