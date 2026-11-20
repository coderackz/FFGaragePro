# Menu, Knowledge, Message Templates, Promo Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parts A, B and C of the design:
- the menu regrouped under standard headings, with an in-app Knowledge section;
- a library of message templates, used when sending;
- promo codes with limits, applied before VAT, with a report.

**Architecture:**
- **Menu:** the navigation becomes a pure function `navGroups(can)`, so it can be tested.
- **Knowledge:** help pages are static content in the renderer.
- **Templates:** a mergeable `message_templates` table, managed in Settings and offered in the Send dialog.
- **Promo codes:**
  - A `promo_codes` table.
  - The document stores the applied code, and each line stores its `promo_fils` share.
  - `lineTotals` takes the share, so stored line nets are already discounted, and the posting rules, VAT and statements need no change.
  - A use counts when the invoice is issued.

**Tech Stack:** As before.

**Spec:** `docs/superpowers/specs/2026-11-20-integrations-polish-design.md` (Parts A, B, C).

**Branch:** `feature/integrations-and-polish` from `main`. **Migration 17.** Deploy it to the cloud before PCs.

## Global Constraints
- Money in fils. A promo never makes a line, its VAT or a document negative. A fixed AED code is capped at the matching lines' net (or gross, when prices include VAT).
- Nothing changes for documents without a promo code.
- Who can do what:
  - managing codes and templates: `settings.manage`;
  - applying a code: `documents.edit`;
  - the owner's override of an expired or used-up code at issue: `credit.override` (Owner), recorded in the audit log.
- Template texts use only the known placeholders (`unknownPlaceholders`).

## Review Focus
1. A promo on a document whose prices include VAT: what's typed less the promo is what prints and what the books post → Task 4 test `promo with prices including VAT`.
2. A fixed AED code larger than the matching lines: it's capped, and no line goes negative → Task 4 test `fixed code capped`.
3. A part credit note on a promo invoice credits the discounted amounts, not list prices → Task 5 test `credit note follows the promo`.
4. Limits:
   - draft invoices don't count;
   - the maximum uses are reached by issued invoices;
   - once per customer;
   - a code that expired between apply and issue is refused at issue (the owner can override);
   - a full credit note frees the use.

   → Task 5 test `promo limits at issue`.
5. A template with an unknown placeholder is refused, and an archived template isn't offered → Task 2 test `templates`.

---

### Task 1: Menu and Knowledge

**Files:**
- Create:
  - `apps/desktop/src/renderer/components/nav.ts`: `navGroups(can: (a: Action) => boolean): { section: string | null; items: { to: string; label: string; icon: LucideIcon; end?: boolean }[] }[]`, empty groups left out;
  - `apps/desktop/src/renderer/help/guides.ts`: `GUIDES: { slug; title; area; body: string /* simple markdown: ## headings, - lists, paragraphs */ }[]` and `searchGuides(q)`;
  - `apps/desktop/src/renderer/pages/KnowledgePage.tsx` (`/knowledge`, `/knowledge/:slug`);
  - `apps/desktop/test/nav.test.ts`.
- Modify: `Layout.tsx` (renders `navGroups`), `App.tsx` (routes).
- The groups are as in the spec. Reports holds Customer aging, Supplier aging and Promo codes; the Promo codes item is added in Task 6.
- The guides cover the twelve topics in the spec (getting started; workshop; getting paid; purchases and stock; books; VAT return; payroll and leavers; fixed assets; messages and templates; promo codes; integrations; backups and the cloud). Each guide has 6–15 lines of plain steps, written from what the app does.

- [ ] **Step 1: Write the failing tests** (`nav.test.ts`):
  - **`owner sees every group in order`:** the sections are `[null, "Operations", "Finance", "Accounts", "HR & Payroll", "Inventory", "Reports", "Knowledge", "Settings"]`, and Customers sits in Operations.
  - **`advisor sees no finance, accounts or HR`:** with only the advisor's actions, there's no "Finance", "Accounts" or "HR & Payroll", and "Operations" still has Estimates.
  - **`guides search`:** `searchGuides("gratuity")` finds the payroll guide, and `searchGuides("")` returns all twelve.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/nav.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep every current screen's permission check as it is in `Layout.tsx`.
- [ ] **Step 4: Run** it, then `npm run typecheck` and `npm run build -w @ffgp/desktop && npm run e2e`. The workshop e2e still navigates by link names. Expected: pass.
- [ ] **Step 5: Commit** `feat: menu under standard headings; Knowledge (help & guides)`.

### Task 2: Message templates (server)

**Files:**
- Modify: `packages/shared/src/messages.ts`, `packages/server/src/migrations.ts` (migration 17), `packages/sync/src/tables.ts`.
- Create: `packages/server/src/routes/templates.ts`.
- Test: `packages/server/test/templates.test.ts`.

