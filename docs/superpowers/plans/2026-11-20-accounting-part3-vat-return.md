# Accounting Part 3: VAT Return Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The VAT201 return for each VAT period, worked out from the books, every box drilling down to its entries; marking it filed posts the settlement into VAT payable and locks the period.

**Architecture:** Figures are read from posted journal entries (the stored ledger), never from documents alone: VAT always comes from the VAT accounts, and the net amount for boxes 1 and 9 comes from the entry's own documents. Anything the app can't know (zero-rated, exempt, reverse charge, adjustments) comes from manual journal lines tagged with a VAT box. Filing happens only where the books post (as year-end closing does), records the figures as filed, posts one settlement entry dated the period end, and moves the lock date.

**Tech Stack:** As Parts 1–2: TypeScript, Zod 4, node:sqlite, Fastify, React 19, Vitest, Playwright; Excel via `apps/desktop/src/renderer/books/export.ts`.

**Spec:** `docs/superpowers/specs/2026-11-19-accounting-design.md` (Part 3 — VAT return; Decisions after the builder check §2 and §4; Constraints; Anti-goals).

**Branch:** `feature/accounting-part3-vat` from `main` (344e576). Migration 13 deploys to the cloud with 11 and 12, before any PC.

## Global Constraints
- Money in integer fils. Every entry balances; posted entries never change (corrections are reversals).
- "Output VAT equals the VAT on issued invoices less credit notes" stays a books-health check, unchanged: it reads only invoice and credit-note entries, so settlements and tagged journals don't disturb it.
- Only one place posts: filing on a linked PC answers 409 with `NOT_HERE` (`packages/server/src/books/journals.ts`).
- Who: `books.view` sees the return; `books.lock` (Owner) files it, because filing locks the books.
- All sales stay standard-rated (5%). Zero-rated, exempt, reverse charge, tourist refunds and imports come only from tagged manual journal lines.
- One emirate per garage (spec open question 2): Settings → Garage → Emirate.
- Screens stay English.

## Review Focus
1. Books that start mid-period: only entries on or after the start date count, and the page says the period is partly before the books → Task 3 test `period straddling the start counts only from the start`.
2. A credit note in a later period for an invoice in an earlier, filed period lowers box 1 of the later period, and the filed return keeps its figures → Task 4 test `later credit note lands in the open period`.
3. A bill cancelled after its period was filed: the mirror is dated today, so box 9 of the open period goes down and the filed return is untouched → Task 4 test `bill cancelled after filing`.
4. Filing twice, out of order, before the period ends, without an emirate, or on a linked PC: each refused with a plain reason → Task 4 test `filing is refused when it shouldn't happen`.
5. A bill with standard and no-VAT lines, and a goods receipt with no VAT (unregistered supplier): box 9's amount counts only the VAT-bearing net, and the VAT is exactly the input VAT posted → Task 3 test `box 9 counts only VAT-bearing net`.

---

### Task 1: Shared VAT model, emirate setting, VAT box on journal lines

**Files:**
- Create: `packages/shared/src/vat.ts` (export from `packages/shared/src/index.ts`)
- Modify: `packages/shared/src/settings.ts` (garage), `packages/shared/src/books.ts` (`journalLineSchema`)
- Test: `packages/shared/test/vat.test.ts`

**Interfaces:**
- Produces:
  - `EMIRATES = ["abu_dhabi","dubai","sharjah","ajman","umm_al_quwain","ras_al_khaimah","fujairah"] as const`, `type Emirate`, `EMIRATE_NAMES: Record<Emirate,string>`, `EMIRATE_BOX: Record<Emirate,"1a"|…|"1g">` (in that order).
  - `VAT_TAGS = ["1","1adj","2","3","4","5","6","7","9","9adj","10"] as const`, `type VatTag`; `VAT_TAG_INFO: Record<VatTag,{ side: "sales"|"expenses"; label: string; vatOnly: boolean }>` (`vatOnly` true for `1adj`, `9adj`).
  - `VAT_BOXES`: ordered `{ key: VatBoxKey; label: string }[]` for keys `1a`…`1g`, `2`…`8`, `9`, `10`, `11` with the VAT201 labels (1 Standard rated supplies in <emirate>, 2 Tax refunds provided to tourists, 3 Supplies subject to the reverse charge, 4 Zero rated supplies, 5 Exempt supplies, 6 Goods imported into the UAE, 7 Adjustments to goods imported, 8 Totals, 9 Standard rated expenses, 10 Supplies subject to the reverse charge, 11 Totals).
  - `vatPeriods(tax: { returnPeriod: "monthly"|"quarterly"; firstPeriodStart: string|null }, today: string): { from: string; to: string }[]` — newest first, from `firstPeriodStart` in steps of 1 or 3 calendar months, up to the period containing `today`; `[]` when `firstPeriodStart` is null.
  - Settings `garage.emirate: Emirate | null` (default null). `journalLineSchema` gains `vatBox: VatTag | null` (optional, default null).

