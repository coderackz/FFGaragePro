# Inventory v2, Part 1: Catalogue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Parts become catalogue items:
- alternate numbers and supersession;
- vehicle fitment matched to the job's vehicle;
- categories with searchable attributes;
- purchase packs.

**Architecture:**
- New synced tables: `part_categories`, `part_numbers`, `part_fitments` and `part_packs`.
- New columns:
  - on `parts`: `category_id`, `attributes_json`, `spec_text`, `superseded_by`;
  - on `vehicles`: `engine`;
  - on `po_lines`: `pack_name` and `pack_size`.
- Pure helpers in `packages/shared/src/catalogue.ts`:
  - number normalising;
  - fitment matching;
  - spec text, including the tyre size;
  - pack maths.
- The server search uses them. The screens extend the part form, the parts list, the part picker, Settings → Inventory, the vehicle form and the PO lines.

**Spec:** `docs/superpowers/specs/2026-11-21-inventory-v2-design.md` (Part 1).

## Global Constraints
- Stock is counted and sold in the part's unit. Packs only convert on purchase orders.
- Money in fils.
- Old data keeps working:
  - parts with no category, numbers or fitment behave as before;
  - the `fits` text stays;
  - `reorder_level` is untouched.
- Migration 19; the new tables are added to `SYNC_TABLES` after `parts`.

## Review Focus
1. Searching `04152YZZA1` finds a part whose OEM number is `04152-YZZA1`, and the result says it matched on OEM (Task 2 `alternate numbers`).
2. A superseded part with no stock: the picker offers its newest replacement marked "replaces …". A loop A→B→A doesn't hang (Task 2 `supersession`).
3. A vehicle with no year, or a fitment with no years: still matches on make/model. The engine counts only when both sides have one (Task 1 `fitment match`).
4. A PO line in packs: 2 × Drum 208 L at AED 1,664 gives qty 416 at AED 8.00 a litre. Receiving, stock and average cost are unchanged (Task 3 `packs`).
5. A CSV with a bad fitment cell names the row and column, and imports nothing (Task 3 `csv`).

---

### Task 1: Shared catalogue helpers and migration 19
- `catalogue.ts`:
  - `normalizeNumber(s)`: uppercase, with spaces, dashes, dots and slashes removed;
  - `fitmentMatches(f, v)`;
  - `specText(attrs, categoryAttrs)`: the values joined, and for tyres `W/PRrR` plus the digits;
  - `packToBase(packs, size, costPerPack)` → `{ qty, unitCostFils }` (rounded per unit to the fil);
  - Zod schemas `categorySchema`, `partNumberSchema`, `fitmentSchema` and `packSchema`;
  - the extended `partSchema` (`categoryId`, `attributes`, `numbers`, `fitments`, `packs`).
- Migration 19 creates the tables and columns, and seeds the categories (Settings → Inventory edits them).
- Tests in `packages/shared/test/catalogue.test.ts`: `normalize`, `fitment match`, `spec text tyre size`, `packs`.

### Task 2: Server: categories, part details, search, supersession, quick fitment
- Routes:
  - `GET/POST/PATCH /api/part-categories`;
  - the part `POST/PATCH` take `numbers`, `fitments`, `packs`, `categoryId` and `attributes` (the child rows are replaced as a set);
  - `POST /api/parts/:id/supersede {byPartId|null}` (no loops);
  - `POST /api/parts/:id/fitments/from-vehicle {vehicleId}`.
- `GET /api/parts?q=&vehicleId=&categoryId=&picker=1` returns `matchedBy`, `fits` and `replaces`:
  - superseded parts with no stock are hidden in picker mode;
  - their newest replacement is added instead;
  - parts that fit come first.
- The part detail returns its numbers, fitments, packs, category, attributes and supersession chain.
- Vehicles gain `engine`.
- Tests in `packages/server/test/catalogue.test.ts`: `alternate numbers`, `supersession`, `fitment ordering`, `categories`, `quick fitment`.

### Task 3: Packs on POs and the CSV import
- A PO line takes `packName` and `packSize` (a snapshot): the line qty and cost are in the base unit, and the print shows packs.
- CSV `category`, `numbers` and `fitment` columns.
- Tests: `packs`, `csv`.

### Task 4: Screens and e2e
- **Part form:** category and its attributes, alternate numbers, fitment rows, packs, and "Replaced by".
- **Parts list:** category filter, a category column, and a "Replaced" badge.
- **Picker:** a Fits badge, the matched number, "replaces", and fitting parts when nothing is typed.
- **Part line chip:** "Fits this vehicle".
- **Settings → Inventory:** categories.
- **Vehicle form:** engine.
- **PO line:** pack picker.
- New `e2e:catalogue`, a help guide update, and the README.
- Full verification (typecheck, unit tests, build, all e2e).