**Interfaces:**
- **`messageTemplateSchema`:** `{ name (1–80); channel: "email" | "whatsapp" | "both"; subjectEn?; subjectAr?; textEn (1–1000); textAr (1–1000); waTemplateName?: string|null; waLanguage?: string|null; waParams?: Placeholder[] }`.
  - Refused: unknown placeholders in any text; a subject missing when the channel includes email.
- **Migration 17, part 1:** `message_templates` (id, name, channel, subject_en, subject_ar, text_en, text_ar, wa_template_name, wa_language, wa_params_json, archived_at, created_at, updated_at). It is mergeable and synced.
- **Routes:**
  - `GET /api/message-templates?channel=email|whatsapp` (any signed-in user, active only, or all with `?archived=1` for `settings.manage`);
  - `POST /api/message-templates`, `PATCH /api/message-templates/:id`, `POST /api/message-templates/:id/archive` (`settings.manage`).

- [ ] **Step 1: Write the failing test** `templates`:
  - create an email-and-WhatsApp template "Service reminder";
  - one with `{name}` → 400;
  - email without a subject → 400;
  - listing by channel `whatsapp` includes it, and by `email` includes it;
  - after archiving, it isn't listed;
  - an advisor creating one → 403.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/templates.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, then `npm test` — Expected: pass.
- [ ] **Step 5: Commit** `feat(messages): message template library`.

### Task 3: Message templates (screens)

**Files:**
- Create: `apps/desktop/src/renderer/pages/settings/sections/TemplatesSection.tsx` (a Settings tile "Message templates": list, new and edit modal with EN and AR text, placeholder chips, archive).
- Modify:
  - `messages/SendDialog.tsx`: a "Template" select above the text: "Default for this message" plus the garage's templates for the chosen channel. Choosing one fills the subject and text in the recipient's language through `fillTemplate` with the request's values;
  - `tiles.ts` and `describe.ts`;
  - `apps/desktop/test/messages.spec.ts`, which adds one step: make a template in Settings, open the Send dialog on an invoice, choose it, and the text shows it filled in with the plate.
- [ ] **Step 1: Add the e2e step.** Run `npm run build -w @ffgp/desktop && npm run e2e:messages` — Expected: FAIL at the template step.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** it — Expected: pass.
- [ ] **Step 4: Commit** `feat(messages): templates in Settings and the Send dialog`.

### Task 4: Promo maths (shared)

**Files:**
- Modify: `packages/shared/src/money.ts`.
- Create: `packages/shared/src/promo.ts`.
- Test: `packages/shared/test/promo.test.ts`.

**Interfaces:**
- **`LineAmounts` gains `promoFils?: number`:**
  - prices without VAT: net = line net − promoFils;
  - prices with VAT: gross = line gross − promoFils, then net and VAT are split as before.
- **`promoSchema`:** `{ code (A–Z 0–9 - _, 2–30, stored upper-case); description?; kind: "percent"|"amount"; value (percent 0.01–100, or fils > 0); appliesTo: "all"|"labour"|"parts"; validFrom?; validTo?; minNetFils?; maxUses?; oncePerCustomer: boolean; active: boolean }`.
- **`promoShares(lines: (LineAmounts & { kind; suppliedBy? })[], promo: { kind; value; appliesTo }, includeVat: boolean): { shares: number[]; discountFils: number; baseFils: number }`:**
  - the base = the matching lines' amount after their line discount (net, or gross when VAT is included); "parts" matches `part` lines, "labour" matches `labour` lines, and Fleet Fix-supplied lines never match;
  - the discount = round(base × value ÷ 100), or min(value, base);
  - it is spread over the matching lines in proportion, rounded per line, with the last matching line taking the remainder.
- **`promoProblem(promo, ctx: { today: string; baseFils: number; usedFils: number /* uses so far */; usedByCustomer: boolean }): string | null`:** the reason it can't be used ("Not active", "Starts on …", "Ended on …", "Needs a bill of at least …", "Used up", "Already used by this customer"), or null.

- [ ] **Step 1: Write the failing tests:**
  - **`percent on labour only`:** labour 100.00 and part 50.00, 10% labour → shares `[1000, 0]`, discount 10.00. `docTotals` with the shares gives net 140.00 and VAT 7.00.
  - **`fixed code capped`:** AED 500 on lines netting 120.00 → discount 120.00, shares summing to 12000, and every line net ≥ 0.
  - **`spread with remainder`:** 3 lines of 33.33 with 10% → the shares sum to the rounded discount exactly.
  - **`promo with prices including VAT`:** a line typed 105.00 including VAT, 10% → gross 94.50, net 90.00, VAT 4.50.
  - **`problems`:** expired, not yet started, below the minimum, used up, used by this customer.