- [ ] **Step 1: Write the failing tests**

```ts
it("quarterly periods from the first start, newest first", () => {
  expect(vatPeriods({ returnPeriod: "quarterly", firstPeriodStart: "2026-02-01" }, "2026-11-20")).toEqual([
    { from: "2026-11-01", to: "2027-01-31" }, { from: "2026-08-01", to: "2026-10-31" }, { from: "2026-05-01", to: "2026-07-31" }, { from: "2026-02-01", to: "2026-04-30" },
  ]);
});
it("monthly periods handle month ends and leap years", () => {
  expect(vatPeriods({ returnPeriod: "monthly", firstPeriodStart: "2028-01-01" }, "2028-03-01").map((p) => p.to)).toEqual(["2028-03-31", "2028-02-29", "2028-01-31"]);
});
it("no first period, no periods", () => expect(vatPeriods({ returnPeriod: "monthly", firstPeriodStart: null }, "2026-11-20")).toEqual([]));
it("emirates map to boxes 1a–1g", () => expect([EMIRATE_BOX.abu_dhabi, EMIRATE_BOX.dubai, EMIRATE_BOX.fujairah]).toEqual(["1a", "1b", "1g"]));
it("a journal line may carry a VAT box", () => {
  expect(journalLineSchema.parse({ accountId: "a", creditFils: 100, vatBox: "4" }).vatBox).toBe("4");
  expect(journalLineSchema.parse({ accountId: "a", creditFils: 100 }).vatBox).toBeNull();
  expect(() => journalLineSchema.parse({ accountId: "a", creditFils: 100, vatBox: "8" })).toThrow();
});
it("garage emirate setting", () => expect(settingsSchemas.garage.parse({ emirate: "sharjah" }).emirate).toBe("sharjah"));
```

