# Fleetfix Garage Pro — Project 2: Inventory — Design

## Why
Garages keep some parts on the shelf and buy others for a particular job (user: "it will be
mixed"). Today a part on a job card is only free text, so the garage can't tell what's on the
shelf, what it cost or what to reorder. In Phase 2, garages in the Fleet Fix network can also
**request parts from Fleet Fix** (user). Inventory gives one parts list, stock counts that
match the shelf, purchasing from suppliers (Fleet Fix among them), and the cost of every job.

## Goals
- **Parts list.** One list for stocked and non-stocked parts. Each part has: part number
  (OEM or aftermarket), name, brand, unit (each, litre, set…), selling price, the vehicles it
  fits (free text), bin location, and an **active** flag. *Stocked* parts also have a quantity
  on hand and a reorder level. *Non-stocked* parts are bought per job.
- **Parts on jobs.** A part line on an estimate, job card or invoice can be picked from the
  parts list by name or part number. The picker shows stock on hand. Free-text part lines still
  work (no stock effect).
- **Stock comes off the shelf when a part is added to a job card** (user picked approach 1).
  Removing or reducing the line puts it back. The shelf count is always current.
- **Suppliers:** name, TRN, phone, email, address, notes. **Fleet Fix** is a built-in supplier.
- **Purchase orders (PO-00001…):** to one supplier, with lines (part or free text, qty, unit
  cost, optional link to a job card). Printable/PDF like the other documents.
- **Request a part from a job card:** adds a line, linked to that job, to the supplier's open
  draft PO (or starts one). The job card shows the part as *on order* until it's received.
  For a part already bought (e.g. cash from the shop next door), **"Already bought"** creates the
  PO and receives it in one step. *(My call: otherwise its cost would stay pending forever.)*
- **Receiving:** record the received quantity and cost per line, plus the supplier's invoice
  number, date, net, VAT and total. Stocked parts go onto the shelf. Parts bought for a job
  record their cost against that job. Part-receiving is allowed.
- **"Supplied by Fleet Fix" lines** (user: Fleet Fix is both a supplier *and*, on Fleet Fix
  jobs, provides the parts). Marking a part line this way charges it at zero, prints it as
  "Supplied by Fleet Fix", and never touches the garage's stock or costs.
- **Cost and margin.** Average cost per part (bought 1 at 40 then 1 at 50 → cost 45). Each job
  card and invoice shows its parts cost and margin to roles with `costs.view` (Owner,
  Accountant). Advisors never see cost, margin, or PO costs.
- **Stock take / adjustments** with a required reason (count, damaged, lost, opening stock).
- **Low stock:** a filter on the parts list and a count on the dashboard.
- **Import parts from CSV** with opening quantity and cost, so a garage can start with what's on
  its shelves. *(My call: entering hundreds of parts by hand would stop a garage switching over.)*

## Non-goals (this project)
Barcode scanning; more than one store/location; batch or serial numbers; returns to supplier;
paying suppliers, supplier statements and VAT return (Accounting, project 3); sending requests
to Fleet Fix over the internet (Cloud, project 4 — in phase 1 a Fleet Fix PO is printed or
shared like any other); customer-specific price lists.

## Anti-goals
- A shelf count that doesn't match the shelf (double counting on convert, or lost on edits).
- Advisors seeing cost or margin.
- Extra steps for advisors: picking a part on a job card must be no slower than typing it.
- Changing anything on an issued invoice.

## Approaches
1. **Picked: stock moves when a part is on the job card.** Every movement is a row in a stock
   history; each save of a job card records only the difference from what has already been
   taken for that job.
2. Rejected: stock moves when the invoice is issued — simplest, but parts in a car in the bay
   still count as on the shelf, so the last filter gets promised twice and low-stock is late.
3. Rejected: a separate "issue parts" step by a storekeeper — tightest control, but most small
   garages have no storekeeper, and parts get fitted without being issued.

## How it works
**Data (new migration 3; never edit 1–2):**
- `parts` (id, part_no, name, brand, unit, stocked, sell_price_fils, avg_cost_fils,
  on_hand REAL, reorder_level REAL, location, fits, active, timestamps). `on_hand` and
  `avg_cost_fils` are kept up to date in the same transaction as each movement.
- `suppliers` (id, name, trn, phone, email, address, notes, is_fleetfix, timestamps). The
  migration inserts the Fleet Fix row (is_fleetfix = 1).
- `stock_movements` (id, part_id, qty (+ in / − out), unit_cost_fils, reason
  `receive|job|invoice|adjust|opening`, document_id, po_line_id, note, created_by, created_at).
  Append-only — mistakes are corrected by another movement.
- `document_lines` gains `part_id` (nullable) and `supplied_by` (`garage`|`fleetfix`, default
  `garage`) and `po_line_id` (nullable, the request this line is waiting on).
- `purchase_orders` (id, seq, number, supplier_id, status `draft|sent|part_received|received|cancelled`,
  notes, totals, timestamps) and `po_lines` (id, po_id, part_id?, description, qty,
  received_qty, unit_cost_fils, job_document_id?). The job-card line points back via
  `document_lines.po_line_id`. Converting a document copies `part_id`, `supplied_by` and
  `po_line_id` with the line. Every new row has a UUID and timestamps, ready for Cloud sync.
- `goods_receipts` (id, po_id, supplier_invoice_no, supplier_invoice_date, net/vat/gross fils,
  created_by, created_at) and their lines. Project 3 turns these into supplier bills.

**The stock rule (one function, unit-tested hard):** for a document, *wanted* = sum of qty of
its part lines that have a `part_id`, are `supplied_by = garage`, and are for a **stocked**
part; *taken* = −sum of movements already recorded for that document's chain (a job card and
the invoice converted from it). Post `wanted − taken` per part.
- **Estimate:** never moves stock.
- **Job card:** reconciles on every save while it can be edited.
- **Invoice converted from a job card:** reconciles once, at **issue**, against the job card's
  movements — so convert moves nothing, and a part added on the draft invoice moves only the
  extra.