- [ ] **Step 2: Run** `npx vitest run packages/shared/test/promo.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it and `npm run typecheck` — Expected: pass.
- [ ] **Step 5: Commit** `feat(promo): promo code maths`.

### Task 5: Promo codes on the server

**Files:**
- Modify: migration 17 (part 2), `tables.ts`, `routes/documents.ts` (`writeLines`, conversion, issue, credit notes).
- Create: `packages/server/src/promo/codes.ts`, `packages/server/src/routes/promo.ts`.
- Test: `packages/server/test/promo.test.ts`.

**Interfaces:**
- **Migration 17, part 2:**
  - `promo_codes` (all `promoSchema` fields, plus created_at and updated_at; `code` UNIQUE);
  - `documents`: `promo_code`, `promo_kind`, `promo_value`, `promo_applies`, `promo_discount_fils` (default 0), `promo_override_by`;
  - `document_lines`: `promo_fils INTEGER NOT NULL DEFAULT 0`.

  Synced (the new columns on existing synced tables are captured automatically).
- **Routes:**
  - `GET/POST /api/promo-codes`, `PATCH /api/promo-codes/:id` (`settings.manage`; GET for `documents.edit` too, active only);
  - `POST /api/documents/:id/promo { code }` and `DELETE /api/documents/:id/promo` (`documents.edit`, drafts and open job cards only). Applying stores the code's terms on the document and re-writes the lines with shares. A code that can't be used gets 400 with `promoProblem`'s reason;
  - `GET /api/reports/promo-codes` (`reports.view`): per code, uses, discount and invoices.
- **The rules:**
  - `writeLines` always re-spreads the document's stored promo over the new lines.
  - Converting an estimate to a job card or invoice carries the promo fields.
  - **Issuing an invoice with a code** re-checks `promoProblem` with uses = the number of other issued invoices with that code that aren't fully credited:
    - a problem → 409 with the reason, unless `{ promoOverride: true }` from someone with `credit.override`, which is audited (`promo.override`);
    - it is counted by being issued.
  - **A credit note line** on a promo invoice credits the line's own net and VAT in proportion (`round(line.net × qty ÷ line.qty)`), not the list price.

- [ ] **Step 1: Write the failing tests:**
  - **`apply and totals`:** an estimate with labour 100.00 and a part 50.00, `SERVICE10` (10% labour). After applying, the document's net is 140.00, VAT 7.00, gross 147.00. Removing it restores 150.00. Applying an unknown code → 400 "No such code".
  - **`promo limits at issue`:**
    - `ONCE` (max uses 1, once per customer);
    - invoice A issued: the use is counted;
    - invoice B with ONCE: applying gets 400 "Used up";
    - an accountant issuing a draft that already carries the code (applied before A was issued) → 409;
    - the owner with `promoOverride` → 200, and an audit row;
    - an expired code at issue → 409 "Ended on";
    - a full credit note on A frees a use.
  - **`credit note follows the promo`:** an invoice with 2 parts at 100.00, 10% all → the line net is 180.00. A credit note for 1 → net 90.00, VAT 4.50.
  - **`books`:** the issued promo invoice posts sales at the discounted net (Part 1's rule, unchanged), and output VAT health stays green.
  - **`report`:** `SERVICE10` shows 1 use and a discount of 10.00.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/promo.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, then `npm test` and `npm run typecheck` — Expected: pass.
- [ ] **Step 5: Commit** `feat(promo): promo codes on documents, limits at issue, credit notes, report`.

### Task 6: Promo screens, print, e2e, docs

**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/settings/sections/PromoSection.tsx` (a Settings tile "Promo codes": list and editor);
  - `apps/desktop/src/renderer/pages/PromoReportPage.tsx` (`/reports/promo-codes`, in the Reports group);
  - `apps/desktop/test/promo.spec.ts`, `playwright.promo.config.ts`, and an `e2e:promo` script.
- Modify:
  - `DocumentPage.tsx`: on a draft, a "Promo code" box with Apply; once applied, a "Promo CODE −AED x" row in the totals with a Remove;
  - `print/templates.ts`: a promo row above the totals ("Promo SERVICE10 (10% labour)" −x), and line totals print after the discount;
  - `README.md`.
- [ ] **Step 1: Write the failing e2e:**
  1. Settings → Promo codes: create `SERVICE10` (10%, labour);
  2. a new invoice with labour 100.00 and a part 50.00;
  3. apply `SERVICE10`: the totals show "Promo SERVICE10" −AED 10.00 and the total AED 147.00;
  4. issue it;
  5. Reports → Promo codes shows 1 use, AED 10.00;
  6. Books health is OK.
- [ ] **Step 2: Run** `npm run build -w @ffgp/desktop && npm run e2e:promo` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the typecheck, the unit tests, the build and all e2e suites (`e2e`, `e2e:settings`, `e2e:credit`, `e2e:messages`, `e2e:books`, `e2e:payables`, `e2e:vat`, `e2e:payroll`, `e2e:assets`, `e2e:promo`, `e2e:electron`, `e2e:cloud`, `e2e:sync`) — Expected: pass.
- [ ] **Step 5: Commit** `feat(promo): promo codes screens, printing and report`.
