# Proper Form Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every form uses the right box for what it holds: an address form, passwords that can be shown, and checked phone, email, TRN, IBAN, VIN, year, plate, odometer and Emirates ID boxes.

**Architecture:** Pure parse/format/check functions in `packages/shared`; address parts in new nullable columns beside the existing `address` text, which the server always composes from them; small field components in the desktop renderer used by every form. Phone and plate stay one text column.

**Tech Stack:** TypeScript, zod (packages/shared), Fastify + `node:sqlite` (packages/server), packages/sync, React + Tailwind (apps/desktop renderer), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-form-fields-design.md`

## Global Constraints

- Migration **27** only adds columns (no data rewritten, so nothing is sent by sync). Cloud before the PCs.
- `address` stays and always holds the printed text. A record with an `address` and no parts shows it in **Street** (line breaks shown as ", "); until a part is changed its `address` is not touched.
- An older PC on the garage network sends `address` without `addressParts`: the same text keeps the parts; a different text clears them.
- One emirate for the garage: `settings.garage.emirate` (VAT box 1). The garage table gets no emirate column.
- A value that was already there and wrong never blocks a save unless it was changed. Checks run in the forms; the server's rules stay as they are, so older PCs keep saving. *(My call.)*
- Phones are written as `+971 50 123 4567`; plates as `DXB K 48213`. A phone or plate that doesn't fit is kept exactly and shown in one plain box.
- VIN: not 17 characters (or with I, O, Q) shows a **note**, never blocks — imported Japanese vehicles have shorter chassis numbers. *(My call.)*
- All address parts are optional. Show/Hide is text, not an icon. No redesign of screens. Works at 1024–1440 px, in the PC app and the browser app, offline.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A garage whose old address already says "Dubai" and whose emirate is Dubai** — printing must not say Dubai twice. Test in Task 1.
2. **Searching "0501234567" for a customer saved as `+971 50 123 4567`** (and the reverse) — found. Test in Task 2.
3. **Two PCs change different parts of one address offline** — both parts kept and the printed address matches them. Test in Task 2.
4. **Typing or pasting a whole phone or plate into the number box** (`+971501234567`, `dxb k 48213`) — sorted into the right boxes, nothing dropped. Tests in Tasks 1 and 4.
5. **Editing an old customer with a bad TRN and an odd phone, changing only the notes** — saves, and the TRN and phone are unchanged. Test in Task 6.

---

### Task 1: Field rules and addresses (shared)

**Files:**
- Create: `packages/shared/src/fields.ts`, `packages/shared/src/address.ts` (both exported from `packages/shared/src/index.ts`)
- Modify: `packages/shared/src/schemas.ts` (`garageSchema`, `customerSchema`, `supplierSchema`, `setupSchema`)
- Test: `packages/shared/test/fields.test.ts`, `packages/shared/test/address.test.ts`

**Interfaces (produces):**
- `COUNTRIES: readonly { iso: string; name: string; dial: string }[]` — AE first, then SA, OM, QA, KW, BH, then IN, PK, BD, LK, NP, PH, EG, JO, LB, SY, YE, IQ, IR, TR, GB, US, DE, FR, IT, CN, JP, KR, ZA, KE, NG.
- `parsePhone(text: string): { iso: string; national: string } | null` — `national` is digits without the leading 0; no country code means AE. `formatPhone(p): string`. `phoneDigits(q: string): string` (digits, without leading 00, 971 or 0).
- `PLATE_EMIRATES: readonly { code: string; emirate: Emirate }[]` (AUH, DXB, SHJ, AJM, UAQ, RAK, FUJ). `parsePlate(text: string): { emirate: string; code: string; number: string } | null`, `formatPlate(p): string`.
- Checks, each `(v: string) => string | null` (null = fine; "" is always fine): `checkPhone`, `checkEmail`, `checkTrn`, `checkIban`, `checkYear`, `checkOdometer`, `checkEmiratesId`, `checkPlate`; and `vinNote(v)`.
- `changedProblem(before: string | null | undefined, now: string | null | undefined, check): string | null` — null when unchanged.
- `formatIban(v)`, `formatEmiratesId(v)`, `formatTrn(v)` (grouped for showing).
- `interface AddressParts { unit; building; street; area; poBox; country: string | null; emirate: Emirate | null }`, `addressPartsSchema`, `EMPTY_ADDRESS`, `formatAddress(p: AddressParts): string | null`, `addressPartsFrom(address: string | null, stored: AddressParts): AddressParts`, `sameAddress(a, b): boolean`.
- `garageSchema`, `customerSchema`, `supplierSchema` gain `addressParts: addressPartsSchema.optional()`; `setupSchema.garage` also `emirate: z.enum(EMIRATES).nullable().optional()`. Part lengths: street 500, others 100.

- [ ] **Step 1: Write the failing tests**

```ts
// fields.test.ts
expect(parsePhone("050 123 4567")).toEqual({ iso: "AE", national: "501234567" });
for (const t of ["+971501234567", "00971 50 123 4567", "971501234567", "501234567"]) expect(parsePhone(t)?.national).toBe("501234567");
expect(formatPhone(parsePhone("0501234567")!)).toBe("+971 50 123 4567");
expect(formatPhone(parsePhone("04 321 0000")!)).toBe("+971 4 321 0000");
expect(formatPhone(parsePhone("800 4357")!)).toBe("800 4357");
expect(parsePhone("+91 98765 43210")).toEqual({ iso: "IN", national: "9876543210" });
expect(parsePhone("050 123 4567 / 055 1112222")).toBeNull();
expect(parsePhone("Ali's office")).toBeNull();
expect(checkPhone("050 123 456")).toBe("A UAE mobile has 10 digits, like 050 123 4567");
expect(phoneDigits("0501234567")).toBe("501234567");
expect(phoneDigits("+971 50 123 4567")).toBe("501234567");
expect(parsePlate("dxb k 48213")).toEqual({ emirate: "DXB", code: "K", number: "48213" });
expect(parsePlate("Dubai AA 5")).toEqual({ emirate: "DXB", code: "AA", number: "5" });
expect(parsePlate("AUH 12 34567")).toEqual({ emirate: "AUH", code: "12", number: "34567" });
expect(parsePlate("KSA 1234 ABC")).toBeNull();
expect(formatPlate({ emirate: "SHJ", code: "3", number: "12345" })).toBe("SHJ 3 12345");
expect(checkTrn("100123456700003")).toBeNull();
expect(checkTrn("1001234567")).toBe("A UAE TRN has 15 digits (this has 10)");
expect(checkIban("AE07 0331 2345 6789 0123 456")).toBeNull();
expect(checkIban("AE08 0331 2345 6789 0123 456")).toMatch(/check digits/);
expect(vinNote("GRJ76-1234567")).toBe("A VIN usually has 17 characters (this has 13)");
expect(vinNote("JTMHV05J604012345")).toBeNull();
expect(checkYear("1890")).not.toBeNull();
expect(checkOdometer("84,250")).toBeNull();
expect(checkOdometer("12 km")).not.toBeNull();
expect(checkEmiratesId("784-1990-1234567-1")).toBeNull();
expect(checkEmiratesId("123")).toBe("An Emirates ID has 15 digits starting 784");
expect(changedProblem("123", "123", checkTrn)).toBeNull();
expect(changedProblem("123", "1234", checkTrn)).not.toBeNull();
// address.test.ts
expect(formatAddress({ ...EMPTY_ADDRESS, unit: "Warehouse 12", street: "Street 6", area: "Al Quoz Ind. 3", emirate: "dubai", poBox: "1234" }))
  .toBe("Warehouse 12\nStreet 6, Al Quoz Ind. 3\nDubai, PO Box 1234");
