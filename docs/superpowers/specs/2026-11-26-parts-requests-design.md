# Parts requests, vendor prices and orders — design

**Date:** 2026-11-26 · **Status:** the user said "Several vendors and start building" (2026-11-26); everything marked *(my call)* was decided by the builder and is open to correction.

## Why

The user: advisors don't see supplier details. "Advisor create job card and request for parts. The purchase team, accountant order the parts from supplier." "Don't use fleetfix as a default vendor." "Advisor click on request parts → automatically a PO is generated without any vendor name. Accountant can send the PO directly to the vendor via email or whatsapp. So no parts purchase will be missed out." Garages mostly buy parts for a particular job; a parts catalogue is too much work for a small garage; vendors need the vehicle's Mulkiya or VIN to price a part. Asked whether the accountant asks one vendor or several for prices: **several vendors**.

## Today (main 4718c67)

- Request part (any role that edits documents) opens a dialog where the advisor picks a supplier (Fleet Fix preselected); the line goes onto that supplier's draft purchase order.
- Advisors open Purchases and Suppliers: supplier names, phones, emails, TRNs and addresses. Prices are already hidden.
- A typed part line, requested and delivered, puts its cost on the job and never enters stock: no catalogue is needed for parts bought per job.
- Typing on a part line already searches the parts list and shows "5 on shelf"; ignoring it leaves a typed line.
- The vehicle has a VIN; nothing holds a Mulkiya.
- A purchase order always has a supplier (`purchase_orders.supplier_id NOT NULL`). There's no way to send it to the supplier from the app.

## Goals

### 1. Advisors never see vendors
- Advisors (no `purchases.manage`) can't open Purchases or Suppliers: the menu hides them and the API refuses the supplier list and details, purchase order list and details, and messages to vendors.
- On the job card a requested line shows **Requested · PO-00012** (no vendor yet), then **On order · PO-00012**, then **Received**; never a vendor.
- The used parts still to buy stay visible to advisors on the job card ("Not bought yet"); the list on Purchases is for Owner and Accountant. *(my call: it sits on a page advisors no longer open.)*

### 2. Request part makes a purchase order without a vendor
- **Request part** on a line no longer opens a dialog: the line (its quantity) goes onto **this job card's request**, a purchase order with no vendor, made with the first request. Toast: "Requested on PO-00012".
- **Request parts (N)** on the job card requests every line that can be requested and isn't from the shelf, in one go. *(my call)*
- Which lines: garage-supplied part lines with a description, not used, not a kit, not already on an order. A part from the parts list can still be requested one by one (it goes to stock on delivery, as now).
- One open request per job card: further requests join it until it's ordered; after that a new request starts. *(my call)*
- **Already bought** (Owner/Accountant, paid at a shop): its own button and dialog as now, the supplier must be chosen, nothing preselected.
- **Fleet Fix is never preselected** anywhere (Already bought, New purchase order). "Supplied by Fleet Fix" on a line is unchanged.

### 3. Asking several vendors for prices
On Purchases, **Parts requests** lists every request without a vendor, oldest first: number, job card, vehicle, parts, and where it is (Not sent / Asked 3 · 2 priced). The count shows in the card title so nothing waits unseen.

The request's page:
```
PO-00012 · Request · for JC-00031            [Ask vendors for prices]  [Order]
Vehicle  Toyota Land Cruiser 2019 · 4.0L · VIN JTMHV05J904123456  · Mulkiya: front ✓ back ✓
Parts                          Qty   Al Futtaim   Gulf Parts   Sajaa
1 Front brake pads              1    (•) 180.00   ( ) 165.00   —
2 Rear shock absorbers          2    ( ) 420.00   (•) 395.00   ( ) 410.00
                         Total        180.00       790.00
```
- **Ask vendors for prices:** tick saved vendors (or add one: name, phone, email), tick **Attach Mulkiya photo** (off by default), then for each vendor **Send by WhatsApp** and/or **Send by email**. Each sends the request:
  - text: "Please send your price and availability for: 1 × Front brake pads, 2 × Rear shock absorbers. Toyota Land Cruiser 2019 4.0L, VIN …. Ref PO-00012. {garage}"
  - a PDF "Request for prices" with the garage's header, the reference, the vehicle (make, model, year, engine, VIN), the parts and quantities, and the Mulkiya photos when ticked.
  - No plate, no customer name. *(my call: the vendor needs the car, not the customer.)*
