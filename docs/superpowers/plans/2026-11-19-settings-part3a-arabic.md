# Settings Part 3a — English + Arabic documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can be set to "English + Arabic", and their estimates, job cards, invoices, credit notes, receipts and statements then print with both languages side by side, the garage's Arabic name, address, terms and warranty, Arabic part names, and the total in words in English and Arabic.

**Architecture:** Arabic fields are added to customers, parts (migration 9) and to the garage and documents settings sections (no migration needed). A document copies its customer's language when it's created. The existing HTML templates in `apps/desktop/src/renderer/print/templates.ts` get a bilingual mode driven by that language, with the Noto Naskh Arabic font embedded as a data URL so printing, PDF and the live preview all render the same way. Amount in words lives in `packages/shared`.

**Tech Stack:** TypeScript, Zod 4, node:sqlite migrations, Fastify, React 19, Vitest, Playwright; new dependency `@fontsource/noto-naskh-arabic@5.3.0` (OFL-1.1).

**Spec:** `docs/superpowers/specs/2026-11-19-settings-design.md` (sections C, the migration list, Rollout 3). Part 3 is split: **3a Arabic documents (this plan)**, **3b messages** (contacts, WhatsApp, email, outbox) planned separately.

## Global Constraints
- Screens stay English; only printed documents are bilingual (spec C, Non-goals "Arabic screens").
- Numbers stay Western digits (0–9) everywhere, Arabic text included.
- Font: Noto Naskh Arabic (OFL), bundled — no network font loading.
- Never edit migrations 1–8; this plan adds migration 9 only.
- An issued invoice or credit note is never changed — its language included.
- `language` values are exactly `"en"` and `"en_ar"`; default `"en"`.
- Lines typed by hand print as typed (no translation).
- English-only documents look as today except the new English "amount in words" line on invoices, credit notes and receipts.

## Review Focus
1. A customer switched to English + Arabic after an invoice was issued: reprint stays English (language copied at creation). → Task 2 test `document keeps its language when the customer changes`.
2. Arabic text with `<`/`&`/quotes in an Arabic name or address must be escaped like English. → Task 3 test `escapes Arabic fields`.
3. Bilingual mode with Arabic fields left blank must not print empty Arabic boxes or "undefined". → Task 3 test `bilingual with no Arabic garage name prints the English name only`.
4. Amount in words for amounts with fils only, exact thousands and duals (2,000; 200) — the commonly wrong Arabic cases. → Task 1 tests.
5. An old PC (before this version) syncing with the updated cloud: new columns must not break apply. Columns sync automatically (`syncedColumns` reads `PRAGMA table_info`); cloud is updated first as with migration 8. → Task 2 test `sync carries language and Arabic names`.

---

### Task 1: Shared — amount in words, Arabic settings and schema fields

**Files:**
- Create: `packages/shared/src/words.ts`, `packages/shared/test/words.test.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/settings.ts`, `packages/shared/src/schemas.ts`, `packages/shared/test/settings.test.ts`
- Modify: `docs/superpowers/specs/2026-11-19-settings-design.md` — append "## Part 3a decisions (2026-11-19)" listing the *My call* items marked below.

**Interfaces:**
- Produces: `amountInWords(fils: number, lang: "en" | "ar"): string`; `DOC_LANGUAGES = ["en", "en_ar"] as const`, `type DocLanguage`; settings `garage.nameAr`, `garage.addressAr` (optText 120 / 500), `documents.termsAr` (optText 1000), `documents.warrantyAr` (optText 300); `customerSchema` + `nameAr: optionalText(200)`, `addressAr: optionalText(500)`, `docLanguage: z.enum(DOC_LANGUAGES).default("en")`; `partSchema` + `nameAr: optionalText(200)`; `documentUpdateSchema` + `language: z.enum(DOC_LANGUAGES).optional()`.

- [ ] **Step 1: Write the failing tests** — `words.test.ts`:

```ts
const cases: [number, string, string][] = [
  [0, "Zero dirhams only", "فقط صفر درهم لا غير"],
  [1, "One fils only", "فقط فلس واحد لا غير"],
  [50, "Fifty fils only", "فقط خمسون فلساً لا غير"],
  [100, "One dirham only", "فقط درهم واحد لا غير"],
  [200, "Two dirhams only", "فقط درهمان لا غير"],
  [300, "Three dirhams only", "فقط ثلاثة دراهم لا غير"],
  [1100, "Eleven dirhams only", "فقط أحد عشر درهماً لا غير"],
  [10000, "One hundred dirhams only", "فقط مائة درهم لا غير"],
  [20000, "Two hundred dirhams only", "فقط مائتا درهم لا غير"],
  [123450, "One thousand two hundred thirty-four dirhams and fifty fils only", "فقط ألف ومائتان وأربعة وثلاثون درهماً وخمسون فلساً لا غير"],
  [200000, "Two thousand dirhams only", "فقط ألفا درهم لا غير"],
  [525000, "Five thousand two hundred fifty dirhams only", "فقط خمسة آلاف ومائتان وخمسون درهماً لا غير"],
  [1200000, "Twelve thousand dirhams only", "فقط اثنا عشر ألف درهم لا غير"],
  [100000025, "One million dirhams and twenty-five fils only", "فقط مليون درهم وخمسة وعشرون فلساً لا غير"],
];
it.each(cases)("%i fils", (fils, en, ar) => {
  expect(amountInWords(fils, "en")).toBe(en);
  expect(amountInWords(fils, "ar")).toBe(ar);
});
it("negative amounts use the absolute value", () => expect(amountInWords(-100, "en")).toBe("One dirham only"));
```

