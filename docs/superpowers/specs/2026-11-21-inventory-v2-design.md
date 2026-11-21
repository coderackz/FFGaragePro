# Fleetfix Garage Pro — Inventory v2 (spare-parts inventory) — Design

## Why
The user (2026-11-21): "The inventory now is a very basic one. I want something very close to spare parts inventory. Make a research and update the module."
- Today's parts list has, per part: one part number, a free-text "fits", one shelf count, a reorder level and an average cost.
- Spare-parts systems (dealer parts departments, parts ERPs) add more: alternate numbers and supersession, vehicle fitment, categories with specs, purchase packs, tyre DOT and battery serial tracking, min/max with suggested orders, returns, cores and warranty claims, kits, and stock analysis.
- Sources are listed in the conversation of 2026-11-21: Flxpoint, ECOSIRE, Sysonline, Auto/Mate, Solera, Emeron, Vyapar, Software Advice, Tekmetric, Anyline, Finale and Cleverence.

## Decided by the user
- **Catalogue (all four):**
  - alternates and supersession;
  - vehicle fitment;
  - categories with attributes;
  - units and packs.
- **Stock:**
  - tyres and batteries;
  - min/max with suggested orders.
  - Not wanted: several stores or bins, barcode scanning.
- **Buying:**
  - returns to the supplier, cores and warranty claims.
  - Not wanted: counter sales, supplier price lists, landed cost.
- **Reports:**
  - ABC, fast/slow movers and dead stock;
  - valuation and stock aging;
  - kits (service packages).
  - Not wanted: lost sales, special orders.
- **Fitment** is typed by the garage: on the part, by a quick add from the vehicle on a job card, or by CSV import. A paid catalogue (TecDoc) is not used now.
- **Tyres:** each tyre's DOT (week and year made) is recorded one by one on receiving and picked one by one on the job card.
- **Batteries:** tracked by serial number, with the warranty running from the day the battery is fitted.
- **Cores:** supplier cores only. The garage pays a core deposit to the supplier and gets it back when the old unit goes back. Customers are never charged a core.
- **Min/max:** suggested from usage (the last 90 days and the lead time). The owner accepts or overrides each part.

## The parts (each built, reviewed and shipped on its own)
1. **Catalogue:**
   - alternates and supersession;
   - vehicle fitment;
   - categories and attributes;
   - packs.
2. **Tracked stock and kits:**
   - tyres by DOT;
   - batteries by serial and warranty;
   - kits.
3. **Planning and reports:**
   - min/max and suggested orders;
   - ABC and fast/slow movers;
   - dead stock;
   - valuation and aging.
4. **Returns, cores and warranty claims:** these join the supplier bills (debit notes) in the books.