expect(formatAddress({ ...EMPTY_ADDRESS, street: "Al Quoz 3, Dubai", emirate: "dubai" })).toBe("Al Quoz 3, Dubai");
expect(formatAddress(EMPTY_ADDRESS)).toBeNull();
expect(addressPartsFrom("Warehouse 12\nDubai", EMPTY_ADDRESS).street).toBe("Warehouse 12, Dubai");
```

- [ ] **Step 2:** `npx vitest run packages/shared/test/fields.test.ts packages/shared/test/address.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement.** UAE numbers: mobile `5\d{8}`, landline `[234679]\d{7}`, `800\d{4,7}`, `600\d{6}`; other countries 6–14 digits. `formatAddress` lines: unit + building; street + area; emirate name + "PO Box n" + country; empty ones dropped; an emirate already named in an earlier part isn't repeated; country "United Arab Emirates" isn't printed.
- [ ] **Step 4:** Same command → PASS; `npx vitest run packages/shared` → PASS.
- [ ] **Step 5: Commit** — `feat(shared): field rules (phone, plate, TRN, IBAN, VIN, Emirates ID) and address parts`

---

### Task 2: Address parts in the server and sync; phone search

**Files:**
- Modify: `packages/server/src/migrations.ts` (27), `packages/server/src/routes/{setup,settings,customers,parts,documents,purchases}.ts`, `packages/sync/src/{apply,recompute}.ts`
- Create: `packages/server/src/address.ts`
- Test: `packages/server/test/address.test.ts`, `packages/sync/test/address.test.ts`