Settings test: `DEFAULT_SETTINGS.garage.nameAr === null`, `documents.termsAr === null`; `customerSchema.parse({ name: "A" }).docLanguage === "en"`; `customerSchema.safeParse({ name: "A", docLanguage: "ar" }).success === false`.

- [ ] **Step 2: Run** `npx vitest run packages/shared` — Expected: FAIL (`amountInWords` not exported, fields missing).

- [ ] **Step 3: Implement.** English: standard words, tens hyphenated ("twenty-five"), no "and" inside a number, first letter capitalised, "dirham" when exactly 1 else "dirhams", "fils" always; parts joined by " and "; dirhams part omitted when 0 and fils > 0; suffix " only". Arabic (dirham and fils are masculine nouns):
  - Groups of three (millions, thousands, units), joined with " و". Units 1–10: واحد اثنان ثلاثة أربعة خمسة ستة سبعة ثمانية تسعة عشرة; 11 أحد عشر, 12 اثنا عشر, 13–19 "<unit> عشر"; tens عشرون ثلاثون أربعون خمسون ستون سبعون ثمانون تسعون, "<unit> و<tens>" for 21–99; hundreds مائة مائتان ثلاثمائة أربعمائة خمسمائة ستمائة سبعمائة ثمانمائة تسعمائة.
  - Scale (ألف / مليون) by its count c: 1 → "ألف"; 2 → "ألفان"; 3–10 → "<c> آلاف" / "<c> ملايين"; 11–99 → "<c> ألفاً"/"<c> مليوناً", but "ألف"/"مليون" when it is the last group; 100+ → "<c> ألف"/"<c> مليون".
  - Counted noun by n (the whole dirham or fils amount): n = 1 → "درهم واحد"; n = 2 → "درهمان"; otherwise words + noun where n % 100 in 3–10 → "دراهم", in 11–99 → "درهماً", else "درهم". Fils: فلس واحد / فلسان / فلوس / فلساً / فلس.
  - A dual that is the last word before the noun drops its final ن: مائتان → مائتا, ألفان → ألفا, مليونان → مليونا.
  - Join dirham and fils parts with " و"; dirham part omitted when 0 and fils > 0; zero total → "صفر درهم"; wrap as "فقط … لا غير".

- [ ] **Step 4: Run** `npx vitest run packages/shared` — Expected: PASS. Then `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Commit** — `git commit -m "shared: amount in words (English, Arabic), Arabic settings and customer/part fields"`

---

### Task 2: Server — migration 9, Arabic fields in and out, document language

**Files:**
- Modify: `packages/server/src/migrations.ts` (append id 9), `packages/server/src/routes/customers.ts`, `packages/server/src/routes/parts.ts`, `packages/server/src/routes/documents.ts`, `packages/server/src/routes/receipts.ts`
- Create: `packages/server/test/arabic.test.ts`
- Modify: `apps/desktop/src/renderer/lib/types.ts` (Customer `nameAr`, `addressAr`, `docLanguage`; Part `nameAr`; DocumentFull `language`; DocLine `partNameAr`; Receipt `customerLanguage`, `customerNameAr`)

**Interfaces:**
- Consumes: Task 1 schemas.
- Produces: columns `customers.name_ar`, `customers.address_ar`, `customers.doc_language TEXT NOT NULL DEFAULT 'en' CHECK (doc_language IN ('en','en_ar'))`, `parts.name_ar`, `documents.language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','en_ar'))` (plain `ALTER TABLE … ADD COLUMN`, no rebuild). API: customers out `nameAr, addressAr, docLanguage`; parts out `nameAr`; `full()` → `language`, `customer.{nameAr,addressAr,docLanguage}`, each line `partNameAr` (joined live from `parts.name_ar`, like `partNo`); `receiptOut` → `customerLanguage`, `customerNameAr`.

