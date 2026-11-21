# Inventory v2, Part 2: Tracked stock and kits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:**
- tyres tracked one by one by DOT (week and year made), oldest suggested first;
- batteries tracked one by one by serial, with a warranty that runs from the day the battery is fitted;
- kits (service packages): one part made of other parts, sold at the kit's price, its stock and cost taken from its parts.

**Architecture:**
- `parts` gains `tracking` (`none` | `dot` | `serial`), `warranty_months`, and `is_kit`.
- New synced tables:
  - `stock_units`: one row per tracked unit on the shelf or fitted (`part_id`, `code` — the DOT `WWYY` or the serial,
    `unit_cost_fils`, `po_line_id`, `received_at`, `status` `in_stock` | `fitted` | `returned` | `written_off`,
    `document_id`, `fitted_at`, `warranty_ends`);
  - `kit_components` (`kit_part_id`, `component_part_id`, `qty`), replaced as a set like Part 1's child rows.
- `document_lines` gains `unit_ids_json`: the units a part line fits. Lines get new ids on every save, so units link
  to the document, never to a line id.
- `stock.ts` stays the only writer of stock:
  - `wanted` expands a kit line into its components (the kit itself is never stocked);
  - new `reconcileDocumentUnits(db, docId)`: the units named on the chain's lines become `fitted` to that document,
    and units no longer named go back `in_stock`. Called next to `reconcileDocumentStock`, including in sync's apply.
- Pure helpers in `packages/shared/src/tracked.ts`: `parseDot`, `dotAgeMonths`, `oldestFirst`, `warrantyEnds`, `kitAvailable`.

**Spec:** `docs/superpowers/specs/2026-11-21-inventory-v2-design.md` (Part 2: Tyres and batteries, Kits).

## Global Constraints
- Stock counts (`on_hand`, average cost, `stock_movements`) work exactly as now. Units are a record of *which*
  tyre or battery, kept in step with the count; they never move stock by themselves.
- A tracked part's quantities are whole numbers.
- Parts with `tracking = none` and `is_kit = 0` behave exactly as before. Old data needs nothing.
- Money in fils. Advisors still never see costs.
- Migration 21; `stock_units` and `kit_components` go in `SYNC_TABLES` after `parts`. The cloud is updated before PCs.
- Two PCs offline can fit the same unit. After sync the earlier document (by `created_at`, then id) keeps it; the
  other line is shown as needing a different unit and a sync issue is raised. Both PCs reach the same answer.

## Review Focus
1. Receiving 4 tyres asks for 4 DOT codes (`2524` = week 25 of 2024); a bad or missing code names the line and
   imports nothing. The 4 units are `in_stock` at that receipt's cost (Task 2 `receive units`).
2. A job card line for 2 tyres suggests the 2 oldest DOTs; saving fits them; removing the line puts them back;
   converting to an invoice keeps them (no double fitting) (Task 2 `fit and return`).
3. A battery fitted on 21 Nov 2026 with a 24-month warranty prints `Serial … · warranty to 21 Nov 2028` on the
   invoice, and the serial lookup finds it with the customer and vehicle (Task 2 `warranty`).
4. A kit "Minor service" (1 oil filter, 4.5 L oil) on a job card takes 1 filter and 4.5 L off the shelf, costs what
   they cost, and the "block below zero" setting checks the components (Task 3 `kits`).
5. Two PCs fit the same tyre offline: after both sync, one document has it and the other shows a sync issue
   (Task 2 `conflict`).

---

### Task 1: Shared helpers and migration 21
- `tracked.ts`:
  - `parseDot("2524")` → `{ week: 25, year: 2024 }`; weeks 1–53, year ≥ 2000 and not in the future; accepts `25/24`;
  - `dotAgeMonths(code, today)`; `oldestFirst(units)` (DOT, then received date);
  - `warrantyEnds(fittedAt, months)` (same day of month, clamped to the month's end);
  - `kitAvailable(components, onHand)` → whole kits that can be made.
- Zod: `partSchema` gains `tracking`, `warrantyMonths`, `isKit`, `components`; the line schema gains `unitIds`;
  `receiveSchema` lines gain `units: string[]`.
- Migration 21: the columns and tables above.
- Tests `packages/shared/test/tracked.test.ts`: `dot parse`, `oldest first`, `warranty end`, `kit available`.

### Task 2: Server: units in, units out
- Receiving a tracked part needs exactly `qty` codes (unique per part among units in stock); creates `stock_units`.
- A stock adjustment of a tracked part: up needs codes; down picks units (they become `written_off`).
- Document save checks each tracked line has whole `qty` and that many `unitIds` of that part that are in stock or
  already fitted to this chain; then `reconcileDocumentUnits`. The invoice made from a job card copies `unitIds`.
- An issued credit note returning a tracked part names its units; they go back `in_stock`.
- `fitted_at` is the date the unit was first fitted to the chain; `warranty_ends` from the part's `warranty_months`.
- `GET /api/parts/:id/units?status=in_stock` (oldest first); `GET /api/stock-units?q=` serial/DOT lookup with the
  document, customer and vehicle.
- Sync: `stock_units` rows sync; apply re-runs `reconcileDocumentUnits` for touched documents; a unit claimed by two
  documents raises a sync issue on the later one.
- The invoice and job card print show DOT or serial under the line, and a battery's warranty end.
- Tests `packages/server/test/tracked.test.ts`: `receive units`, `fit and return`, `warranty`, `adjust`, `credit note`;
  `packages/sync/test/tracked.test.ts`: `conflict`.

### Task 3: Kits
- A kit part: `is_kit = 1`, not stocked itself, its components replaced as a set; no kit inside a kit.
- `reconcileDocumentStock` and `checkStockAvailable` expand kit lines into components × line qty.
- The job's parts cost and margin come from the components' movements (no change to `documentCost` beyond the expansion).
- The part detail and picker show "N kits can be made". The invoice prints the kit as one line.
- Tests in `packages/server/test/kits.test.ts`: `kits`, `kit block`, `kit cost`, `kit in kit refused`.

### Task 4: Screens and e2e
- **Part form:** "Track each unit" (none / DOT / serial), warranty months, "This is a kit" with its parts and quantities.
- **Receive dialog:** a code box per unit for tracked lines (paste a list works).
- **Job card / invoice line:** a unit chooser for tracked parts (oldest DOT ticked first, age shown); a kit shows its parts.
- **Part page:** units in stock (DOT, age, cost for those who may see it) and fitted history.
- **Serial lookup:** a search box on Parts ("Find a serial or DOT").
- New `e2e:tracked`, a help guide section, and the README.
- Full verification (typecheck, unit tests, build, all e2e).