- [ ] **Step 2: Run** `npx vitest run packages/shared/test/vat.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `vat.ts` and the two schema additions. A period's `to` is the day before the next period's `from`.
- [ ] **Step 4: Run** the same command — Expected: PASS. Then `npm run typecheck` — Expected: exit 0.
- [ ] **Step 5: Commit** `feat(vat): VAT periods, boxes, emirates and the VAT box on journal lines`.

### Task 2: Tagged journal lines in the ledger; migration 13

**Files:**
- Modify: `packages/server/src/migrations.ts` (migration 13), `packages/server/src/books/post.ts`, `packages/server/src/books/journals.ts`, `packages/sync/src/tables.ts`
- Test: `packages/server/test/vat-journals.test.ts`

**Interfaces:**
- Consumes: `VatTag`, `VAT_TAG_INFO` (Task 1).
- Produces:
  - Migration 13: `ALTER TABLE journal_lines ADD COLUMN vat_box TEXT`. It rebuilds `journal_entries` to add `'vat_return'` to the `source_type` CHECK, the same way migration 12 did (data, indexes, foreign keys kept; `PRAGMA foreign_key_check` before commit). It also creates `vat_returns`:
    ```sql
    CREATE TABLE vat_returns (
      id TEXT PRIMARY KEY, period_from TEXT NOT NULL UNIQUE, period_to TEXT NOT NULL,
      figures_json TEXT NOT NULL, reference TEXT, entry_id TEXT REFERENCES journal_entries(id),
      filed_by TEXT REFERENCES users(id), filed_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    ```
  - `tables.ts`: `{ name: "vat_returns", key: "id", insertOnly: true }`.
  - `PostLine.vatBox?: VatTag | null` is stored in `vat_box`. `SourceType` gains `"vat_return"`. `getEntry` lines return `vatBox`. A reversal copies each line's `vatBox`.
  - Draft lines (`draftLine` in journals.ts) carry `vatBox`.
- Rules in `checkAccounts`:
  - A line on Output VAT (2100) is allowed only with a sales-side tag. Untagged, the existing message gains: "…, or tag the line with its VAT return box".
  - A line on Input VAT (1300) with a tag must use an expense-side tag.
  - A `vatOnly` tag (`1adj`, `9adj`) is allowed only on 2100 or 1300.
  - Opening drafts ignore tags (they are dated before the books start).

- [ ] **Step 1: Write the failing tests** (`books()` set-up as in `books-journals.test.ts`)

```ts
it("a tagged journal may use Output VAT; untagged it may not", async () => {
  // Dr Bank 1050 / Cr Other income 1000 (tag "1") / Cr Output VAT 50 (tag "1"): VAT on a customer advance.
  expect((await postJournal([bankDr(105000), credit(OTHER_INCOME, 100000, "1"), credit(A.vat_output.id, 5000, "1")])).status).toBe(200);
  const r = await postJournal([bankDr(5000), credit(A.vat_output.id, 5000)]);
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/tag the line with its VAT return box/);
});
it("tags must fit the account", async () => {
  expect((await postJournal([bankDr(5000), credit(A.vat_output.id, 5000, "9")])).status).toBe(400);      // expense box on output VAT
  expect((await postJournal([debit(A.vat_input.id, 5000, "1"), bankCr(5000)])).status).toBe(400);        // sales box on input VAT
  expect((await postJournal([bankDr(5000), credit(OTHER_INCOME, 5000, "1adj")])).status).toBe(400);      // adjustment off a VAT account
});
it("tags are kept on the entry and copied to its reversal", async () => {
  const e = (await postJournal([bankDr(100000), credit(OTHER_INCOME, 100000, "4")])).body.entry;
  expect(e.lines.find((l: { vatBox: string | null }) => l.vatBox).vatBox).toBe("4");
  const rev = (await call(app, "POST", `/api/books/journals/${e.id}/reverse`, owner, {})).body.entry;
  expect(rev.lines.map((l: { vatBox: string | null }) => l.vatBox).sort()).toEqual([null, "4"]);
});
it("migration 13 keeps entries and accepts vat_return", () => { /* open a v12 db with one entry; migrate; the entry is still there; inserting source_type 'vat_return' works */ });
```

- [ ] **Step 2: Run** `npx vitest run packages/server/test/vat-journals.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** migration 13, `vat_box` through post/draft/getEntry/reversal, and the `checkAccounts` rules.
- [ ] **Step 4: Run** the test file, then `npm test` and `npm run typecheck` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(vat): VAT box tags on journal lines; migration 13`.

### Task 3: The VAT201 figures for a period

**Files:**
- Create: `packages/server/src/vat/figures.ts`
- Test: `packages/server/test/vat-figures.test.ts`

**Interfaces:**
- Consumes: `EMIRATE_BOX`, `VAT_BOXES`, `VAT_TAG_INFO` (Task 1); `vat_box` (Task 2); `customerBalance` (`packages/server/src/customers` or wherever Part 1 reads it).
- Produces:
  ```ts
  interface VatRow { entryId: string; number: string; date: string; narration: string; amountFils: number; vatFils: number; adjustmentFils: number }
  interface VatBox { key: VatBoxKey; label: string; amountFils: number; vatFils: number; adjustmentFils: number; rows: VatRow[] }
  interface VatFigures {
    from: string; to: string; emirate: Emirate | null; countedFrom: string;   // later of `from` and the books' start date
    boxes: VatBox[];                                                          // all VAT_BOXES, totals 8 and 11 included (rows: [])
    dueFils: number; recoverableFils: number; payableFils: number;           // boxes 12, 13, 14
    notInBox: VatRow[];       // entries in the period moving 2100/1300 that no box counts (untagged journals, openings)
    advances: { customerId: string; name: string; creditFils: number; vatInsideFils: number }[]; // customer credit unused at `to`
  }
  function vatFigures(db: Db, from: string, to: string): VatFigures
  ```
- Rules (entries dated `countedFrom`…`to`, excluding source `vat_return`):
  - **Box 1 (the garage's emirate row; amounts sit in `1b` etc.)**: invoice and credit-note entries. VAT is credit − debit on 2100. The amount is credit − debit on income-type accounts in the same entry. Tagged lines also count here.
  - **Box 9**:
    - goods_receipt, supplier_bill, bill_cancel and expense entries: VAT is debit − credit on 1300;
    - goods receipts: the amount is that receipt's `net_fils` when its `vat_fils` ≠ 0, otherwise 0;
    - bills: the sum of the `net_fils` of its `vat = 'standard'` lines, negated for `bill_cancel`;
    - expenses: `net_fils` when `vat = 'standard'`.
  - **Tagged lines (any entry)**:
    - on 2100 or 1300, the line adds to the box's VAT, or to its adjustment for `1adj`/`9adj` (`1adj` goes to the emirate row);
    - on any other account, it adds to the box's amount;
    - sales side = credit − debit, expenses side = debit − credit.
  - **Totals:**
    - box 8 = sum of 1a–7 and box 11 = 9 + 10, for each column;
    - `dueFils` = box 8 VAT + box 8 adjustment;
    - `recoverableFils` = box 11 VAT + box 11 adjustment;
    - `payableFils` = due − recoverable.
  - **Advances:** customers whose balance at `to` is below 0. `vatInsideFils = round(credit × 5 / 105)`.
  - A row appears once per entry per box, carrying that entry's contribution.

- [ ] **Step 1: Write the failing tests** (an invoice issued on a past date: `vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T08:00:00Z"))`, then `vi.useRealTimers()`; books start 2026-09-01; emirate `dubai`)