**Interfaces:**
- Consumes: Task 1's `AddressParts`, `formatAddress`, `addressPartsFrom`, `sameAddress`, `phoneDigits`.
- Produces: migration 27 — `addr_unit, addr_building, addr_street, addr_area, addr_po_box TEXT` on `garage`, `customers`, `suppliers`; `addr_emirate TEXT` on `customers`, `suppliers`; `addr_country TEXT` on `suppliers`.
- `resolveAddress(existing: AddressRow | null, body: { address?: string | null; addressParts?: AddressParts }): { address: string | null; parts: AddressParts }` and `recomposeAddress(db, table: "garage" | "customers" | "suppliers", id)` (does nothing without parts).
- `garageOut`, `customerOut`, `supplierOut` gain `addressParts` (the garage's `emirate` from settings).

- [ ] **Step 1: Write the failing tests** — server: `"parts are stored and the printed address is made from them"`; `"an old address shows in Street and isn't touched by a save that changes only the notes"`; `"an older screen that sends the same address keeps the parts; a different one clears them"` (PATCH body without `addressParts`); `"setup stores the emirate as the VAT emirate"` (`settings.garage.emirate === "dubai"`); `"changing the garage's emirate in Settings changes its printed address"`; `"0501234567 finds +971 50 123 4567, and +971501234567 finds 050 123 4567"` (customers list and documents list). Sync: `"two PCs change different parts: both kept, the printed address has both"` (PC P1 sets `building`, the cloud sets `area`; after `applyAtCloud` `addr_building`, `addr_area` are both set and `address` contains both).
- [ ] **Step 2:** `npx vitest run packages/server/test/address.test.ts packages/sync/test/address.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Whether a save has parts is read from the request body itself (the PATCH routes merge the stored record into it). Phone search: `replace(replace(replace(phone,' ',''),'-',''),'+','') LIKE '%' || phoneDigits(q) || '%'` when `phoneDigits(q)` has at least 4 digits, beside today's match. Sync: touched garage/customers/suppliers are recomposed in `applyAll`'s `recompute`; a settings change to the garage section recomposes the garage.
- [ ] **Step 4:** Same command → PASS; `npx vitest run packages apps/cloud` → PASS.
- [ ] **Step 5: Commit** — `feat(server): address parts beside the printed address (migration 27); phone search ignores how the number is written`

---

### Task 3: Passwords that can be shown

**Files:**
- Create: `apps/desktop/src/renderer/components/fields.tsx` (`PasswordField`)
- Modify: `components/ui.tsx` (`Field` gains `error?: string | null`), `admin/AdminApp.tsx`, `components/{CloudConnectDialog,IdleLock,OwnerApproval}.tsx`, `pages/{LoginPage,SetupPage,UsersPage}.tsx`, `pages/settings/sections/{IntegrationsSection,MessagesSection}.tsx`
- Test: `apps/desktop/test/fields.spec.ts` (new), `playwright.fields.config.ts`, `package.json` (`e2e:fields`)

**Interfaces:**
- Produces: `PasswordField(props: { label: string; hint?: string; error?: string | null; className?: string } & InputHTMLAttributes)` — `<label htmlFor>` + input + a `type="button"` reading **Show** / **Hide** with `aria-pressed`. The button sits outside the label and has no `aria-label`, so `getByLabel("Password")` finds only the input. Hides again when the form is submitted.

- [ ] **Step 1: Write the failing e2e** — `"a password can be shown and hidden"`: on setup, `getByLabel("Password", { exact: true })` has `type="password"`; click its Show → `type="text"` with the same value; Hide → `password`. `"setup says when the passwords match"`: different → "The passwords don't match" beside Confirm; same → "Passwords match". `"a new user's password is typed twice"`: different → Save refused with "The passwords don't match"; same → user added.
- [ ] **Step 2:** `npm run e2e:fields` → FAIL.
- [ ] **Step 3: Implement** — all 12 boxes use `PasswordField`; `UsersPage` gets "Confirm password" (shown on reset only once a new password is typed).
- [ ] **Step 4:** `npm run typecheck && npm run e2e:fields && npm run e2e:settings && npm run e2e:cloud` → PASS; `grep -rn 'type="password"' apps/desktop/src/renderer` → only `fields.tsx`.
- [ ] **Step 5: Commit** — `feat(forms): show or hide any password; new users' passwords typed twice`

---

### Task 4: Checked boxes

**Files:**
- Modify: `components/fields.tsx`; `pages/SetupPage.tsx`, `pages/settings/sections/GarageSection.tsx`, `components/{forms,inventoryForms,ContactsPanel}.tsx`, `pages/payroll/EmployeeForm.tsx`, `pages/DocumentPage.tsx` (driver phone, odometer)
- Test: `apps/desktop/test/fields.spec.ts`

**Interfaces:**
- Consumes: Task 1's checks and formatters.
- Produces, each with `{ label, value: string, before?: string | null, onChange: (v: string) => void, hint?, disabled?, className? }`: `PhoneField`, `EmailField`, `TrnField`, `IbanField`, `YearField`, `OdometerField`, `EmiratesIdField`, `VinField`, `PlateField` (also `defaultEmirate?: Emirate | null`). Errors show once the box is left. `useFieldChecks()` returns `firstProblem(list: [label, before, now, check][]): string | null` for the save button.
- The number box carries the field's label (`htmlFor`); the side boxes are "Country code", "Plate emirate", "Plate code".

- [ ] **Step 1: Write the failing e2e** — `"a whole phone typed in the box is sorted"`: fill "+971501234567", leave → country AE, box "50 123 4567"; saved customer phone `+971 50 123 4567`. `"a whole plate typed in the box is sorted"`: fill "dxb k 48213" → Dubai, K, 48213; saved `DXB K 48213`. `"a plate from elsewhere"`: choose Other, type "KSA 1234 ABC" → saved as typed. `"a short TRN shows its count and isn't saved"`: "A UAE TRN has 15 digits (this has 10)". `"a short VIN is only noted"`: saved. `"an odd phone is kept"`: API customer with phone "050 123 4567 / 055 1112222" opens in one plain box; saving unchanged keeps it exactly.
- [ ] **Step 2:** `npm run e2e:fields` → FAIL.
- [ ] **Step 3: Implement.** Opening a form and saving it untouched writes back exactly the stored text (a formatted value is only written after the box changes). Emirate of a new plate: the garage's.
- [ ] **Step 4:** `npm run typecheck && npm run e2e:fields && npm run e2e && npm run e2e:messages && npm run e2e:payroll && npm run e2e:settings` → PASS (the settings spec's IBAN becomes the valid `AE07 0331 2345 6789 0123 456`).
- [ ] **Step 5: Commit** — `feat(forms): phone, email, TRN, IBAN, VIN, year, plate, odometer and Emirates ID boxes that check what's typed`

---

### Task 5: Address form

**Files:**
- Modify: `components/fields.tsx` (`AddressFields`), `lib/types.ts` (`addressParts?: AddressParts` on Garage, Customer, Supplier), `pages/SetupPage.tsx`, `pages/settings/sections/GarageSection.tsx`, `components/{forms,inventoryForms}.tsx`
- Test: `apps/desktop/test/fields.spec.ts`, `apps/desktop/test/flow.ts`

**Interfaces:**
- Consumes: Task 1's `AddressParts`; Task 2's API.
- Produces: `AddressFields({ value: AddressParts, onChange: (p: AddressParts) => void, country?: boolean, emirateHint?: string })` — a fieldset "Address": Unit / shop no., Building, Street, Area, Emirate, PO Box (and Country for suppliers), laid out as in the approved sketch. `country` starts as United Arab Emirates; another country hides Emirate.

- [ ] **Step 1: Write the failing e2e** — `"setup's address prints as lines and its emirate is the VAT emirate"`; `"garage details shows one Emirate box"` (`getByLabel("Emirate")` has count 1, above Arabic); `"a customer's address is saved in parts and printed"` (API `address === "Villa 4\nStreet 12, Al Barsha 1\nDubai"`); `"a supplier abroad has a country"`.
- [ ] **Step 2:** `npm run e2e:fields` → FAIL.
- [ ] **Step 3: Implement**; `flow.ts` `setUpGarage` fills Unit "Warehouse 12", Area "Al Quoz Industrial 3", Emirate Dubai. The garage form's Emirate is the settings one (moves into the address, keeping its VAT hint). Arabic address stays one box.
- [ ] **Step 4:** `npm run typecheck && npm run e2e:fields && npm run e2e && npm run e2e:settings && npm run e2e:vat && npm run e2e:payables` → PASS.
- [ ] **Step 5: Commit** — `feat(forms): an address form on setup, garage details, customers and suppliers`

---

### Task 6: Old records, screenshots, README and help

**Files:**
- Modify: `apps/desktop/test/fields.spec.ts`, `README.md`, `apps/desktop/src/renderer/help/guides.ts`

- [ ] **Step 1: Write** `"an old customer with a bad TRN and an odd phone: changing the notes saves, and both stay"` (made through the API with TRN "123", phone "office 04", two-line address; after editing notes in the form: TRN, phone and `address` unchanged). If it passes at once, check it fails with `changedProblem` made to ignore `before`, then put that back.
- [ ] **Step 2:** Screenshots of setup, garage details, customer, supplier, vehicle and user forms at 1440 and 1024 px (`fields-*.png`); look at each and fix anything that wraps or overlaps.
- [ ] **Step 3:** README: one "Form fields (2026-11-24)" paragraph ending "Migration 27: update the cloud before PCs."; the garage-details help guide says where the address and emirate are.
- [ ] **Step 4:** `npm run typecheck && npx vitest run`, then every e2e suite → all PASS.
- [ ] **Step 5: Commit** — `test(e2e): form fields on old records; README and help`