- **Invoice with no job card** (counter sale): takes its parts at issue.
- Outgoing movements are valued at the part's average cost at that moment; returns come back at
  the same average.
- **Stock can go below zero, with a warning** on the line and the part shown in red. *(My call:
  mechanics fit parts before the delivery is entered; blocking would stop the job, and the
  negative count tells the owner a receipt is missing.)*

- A job that's abandoned keeps its parts until the advisor removes the lines; there is no
  cancel status yet.
- A part can switch between stocked and non-stocked only when its on-hand is zero. *(My call.)*
- A part picked onto a line fills in its selling price; the advisor can change it, as today.
  A "Supplied by Fleet Fix" line is fixed at zero.

**Average cost** on receipt: if on_hand > 0, new avg = (on_hand × avg + qty × cost) /
(on_hand + qty); otherwise avg = cost. Rounded to whole fils.

**Job cost** = stocked parts at their movement cost + non-stocked parts at their received PO
cost. A non-stocked part line not yet received shows "cost pending".

**Permissions** (add to `packages/shared/src/rules.ts`): `inventory.edit` (parts list, CSV
import, adjustments) and `purchases.manage` (POs, receiving, suppliers) for Owner and
Accountant. Advisors can view parts, sell prices and stock, pick parts on documents, and
**request a part** (creates or adds to a draft PO without costs; the Accountant prices and
sends it). Receiving is Owner/Accountant only, because it records costs. *(My call.)* `costs.view` gates every cost and margin field in API responses, not only in the UI.

**Screens:** Parts (search, low-stock filter, part page with movement history), Suppliers,
Purchase orders (list, editor, receive), part picker and "Request part" on the document editor,
low-stock count on the dashboard. Main-computer mode needs nothing extra — all through the API.

**Tests:** Vitest for the stock rule (add, edit, remove, convert, issue, counter sale, Fleet
Fix lines, free-text lines), average cost and permissions; extend `garageDay` e2e with a stocked
part, a part requested and received for a job, and the shelf count after invoicing; Windows CI
as today.

## Left to the builder
Screen layouts, CSV column format, PO print layout, which list columns to show, the wording of
warnings.
