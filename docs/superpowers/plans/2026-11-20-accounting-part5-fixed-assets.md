# Accounting Part 5: Fixed Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fixed asset register (tools, equipment, vehicles, fit-out). It records:
- cost, the date put into use, useful life, residual value, and the account the asset sits in;
- straight-line depreciation posted monthly by the app;
- selling or writing off an asset, which posts the gain or loss.

**Architecture:**
- **The register:** a mergeable `fixed_assets` table.
- **Depreciation:** one `postPending` rule posts **one entry per month** for every asset due. Each line carries `journal_lines.asset_id`, so what was posted per asset is known. Each month's charge is the asset's cumulative due through that month, less what is already posted (plus any depreciation brought forward from before the books). Assets added late, or changed, catch up in the next entry.
- **Disposal:** a second rule. It first brings depreciation up to the disposal month, then removes cost and accumulated depreciation, and books the proceeds and the gain or loss.
- **Nothing double-counted:** the register never posts the purchase itself. That cost reaches the books through the supplier bill, the journal, or the opening balances that paid for it. A new Books health check keeps the register and the books in step.

**Tech Stack:** As before.

**Spec:** `docs/superpowers/specs/2026-11-19-accounting-design.md` (Part 5; posting table: "Depreciation (Part 5) | Depreciation expense | Accumulated depreciation"; Decisions §2 and §3; Constraints).

**Branch:** `feature/accounting-part5-assets`, from `feature/accounting-part4b-leavers`. **Migration 16.** It goes to the cloud before any PC.

## Global Constraints
- Money in fils, every entry balances, and posted entries never change.
- Depreciation posts only where the books post.
- Who: `books.post` (Owner, Accountant) manages assets; `books.view` sees the register.
- **Depreciation policy (my call, shown on the screen):**
  - straight line;
  - a full month's charge from the month the asset goes into use;
  - the monthly charge = round((cost − residual) ÷ life in months), and the last month takes the rounding;
  - it never goes beyond cost − residual;
  - none after the disposal month.
- **Assets bought before the books start:** `openingDepreciationFils` is the depreciation already taken by the day before the start (it is in the opening trial balance). The app only posts from the start month on.

## Review Focus
1. An asset added after months were already posted is caught up in the next entry, not in a past locked month → Task 2 test `late asset catches up`.
2. An asset fully depreciated stops. Rounding ends exactly at cost − residual → Task 1 test `schedule ends at cost less residual`.
3. Selling in the middle of its life:
   - depreciation runs through the sale month and no further;
   - cost and accumulated depreciation leave the books;
   - the gain or loss is right for proceeds above, equal to or below book value;
   - a write-off has proceeds of 0.

   → Task 2 test `disposal posts gain or loss`.
4. A pre-start asset with depreciation brought forward: no double charge, and the schedule continues → Task 2 test `pre-start asset continues`.
5. Changing cost or life after depreciation has posted: the catch-up moves the total to the new schedule and never posts negative depreciation beyond what was posted → Task 2 test `change in estimate`.

---

### Task 1: Shared model and maths

**Files:**
- Create: `packages/shared/src/assets.ts`.
- Modify: `books.ts` (accounts).
- Test: `packages/shared/test/assets.test.ts`.

**Interfaces (produces):**
- **SYSTEM accounts:**
  - `accumulated_depreciation` 1590 (existing id, now a system account);
  - `depreciation` 6070 "Depreciation";
  - `disposal_gain` 4030 "Gain on disposal of assets";
  - `disposal_loss` 6080 "Loss on disposal of assets".
- **OTHER:** `1520 "Fit-out and furniture"`.
- **`assetSchema`:**
  ```ts
  { name; category: "tools" | "equipment" | "vehicle" | "fit_out"; accountId; costFils > 0; inUseFrom: ymd;
    lifeMonths: int 1–600; residualFils ≥ 0 (< cost); openingDepreciationFils ≥ 0 (default 0); serial?; note? }
  ```
- **`disposeSchema`:** `{ date; proceedsFils ≥ 0; proceedsAccountId: string | null (needed when proceeds > 0); note? }`
- **`depreciationThrough(a: { costFils; residualFils; lifeMonths; inUseFrom }, month: "YYYY-MM"): number`:** the cumulative depreciation due through that month:
  - 0 before the in-use month;
  - min(months × monthly, cost − residual), where monthly = round((cost − residual) ÷ life) and months counts the in-use month as 1.
- **`monthsBetween(fromMonth, toMonth)`.**