- WhatsApp opens the chat with the text (the PDF saved to drag in), as for customers; email goes from the garage's mailbox with the PDF. *(my call: no WhatsApp Business API for vendors: it needs a Meta template per message.)*
- Each vendor asked gets a column. The accountant types each vendor's price per part as the replies come (blank = not available). The lowest price per part is chosen to start; the accountant can choose another.
- **Order:** each vendor's chosen parts become that vendor's purchase order, priced, marked sent. The request keeps its number for the vendor with the first part *(my call: the advisor already saw PO-00012)*; other vendors get new numbers. Parts without a chosen price stay on a new request to ask again.
- Ordering asks once: "Order 1 part from Al Futtaim (AED 180.00) and 1 from Gulf Parts (AED 790.00)?"

### 4. Sending an order to the vendor
Any purchase order with a vendor (not cancelled) gets **Send to vendor**: WhatsApp or email with the purchase order PDF (as printed today) and a short text. Sending a draft marks it sent. The PO page lists what was sent, when and how.

### 5. Mulkiya on the vehicle
- The vehicle form gets **Mulkiya**: a front and a back photo, chosen from a file (or a phone photo copied to the PC). Anyone who edits customers may add or replace them. *(my call: taken at intake by the advisor.)*
- Stored shrunk (longest side 1600 px, JPEG), synced like other records. Shown on the vehicle and on the request page.

### 6. Shelf parts while typing
- An unlinked part line whose text matches a shelf part with stock shows under it: **On the shelf: Oil filter (OF-1001) · 5 — Use it**. Use it links the line, as picking from the list does. *(my call: a hint, never an automatic link: the wrong part would leave the shelf.)*

## Constraints

- **Migration 29:** `purchase_orders` rebuilt with `supplier_id` nullable and `job_document_id` (the request's job card); new `po_quotes` (a vendor asked for a request) and `po_quote_prices` (that vendor's price per line); `vehicle_files` (Mulkiya photos); `messages.po_id` and `messages.supplier_id`. All synced; the cloud is updated before the PCs.
- A purchase order without a vendor can't be received, marked sent or sent; it can be cancelled.
- Prices typed from vendors are costs: only roles with `costs.view` see them (purchasing roles have it).
- Offline, PC and browser app, 1024–1440 px. Money in fils.
- An older PC that still sends a supplier with Request part gets the vendorless request anyway.

## Approaches

- **A. A purchase order with the vendor left blank (picked).** Matches the user's words ("a PO is generated without any vendor name"); the advisor's number stays the same through ordering; few queries assume a vendor (all on received orders).
- **B. A separate "parts request" record turned into orders later.** No table rebuild, but a second numbering, and the job card would show a request number that later changes.
- **C. A hidden "Vendor not chosen" supplier.** No rebuild, but it would leak into supplier lists, statements and reports.

## Non-goals

A purchaser role (purchasing stays with Owner and Accountant: the user said the accountant orders); WhatsApp Business API to vendors; vendors replying inside the app; prices for used parts through requests; splitting one part's quantity between vendors; a parts catalogue requirement.

## Anti-goals

An advisor seeing a vendor; a requested part forgotten; a vendor getting the customer's name or plate; Mulkiya sent without the accountant ticking it; a part moved off the shelf by a guess.

## Left to the builder

Layout and wording; column names; tests: server for visibility, request, quotes, ordering, sending and Mulkiya; sync with two computers; e2e from the advisor's request to the order sent and received.