Rules (*My call*, into the spec's Part 3a decisions): a new estimate, job card or invoice — including one converted from another document — takes the customer's language at that moment; a credit note takes its invoice's language; an editable document's language can be changed (`PATCH` with `language`); a frozen document's cannot (the existing editable check refuses it). Receipts and statements are not stored documents, so they print in the customer's current language. Arabic part names print live from the part, like part numbers.

- [ ] **Step 1: Write the failing tests** (`arabic.test.ts`, using `makeApp`/`setUp`/`call` from `./helpers`):
  - `migration 9 adds the columns with English defaults` — existing customer row reads `docLanguage: "en"`.
  - `customer Arabic fields round-trip` — POST customer with `nameAr: "محمد المري"`, `addressAr`, `docLanguage: "en_ar"`; GET returns them.
  - `new document takes the customer's language` — invoice for an `en_ar` customer → `language: "en_ar"`.
  - `document keeps its language when the customer changes` — issue the invoice, PATCH customer to `en`, GET invoice → still `"en_ar"`.
  - `credit note takes its invoice's language`.
  - `language can change while editable, not once issued` — PATCH draft `{ language: "en" }` → 200; after issue → 4xx (same status the editable check returns today).
  - `lines carry the part's Arabic name` — part with `nameAr: "فلتر زيت"`, invoice line with that `partId` → `lines[0].partNameAr === "فلتر زيت"`.
  - `sync carries language and Arabic names` — in `packages/sync/test/apply.test.ts`: a change row for `customers` with `doc_language: "en_ar"` and `name_ar` applies on a fresh migrated db.

- [ ] **Step 2: Run** `npx vitest run packages/server/test/arabic.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** migration 9 and the route changes per Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: all pass (the existing migration/sync tests included). `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git commit -m "server: migration 9 (Arabic names, document language); documents copy the customer's language"`

---

### Task 3: Printing — bilingual templates, Arabic font, amount in words

**Files:**
- Create: `apps/desktop/src/renderer/print/arabic.ts` (font CSS + label dictionary)
- Modify: `apps/desktop/src/renderer/print/templates.ts`, `apps/desktop/src/renderer/print/print.ts` (pass the language through), `apps/desktop/src/renderer/print/sample.ts` (sample customer gets `nameAr: "محمد المري"`, `addressAr: "البرشاء 1، دبي"`; sample part line `partNameAr: "فلتر زيت"`)
- Modify: `apps/desktop/package.json` (dependency `@fontsource/noto-naskh-arabic`), `apps/desktop/test/templates.test.ts`

**Interfaces:**
- Consumes: Task 1 `amountInWords`; Task 2 fields.
- Produces: `ARABIC_FONT_CSS: string` (two `@font-face` rules, weights 400 and 700, `font-family: "Noto Naskh Arabic"`, `src: url(<data URL>)` from `@fontsource/noto-naskh-arabic/files/noto-naskh-arabic-arabic-{400,700}-normal.woff2?inline`); `L(key, lang)` returning `"English"` for `en` and `"English / عربي"`-style pairs for `en_ar`; `renderDocumentHtml(doc, garage, settings, opts)` reads `doc.language`; `renderReceiptHtml(r, …)` reads `r.customerLanguage`; `renderStatementHtml(s, customer, …)` reads `customer.docLanguage` (customer param type gains `nameAr`, `addressAr`, `docLanguage`).

Bilingual layout (`en_ar`):
- Every label shows English then Arabic: `Bill to / فاتورة إلى`, `Customer / العميل`, `Vehicle / المركبة`, `Description / الوصف`, `Qty / الكمية`, `Unit price / سعر الوحدة`, `Disc. / الخصم`, `Amount / المبلغ`, `VAT / الضريبة`, `Total / المجموع`, `Subtotal (excl. VAT) / المجموع قبل الضريبة`, `Total (AED, incl. VAT) / الإجمالي شامل الضريبة`, `Total credit / إجمالي الإشعار`, `Credited / المبلغ المعاد`, `Paid / المدفوع`, `Balance due / الرصيد المستحق`, `Date / التاريخ`, `Due / تاريخ الاستحقاق`, `LPO / أمر الشراء`, `Odometer / عداد المسافات`, `TRN / الرقم الضريبي`, `Notes / ملاحظات`, `Reason / السبب`, `Warranty / الضمان`, `Received by (customer) / استلمه (العميل)`, `Customer approval / موافقة العميل`, `Service advisor / مستشار الخدمة`, `Technician / الفني`, `Work / part / العمل / القطعة`, `Type / النوع`, `Done / تم`, `I authorise the work above / أوافق على الأعمال المذكورة أعلاه`, `Received from / استلمنا من`, `Paid to / دفع إلى`, `Allocated to / مخصص لـ`, `Number / الرقم`, `Details / البيان`, `Debit / مدين`, `Credit / دائن`, `Balance / الرصيد`, `Balance brought forward / رصيد سابق`, `Balance carried forward / رصيد لاحق`, `Total due / إجمالي المستحق`, `Amount in words / المبلغ كتابةً`, aging `Current / جاري`, `1–30 days / 1–30 يوماً`, `31–60 days / 31–60 يوماً`, `61–90 days / 61–90 يوماً`, `Over 90 days / أكثر من 90 يوماً`.
- Header: under the English garage block, the Arabic name and address (`dir="rtl"`, right-aligned) when set. Customer box: Arabic name/address under the English when set.
- Part lines: `partNameAr` on its own `dir="rtl"` line under the English description.
- Footer: Arabic terms under English terms, Arabic warranty under English warranty, when set.
- Amount in words box above the terms on invoices, credit notes and receipts: English always; Arabic line too when bilingual (`dir="rtl"`).
- `<html lang="en">` stays; Arabic fragments are `<span dir="rtl" lang="ar">`; the font family list puts `"Noto Naskh Arabic"` after the Latin fonts, and `ARABIC_FONT_CSS` is included only in bilingual pages.
- English (`en`): today's output plus the English amount in words line; no font CSS.

- [ ] **Step 1: Write the failing tests** (`templates.test.ts`):
  - `bilingual invoice shows both labels and the Arabic garage name` — settings with `garage.nameAr: "العناية بالسيارات"`, doc `language: "en_ar"` → html contains `"Total (AED, incl. VAT) / الإجمالي شامل الضريبة"`, `"العناية بالسيارات"`, `"Noto Naskh Arabic"`, `amountInWords(doc.totals.grossFils, "ar")`.
  - `English invoice has no Arabic font and shows English words` — `language: "en"` → contains `amountInWords(gross, "en")`, not `"@font-face"`, not `"المبلغ كتابةً"`.
  - `bilingual with no Arabic garage name prints the English name only` — no `"undefined"`, no `"null"`, no empty `<div dir="rtl"></div>`.
  - `escapes Arabic fields` — customer `nameAr: "<b>&"` → `"&lt;b&gt;&amp;"`.
  - `part line shows the Arabic part name` — `partNameAr: "فلتر زيت"` present; a hand-typed line without one prints only its English text.
  - `bilingual receipt and statement` — receipt with `customerLanguage: "en_ar"` contains `"Received from / استلمنا من"`; statement with `docLanguage: "en_ar"` contains `"Balance brought forward / رصيد سابق"` and `termsAr` isn't required.
  - `Arabic terms and warranty print under the English ones`.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/templates.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; `npm i @fontsource/noto-naskh-arabic@5.3.0 -w @ffgp/desktop`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS, clean.
- [ ] **Step 5: Commit** — `git commit -m "printing: English + Arabic documents, receipts and statements; amount in words; bundled Noto Naskh Arabic"`

---

### Task 4: Screens and end-to-end

**Files:**
- Modify: `apps/desktop/src/renderer/pages/settings/sections/GarageSection.tsx` (Arabic name, Arabic address — `dir="rtl"` inputs; saved in the `garage` settings section), `DocumentsSection.tsx` (Arabic terms, Arabic warranty; preview toggle "English | English + Arabic" switching the sample's language), `apps/desktop/src/renderer/components/forms.tsx` (customer: Arabic name, Arabic address, Document language select "English" / "English + Arabic"), `apps/desktop/src/renderer/components/inventoryForms.tsx` (part: Arabic name), `apps/desktop/src/renderer/pages/DocumentPage.tsx` (editable doc: Document language select; frozen doc: shows "English + Arabic" badge when bilingual), `apps/desktop/src/renderer/pages/CustomerPage.tsx` (statement print passes the Arabic fields and language)
- Modify: `apps/desktop/test/settings.spec.ts` (or `credit.spec.ts`, whichever already has a customer+invoice flow), `README.md` (short "English + Arabic documents" section)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing e2e** — `bilingual invoice renders Arabic`: set Garage → Arabic name `العناية بالسيارات`; create a customer with Document language "English + Arabic"; make and issue an invoice; open Settings → Documents & printing, switch the preview to "English + Arabic" and assert the preview frame contains `الإجمالي شامل الضريبة` and `العناية بالسيارات`, and that inside the frame `document.fonts.check('16px "Noto Naskh Arabic"')` is true after `document.fonts.ready`. Then on the invoice page the language badge reads "English + Arabic".
- [ ] **Step 2: Run** the spec's suite (`npm run e2e:settings` or `npm run e2e:credit`) — Expected: FAIL on the missing fields.
- [ ] **Step 3: Implement** the screens.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run e2e`, `npm run e2e:settings`, `npm run e2e:credit` — Expected: all green.
- [ ] **Step 5: Commit** — `git commit -m "screens: Arabic garage, customer and part fields; document language; bilingual preview; e2e"`