```ts
it("box 1 from invoices less credit notes, in the garage's emirate", async () => {
  // invoice net 1000.00 + VAT 50.00 on 15 Oct; credit note net 200.00 + VAT 10.00 on 20 Oct
  const f = await figures("2026-10-01", "2026-10-31");
  expect(box(f, "1b")).toMatchObject({ amountFils: 80000, vatFils: 4000, adjustmentFils: 0 });
  expect(box(f, "1b").rows).toHaveLength(2);
  expect(box(f, "1a")).toMatchObject({ amountFils: 0, vatFils: 0 });
  expect(f.dueFils).toBe(4000);
});
it("box 9 counts only VAT-bearing net", async () => {
  // bill: Rent net 1000 standard + Fee net 200 no VAT; goods receipt net 300 VAT 0 (unregistered supplier); expense net 100 standard
  const f = await figures("2026-10-01", "2026-10-31");
  expect(box(f, "9")).toMatchObject({ amountFils: 110000, vatFils: 5500 });
  expect(f.recoverableFils).toBe(5500);
});
it("tagged journals fill the other boxes and adjustments", async () => {
  // Dr Bank 500 / Cr Other income 500 tag "4"; Dr Bank 300 / Cr Other income 300 tag "5"; Dr Output VAT 20 tag "1adj" / Cr Bank 20
  const f = await figures("2026-10-01", "2026-10-31");
  expect(box(f, "4").amountFils).toBe(50000);
  expect(box(f, "5").amountFils).toBe(30000);
  expect(box(f, "1b").adjustmentFils).toBe(-2000);
  expect(box(f, "8")).toMatchObject({ amountFils: 80000 + 50000 + 30000, vatFils: 4000, adjustmentFils: -2000 });
});
it("period straddling the start counts only from the start", async () => {
  // books start 2026-10-10; an expense dated 2026-10-05 is before the books (refused by the lock check), one on 2026-10-12 counts
  const f = await figures("2026-10-01", "2026-12-31");
  expect(f.countedFrom).toBe("2026-10-10");
});
it("untagged VAT movements are listed, advances are listed", async () => {
  // Dr Input VAT 15 / Cr Bank 15 untagged journal; customer receipt 105.00 with no invoice
  const f = await figures("2026-10-01", "2026-10-31");
  expect(f.notInBox.map((r) => r.vatFils)).toEqual([1500]);
  expect(f.advances).toEqual([expect.objectContaining({ creditFils: 10500, vatInsideFils: 500 })]);
});
```

- [ ] **Step 2: Run** `npx vitest run packages/server/test/vat-figures.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `vatFigures` by the rules above: one query for the period's entries and lines, document lookups by `source_id`.
- [ ] **Step 4: Run** the test file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(vat): VAT201 figures from the books`.

### Task 4: Periods, filing and settlement; routes

**Files:**
- Create: `packages/server/src/vat/returns.ts`, `packages/server/src/routes/vat.ts` (registered in `app.ts` like `payablesRoutes`, with `posts`)
- Test: `packages/server/test/vat-returns.test.ts`