## Part 1 — Catalogue
- **Alternate numbers.** A part keeps its own part number. It can also have any number of other numbers, each of one kind:
  - **OEM** (the carmaker's number);
  - **aftermarket** (another brand's number for the same part);
  - **supplier** (the code a supplier uses);
  - **old** (a number it used to have).

  Searching by any of these finds the part. The search ignores spaces, dashes and letter case, so `04152-YZZA1` and `04152YZZA1` match. The list says which number matched.
- **Supersession.**
  - A part can be marked **replaced by** another part; the old part keeps its history.
  - Searching for the old part shows its newest replacement, following the chain A → B → C and stopping at a loop, with "replaces A".
  - On a job card, the old part is still offered while it has stock, so old stock goes first. Once its stock is gone, only the replacement is offered.
  - Each part shows its chain.
- **Vehicle fitment.**
  - A part has fitment rows: make, model, years from–to, engine and a note. Each field except make may be left blank, which means "any".
  - Vehicles gain an **engine** field (e.g. 1GR-FE, 2.7L).
  - On an estimate, job card or invoice with a vehicle:
    - the part search shows the parts that fit that vehicle first, with a **Fits** mark;
    - with nothing typed, it offers up to 8 parts that fit.
  - A linked part line shows **"Fits this vehicle"** for anyone who edits parts, which adds that vehicle's make, model and year as fitment.
  - Matching rules:
    - make and model are compared ignoring letter case and spaces;
    - the vehicle's year must fall within the years;
    - the engine only counts when both sides have one.
  - The old free-text "fits" field stays, shown as a note.
- **Categories and attributes.**
  - Categories form a tree, managed in Settings → Inventory.
  - Each category has its own attributes: label, type (text, number or a choice from a list) and an optional unit.
  - Seeded categories and attributes:
    - Oils & fluids: grade, specification;
    - Filters: filter type;
    - Brakes: position, type;
    - Tyres: width, profile, rim, load index, speed rating;
    - Batteries: Ah, CCA, group/size, terminal;
    - Spark plugs & ignition;
    - Suspension & steering;
    - Engine;
    - Electrical & lighting;
    - Cooling & A/C;
    - Body & glass;
    - Accessories;
    - Other.
  - A part picks a category and fills that category's attributes.
  - A part's specs are searchable. A tyre's size is also written as `265/65R17` (and `2656517`), so typing a tyre size finds it.
  - The parts list filters by category.
- **Units and packs.**
  - The part's unit (each, litre…) is what stock is counted and sold in.
  - A part can have **packs**, e.g. "Box of 10" (10 each) or "Drum 208 L" (208 litre).
  - On a purchase order line, you can enter the number of packs and the cost per pack. The app stores the quantity and unit cost in the part's unit, so receiving, stock and costs are unchanged.
  - The PO prints "2 × Drum 208 L".
- **CSV import** gains these columns:
  - category;
  - alternate numbers (`OEM:04152-YZZA1; AM:W 68/3`);
  - fitment (`Toyota|Land Cruiser|2016-2021|1GR-FE; …`).
- **Permissions:**
  - editing parts, numbers, fitment and packs: `inventory.edit`;
  - categories: `settings.manage`;
  - unchanged for everyone else.
- **Sync:** the new tables (categories, part numbers, fitments, packs) sync like the other master data.

## Parts 2–4 (planned after Part 1; written up in full when each starts)
- **Tyres and batteries.**
  - A part is marked as tracked by DOT (tyres) or by serial (batteries).
  - Receiving asks for each unit's DOT week/year or serial number.
  - A job card line picks units; the oldest DOT is suggested first.
  - The invoice prints the DOT or serial, and a battery's warranty end date.
  - Units can be looked up by serial.
- **Kits.** A kit is one part made of other parts with quantities, sold at the kit's price. Its stock comes off the parts it's made of, and its cost is theirs.
- **Planning:**
  - min/max with suggested levels (90-day usage × (lead time + 14 days) for the minimum; plus 30 days' usage for the maximum);
  - a preferred supplier and lead time per part;
  - **Suggested orders**: anything below its minimum, counting stock already on order, is topped up to its maximum, grouped by supplier, as draft POs in one click.
- **Reports:**
  - ABC by 12-month usage value (A = top 80 %, B = next 15 %, C = the rest);
  - fast and slow movers;
  - dead stock (no use in 6 or 12 months, with its value);
  - valuation by category;
  - aging by the last receipt.
- **Returns, cores and warranty:**
  - **Return to supplier** (RTS-00001) takes stock off at its cost and makes a supplier debit note in the books.
  - **Cores:** a part's core deposit is recorded when it's received. It is owed back until the old unit is returned, which makes a debit note, or written off.
  - **Warranty claims** against the supplier (for a part or a battery serial) run open → replaced / credited / rejected. A replacement comes into stock at no cost; a credit is a debit note.

## Constraints
- Money in fils. Stock is counted in the part's unit.
- Nothing changes for a garage that doesn't use these features: the existing parts, jobs, POs and stock keep working as they are.
- Screens stay English; part names can have Arabic as now.
- Migration 19 for Part 1. The cloud is updated before PCs.

## Approaches
- **Alternate numbers:**
  - **A. A table of numbers per part (chosen):** any number of them, searchable, with a kind.
  - **B. One "alternates" text field:** simpler, but can't say which number matched or where it came from.
- **Fitment:**
  - **A. Structured rows (chosen):** make, model, years and engine, matched to the job's vehicle.
  - **B. Keep free text:** no matching possible.
- **Packs:**
  - **A. Packs only on buying (chosen):** stock and selling stay in one unit, so nothing downstream changes.
  - **B. A second stock unit:** much more risk to the shelf count.

## Anti-goals
- A shelf count that's wrong after packs or supersession.
- Searching becoming slower than typing.
- Advisors seeing costs.

## Left to the builder
- The layout of the part form and the list.
- The seeded categories' exact attribute options.
- How the chain is drawn.
