# Vehicle names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Makes and models chosen from a list with suggestions, corrected automatically (with Undo) when mistyped, never blocked when unlisted; the owner tidies the garage's spellings.

**Architecture:** The built-in list and the correction rules live in `packages/shared/src/vehicleNames.ts` (pure, offline). The garage's list is read from vehicles and fitments (`GET /api/vehicle-names`); renames go through `POST /api/vehicle-names/rename`. A `MakeModelFields` component applies the rules on the screen.

**Spec:** docs/superpowers/specs/2026-11-27-vehicle-names-design.md

## Global Constraints
- No migration; offline; the server stores what it's sent.
- One close match only (1 letter ≤ 5 letters, else 2); models within their make; Undo keeps the typed text.
- Rename/merge is owner only (`settings.manage`).

## Review Focus
1. Two equally close names ("Kia" typed "Kla"? vs other 3-letter makes) — left alone.
2. A garage's own spelling that's close to a list name — never "corrected" away once saved.
3. Short names that are also real names (e.g. "Fit" Honda model vs "Fiat") — model rules don't touch makes.
4. Renaming a make carries its models' vehicles along and doesn't touch other makes' same-named models.
5. Blank make + model in several makes ("Accent"? only Hyundai; "Patrol" only Nissan; "Sunny" Nissan) — fill only when exactly one.

### Task 1: Shared list and rules
**Files:** create packages/shared/src/vehicleNames.ts (+ export), test packages/shared/test/vehicleNames.test.ts; modify catalogue.ts fitmentMatches to compare with `nameKey`.
**Produces:** `nameKey(s)`, `VEHICLE_MAKES: {name, models[], aliases?}[]`, `MAKE_ALIASES`, `MODEL_ALIASES`, `correctMake(typed, garageMakes) → Correction|null`, `correctModel(typed, make, garageModels) → Correction|null`, `makeOfModel(model) → string|null`, `makeFromVin(vin) → string|null`; `Correction = { value: string; note: boolean }`.
- [ ] Tests first (typos, aliases, ties, case-only silent, garage names known, models within make, VIN, fitment matching spaces), then implement, commit.

### Task 2: Server — the garage's names and renaming
**Files:** packages/server/src/routes/customers.ts; test packages/server/test/vehicle-names.test.ts.
**Produces:** `GET /api/vehicle-names` → `{ makes: {name, vehicles}[], models: {make, name, vehicles}[] }` (vehicles + fitments, grouped by nameKey, most-used spelling shown); `POST /api/vehicle-names/rename {kind: "make"|"model", make?, from, to}` (settings.manage) updates vehicles and part_fitments whose nameKey matches.
- [ ] Tests first, implement, commit.

### Task 3: Screens and e2e
**Files:** components/MakeModelFields.tsx; forms.tsx (vehicle form, VIN fill); catalogueFields.tsx (fitments); pages/VehiclesPage.tsx (Makes & models, owner); help; e2e apps/desktop/test/vehicle-names.spec.ts + playwright.vehicles.config.ts + `npm run e2e:vehicles`.
- [ ] e2e: "Toyta" → Toyota with note, Undo keeps it; "landcruser" → Land Cruiser; "LC200" → Land Cruiser; model with blank make fills Toyota; VIN fills make; "Jetour"/"T2" kept; owner merges "Toyta" into Toyota.