**Interfaces:**
- Consumes: `vatFigures` (Task 3), `vatPeriods` (Task 1), `postEntry`, `NOT_HERE`, `audit`.
- Produces:
  - `listPeriods(db, today?)` → `{ from, to, status: "open" | "due" | "filed", filedAt, reference, payableFils }[]`, newest first. A period is `due` once `to` < today and it isn't filed. Periods ending before the books' start date are left out.
  - `getReturn(db, from, to)` → `VatFigures & { filed: { figures: VatFigures; reference: string | null; filedAt: string; entryId: string | null } | null; changedSinceFiled: boolean }`. `changedSinceFiled` compares `dueFils`/`recoverableFils` with the current figures.
  - `fileReturn(db, input: { from: string; to: string; reference?: string | null }, userId: string, posts: boolean)`, in order:
    1. 409 `NOT_HERE` if `!posts`.
    2. 400 if `{from,to}` isn't one of `vatPeriods` ("That isn't a VAT period in Settings → Tax").
    3. 400 if `to` ≥ today ("A return can be filed once its period has ended").
    4. 400 if `garage.emirate` is null ("Choose the garage's emirate in Settings → Garage").
    5. 409 if already filed ("That return is already filed").
    6. 409 if an earlier period on or after the books start is not filed (`File the return for <from>–<to> first`).
  - The settlement entry:
    - dated `to`, `allowLocked: true`, `postKey: "vat_return:<from>"`, `sourceType: "vat_return"`, narration `VAT return <d Mon yyyy>–<d Mon yyyy>`;
    - lines: Dr Output VAT `dueFils` (Cr if negative), Cr Input VAT `recoverableFils` (Dr if negative), and VAT payable `payableFils` (Cr if positive, Dr if a refund);
    - zero lines are dropped, and no entry is posted when all are zero.
  - Then:
    - insert `vat_returns` with `figures_json`;
    - set `books.lockDate` to `to` when it's earlier, and audit it as `closeYear` does;
    - return `getReturn`.
  - Routes:
    - `GET /api/vat/periods` and `GET /api/vat/return?from&to` (`books.view`);
    - `POST /api/vat/returns` `{ from, to, reference }` (`books.lock`).

- [ ] **Step 1: Write the failing tests** (fake `Date` to put documents in past months; quarterly or monthly as each test says)

```ts
it("filing posts the settlement and locks the period", async () => {
  // Oct: invoice VAT 50.00, bill input VAT 20.00
  const r = await file("2026-10-01", "2026-10-31", "FTA-123");
  expect(r.status).toBe(200);
  expect(byCode(app, "vat_return:2026-10-01")).toEqual({ "2100": 5000, "1300": -2000, "2110": -3000 });
  expect(app.db.get("SELECT date FROM journal_entries WHERE post_key = 'vat_return:2026-10-01'")).toEqual({ date: "2026-10-31" });
  expect((await settings()).books.lockDate).toBe("2026-10-31");
  expect((await periods()).find((p) => p.from === "2026-10-01")).toMatchObject({ status: "filed", reference: "FTA-123", payableFils: 3000 });
  expect(await healthOf("output_vat")).toMatchObject({ ok: true });
});
it("a refund goes to VAT payable as a debit", async () => {
  // Oct: bill input VAT 80.00 only
  await file("2026-10-01", "2026-10-31");
  expect(byCode(app, "vat_return:2026-10-01")).toEqual({ "1300": -8000, "2110": 8000 });
});
it("filing is refused when it shouldn't happen", async () => {
  expect((await file("2026-10-01", "2026-10-31", null, { emirate: null })).body.error).toMatch(/emirate/);
  expect((await file("2026-11-01", "2026-11-30")).body.error).toMatch(/once its period has ended/);
  expect((await file("2026-10-01", "2026-10-30")).body.error).toMatch(/isn't a VAT period/);
  expect((await file("2026-10-01", "2026-10-31")).status).toBe(409);  // September not filed yet
  await file("2026-09-01", "2026-09-30");
  expect((await file("2026-10-01", "2026-10-31")).status).toBe(200);
  expect((await file("2026-10-01", "2026-10-31")).status).toBe(409);  // twice
  expect((await fileOnLinkedPc("2026-11-01", "2026-11-30")).status).toBe(409);
  expect((await call(app, "POST", "/api/vat/returns", accountantToken, { from: "2026-09-01", to: "2026-09-30" })).status).toBe(403);
});
it("later credit note lands in the open period", async () => {
  // Oct invoice VAT 50.00; file October; then (Nov) credit note VAT 10.00 against it
  const oct = await getReturn("2026-10-01", "2026-10-31");
  expect(oct.filed.figures.dueFils).toBe(5000);
  expect(oct.changedSinceFiled).toBe(false);
  expect((await getReturn("2026-11-01", "2026-11-30")).dueFils).toBe(-1000);
});
it("bill cancelled after filing", async () => {
  // Oct bill input VAT 20.00; file October; cancel the bill in November
  expect((await getReturn("2026-11-01", "2026-11-30")).recoverableFils).toBe(-2000);
  expect((await getReturn("2026-10-01", "2026-10-31")).filed.figures.recoverableFils).toBe(2000);
});
```