- [ ] **Step 1: Write the failing tests**

```ts
const a = { costFils: 1200000, residualFils: 0, lifeMonths: 36, inUseFrom: "2026-01-15" };
it("a full month's charge from the month in use", () => {
  expect(depreciationThrough(a, "2025-12")).toBe(0);
  expect(depreciationThrough(a, "2026-01")).toBe(33333);
  expect(depreciationThrough(a, "2026-12")).toBe(33333 * 12);
});
it("schedule ends at cost less residual", () => {
  expect(depreciationThrough(a, "2028-12")).toBe(1200000);
  expect(depreciationThrough(a, "2030-06")).toBe(1200000);
  expect(depreciationThrough({ ...a, residualFils: 200000 }, "2040-01")).toBe(1000000);
});
it("asset input checks", () => {
  expect(() => assetSchema.parse({ name: "Lift", category: "equipment", accountId: "x", costFils: 100, inUseFrom: "2026-01-01", lifeMonths: 12, residualFils: 100 })).toThrow();
  expect(() => disposeSchema.parse({ date: "2026-05-01", proceedsFils: 500, proceedsAccountId: null })).toThrow();
});
```

- [ ] **Step 2: Run** `npx vitest run packages/shared/test/assets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, then `npm run typecheck` — Expected: pass.
- [ ] **Step 5: Commit** `feat(assets): fixed asset model and depreciation maths`.

### Task 2: The register, depreciation and disposal on the server

**Files:**
- Modify: `migrations.ts` (migration 16), `packages/sync/src/tables.ts`, `books/post.ts` (`PostLine.assetId`, source types), `books/rules.ts`, `books/pending.ts`, `books/reports.ts` (health).
- Create: `packages/server/src/assets/register.ts`, `packages/server/src/routes/assets.ts`.
- Test: `packages/server/test/assets.test.ts`.

**Interfaces:**
- **Migration 16:**
  - Rebuild `journal_entries` with the `'depreciation'` and `'asset_disposal'` kinds.
  - `ALTER TABLE journal_lines ADD COLUMN asset_id TEXT`.
  - Accounts: system keys for 1590; insert 6070, 4030, 6080 and 1520, moving a garage's own account on those codes aside to `.1`, as migration 14 did.
  - A `fixed_assets` table with every `assetSchema` field, plus disposed_on, proceeds_fils, proceeds_account_id, disposal_note, created_at and updated_at. It is mergeable and synced.
- **`PostLine.assetId`** is stored in `asset_id`.
- **Functions:**
  - `listAssets(db, { includeDisposed })`: each asset with `postedFils` (posted depreciation plus the opening amount), `bookValueFils = cost − that`, and `monthlyFils`.
  - `getAsset(db, id)`: the same, plus the schedule (month, charge and running total, for posted and future months).
  - `createAsset` and `updateAsset`. The checks:
    - the account must be an active asset account, not a money account or one the app keeps;
    - an asset in use before the books start is fine;
    - no edits after disposal.
  - `disposeAsset(db, id, input, userId)`:
    - not disposed already;
    - the date must be on or after in-use, and not locked;
    - proceeds above 0 need a cash, bank or receivables account. (Receivables needs a customer, so for now: cash or bank only.)
- **Posting rules**, run before the payroll rules:
  - **`postDepreciation`:** for each month M from max(the first in-use month, the books start month) through the last month that has ended (the current month is left out), and for each asset in use by M and not disposed before M:
    - due = `depreciationThrough(asset, M)`, but held at the disposal month's figure after a disposal;
    - posted = `openingDepreciationFils` + Σ that asset's lines in depreciation entries dated up to M's end;
    - one entry per month, key `depreciation:<M>:<n>` (n counts the entries already posted for M, so a later catch-up adds one);
    - one line per asset with a non-zero difference: Dr 6070 / Cr 1590, both lines carrying assetId, dated M's last day.
    - A negative difference (life lengthened) posts the reverse.
  - **`postDisposals`:** disposed assets without `asset_disposal:<id>`, once depreciation through the disposal month is posted for them. If it isn't, run the depreciation step for that asset's months first.
    - Lines:
      - Dr 1590 its accumulated depreciation (posted + opening);
      - Dr the proceeds account (proceeds);
      - Cr its asset account (cost);
      - the gain to 4030 (Cr) or the loss to 6080 (Dr);
    - all carrying assetId, dated the disposal date.
- **Health check** `fixed_assets`: Σ cost of assets not disposed = the balance of the asset accounts the register uses. Σ (opening + posted) depreciation of assets not disposed = −balance of 1590. Message: "Fixed asset register = asset accounts and accumulated depreciation".
- **Routes:**
  - `GET /api/assets` and `GET /api/assets/:id` (`books.view`);
  - `POST /api/assets`, `PATCH /api/assets/:id` and `POST /api/assets/:id/dispose` (`books.post`).

- [ ] **Step 1: Write the failing tests** (pinned clock 2026-11-20; books from 2026-07-01; the asset's cost put in by a supplier bill on 6050/1500 so the books hold it):
  - **`monthly depreciation posts per month`:** a lift costing 12,000.00 over 36 months, in use 2026-07-10.
    - Entries for Jul–Oct: 4, each Dr 6070 333.33 / Cr 1590 333.33. November isn't posted yet.
    - `postPending` twice: still 4.
  - **`late asset catches up`:** the lift is added on 2026-11-20 with in-use 2026-07-10. One entry for October carries Jul–Oct (1,333.32), not entries in past months.
  - **`pre-start asset continues`:** a van costing 60,000.00 over 60 months, in use 2025-07-01, with opening depreciation 12,000.00 (12 months). July 2026's charge is 1,000.00.
  - **`disposal posts gain or loss`:**
    - the lift sold 2026-10-15 for 11,500.00 to the bank: depreciation through October (4 × 333.33 = 1,333.32); book value 10,666.68; gain 833.32;
    - the entry is `{ "1590": 133332, "1020": 1150000, "1500": -1200000, "4030": -83332 }`;
    - nothing after October;
    - a write-off variant: proceeds 0, so the loss is the book value on 6080.
  - **`change in estimate`:** after Jul–Oct are posted, change the life to 24 months. The next entry catches up to 4 × 500.00. Changing it back to 48 months posts a negative catch-up (a credit to 6070), never below 0 in total.
  - **`fixed asset health`:** green with the lift bought by a bill to 1500; red if the register's cost differs from 1500's balance.
  - **`permissions`:** an advisor gets 403 on both list and create; an accountant can create.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/assets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** that file, then `npm test` and `npm run typecheck` — Expected: pass.
- [ ] **Step 5: Commit** `feat(assets): fixed asset register, monthly depreciation and disposal; migration 16`.

### Task 3: Screens, e2e, docs

**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/books/AssetsPage.tsx` (route `/books/assets`);
  - `AssetPage.tsx` (route `/books/assets/:id`);
  - `apps/desktop/test/assets.spec.ts`, `playwright.assets.config.ts`, and an `e2e:assets` script.
- Modify: `App.tsx`, `BooksHome.tsx` (card "Fixed assets": "Tools, equipment, vehicles; monthly depreciation"), `README.md` ("Fixed assets (Accounting Part 5)"; the accounting module is complete).
- **The register page:**
  - one row per asset: name, category, in use from, cost, depreciated, book value, monthly;
  - totals;
  - "Show disposed";
  - "New asset" opens a modal with all fields. Opening depreciation shows only when the in-use date is before the books start, with the hint "Depreciation already taken before the books started (in your opening balances)".
  - a line at the top states the policy: "Straight line, a full month from the month it goes into use".
- **The asset page:**
  - details;
  - Edit (not after disposal);
  - "Sell or write off" opens a dialog with the date, proceeds and the account they go into;
  - the schedule table (month, charge, total, Posted or Coming);
  - after a disposal: the disposal, its proceeds and the gain or loss.
- [ ] **Step 1: Write the failing e2e:**
  1. books from the first day of four months ago;
  2. by API, a supplier bill for a hydraulic lift: 12,000.00 net on account 1500 Tools and equipment, dated in month 2;
  3. on Books → Fixed assets, add it: equipment, account 1500, cost 12,000.00, in use from the bill's date, 36 months;
  4. the register shows the book value after 3 posted months: 12,000.00 − 3 × 333.33 = 11,000.01;
  5. open it: the schedule shows 3 Posted rows;
  6. sell it today for 11,500.00 into 1020 Bank. Depreciation runs through the sale month (a fourth charge, so 1,333.32 in all), and the page shows a gain of 833.32;
  7. post the opening balances by API;
  8. Books health shows every check OK, including `fixed_assets`.
- [ ] **Step 2: Run** `npm run build -w @ffgp/desktop && npm run e2e:assets` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the typecheck, the unit tests, the build and all 12 e2e suites — Expected: pass.
- [ ] **Step 5: Commit** `feat(assets): fixed asset screens`.