- [ ] **Step 2: Run** `npx vitest run packages/server/test/vat-returns.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `returns.ts` and the routes.
- [ ] **Step 4: Run** the test file, then `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(vat): VAT periods, filing with settlement and lock`.

### Task 5: Screens, e2e, docs

**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/books/VatReturnPage.tsx`
  - `apps/desktop/test/vat.spec.ts`
  - `playwright.vat.config.ts` (copy `playwright.payables.config.ts`)
- Modify:
  - `App.tsx`: route `/books/vat`, under `books.view`;
  - `BooksHome.tsx`: card "VAT return", blurb "VAT201 figures for each period; file and lock";
  - `JournalEditor.tsx`: a "VAT box" select per line, "—" plus `VAT_TAGS` with their labels;
  - `pages/settings/sections/GarageSection.tsx` and `describe.ts`: Emirate select;
  - root `package.json`: `e2e:vat`;
  - `README.md`: a "VAT return (Accounting Part 3)" section, and "Next" becomes Part 4 (payroll).

**The page:**
- **Period picker:** from `/api/vat/periods`, defaulting to the newest `due` period, otherwise the current one. Each period shows its status badge: Open, Due or Filed.
- **The VAT201 table:**
  - columns Box, Description, Amount, VAT, Adjustment;
  - rows 1a–11, then 12 Total tax due, 13 Recoverable tax, 14 Payable (or Refundable) tax;
  - the garage's emirate row in bold.
- **Drill-down:** clicking a box with rows shows its entries, each linking to `/books/journals/:id`.
- **Notes under the table:**
  - "Not in any box": entries listed with their VAT;
  - "Customer advances unused at <to>": customer, credit, VAT inside, with a hint to post VAT on them by tagged journal if the law requires;
  - "Counted from <countedFrom> (the books start then)" when that is later than `from`.
- **Banners:**
  - no emirate set: a banner linking to Settings → Garage;
  - no first period set: a banner linking to Settings → Tax.
- **Filing:** "Mark as filed" appears when `can("books.lock")` and the period is due. It opens a dialog with "FTA reference (optional)" and the wording "This locks the books up to <to> and posts the settlement".
- **A filed return:**
  - shows the filed figures, the reference and the date filed;
  - if `changedSinceFiled`, an amber note "The books changed after filing";
  - a "Record the payment" button opens a new manual journal (Dr VAT payable, Cr Bank, the payable amount, narration "VAT paid for <period>") in the journal editor;
  - for a refund, the text says "Refundable".
- **Export:**
  - "Excel" uses `exportXlsx`: the boxes, then the rows of each box;
  - "Print" uses the existing print export.

- [ ] **Step 1: Write the failing e2e** (`vat.spec.ts`; monthly periods; books start and first period = the first day of last month; emirate Dubai via Settings):
  - set the emirate and the monthly VAT period;
  - by API, add for last month:
    - a bill (Rent net 1,000.00 standard, dated the 10th);
    - a tagged journal (Dr Bank 500 / Cr Other income 500, box 4);
  - in the editor, add a tagged journal dated last month: Dr Output VAT 10.00 with box `1adj`, Cr Bank 10.00;
  - open the VAT return. Last month is preselected:
    - box 9 shows AED 1,000.00 and AED 50.00;
    - box 4 shows AED 500.00;
    - box 1b adjustment shows −AED 10.00;
    - box 14 reads "Refundable" and shows AED 60.00;
  - click box 9: the bill's journal is listed;
  - Mark as filed with reference "FTA-E2E": the badge shows Filed;
  - Books → Journals shows "VAT return";
  - Books health: every check shows OK.
- [ ] **Step 2: Run** `npm run build -w @ffgp/desktop && npm run e2e:vat` — Expected: FAIL (no VAT return page).
- [ ] **Step 3: Implement** the page, the editor column, the emirate field, the card, the route, the README.
- [ ] **Step 4: Run** `npm run typecheck`, `npm test`, `npm run build -w @ffgp/desktop`, and all e2e suites (`e2e`, `e2e:settings`, `e2e:credit`, `e2e:messages`, `e2e:books`, `e2e:payables`, `e2e:vat`, `e2e:electron`, `e2e:cloud`, `e2e:sync`) — Expected: all pass.
- [ ] **Step 5: Commit** `feat(vat): VAT return screen, tagged journals, emirate`.
