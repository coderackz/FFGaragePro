# Settings Part 3b — Messages (WhatsApp and email) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff send estimates, invoices, receipts, statements and "vehicle received / ready" messages to the right customer contact by WhatsApp (click to send) or email (from the garage's own mailbox), with automatic emails, retries, reminders and a message log.

**Architecture:** Contacts, a job card driver, a `messages` outbox and `message_files` attachments are added by migration 10 and sync like other tables. The PC or browser where a message starts renders the PDF (Electron `printToPDF`; in the browser, `html-to-image` + `pdf-lib`) and posts the message with its attachment. Exactly one place sends email over SMTP (nodemailer): the **cloud** when the garage is linked, otherwise the garage's own server (main computer or standalone PC). WhatsApp opens `wa.me` with the text typed in and the PDF saved, ready to drag in. The send is logged as `opened`.

**Tech Stack:** TypeScript, Zod 4, node:sqlite, Fastify, React 19, Vitest, Playwright. New dependencies: `nodemailer@6.9.16` (server), `html-to-image@1.11.11` and `pdf-lib@1.17.1` (renderer, loaded only in the browser app), `smtp-server@3.13.6` (dev, test mail sink).

**Spec:** `docs/superpowers/specs/2026-11-19-settings-design.md`: section F, "How it works" (`customer_contacts`, `messages`, secrets, permissions, Cloud), Tests, and "Part 3 decisions". Part 3a is merged.

## Global Constraints
- Emails go **from the garage's own SMTP mailbox**. There is no Fleetfix mail (user, Part 3 decisions).
- PDFs are made where the message starts and travel with it; the cloud never renders (user).
- Exactly one sender: the cloud if the garage is linked, otherwise the garage's server. A cloud-linked PC never sends email itself; client PCs have no server.
- Retry: 1, 5 and 30 minutes, then `failed`, which shows on the dashboard.
- `secret.smtp.password` is stored and synced but **never returned by any API, log or audit entry**. Screens show "set / not set" and a Replace button.
- Placeholders: exactly `{customer}`, `{contact}`, `{plate}`, `{vehicle}`, `{doc_number}`, `{amount}`, `{balance}`, `{due_date}`, `{garage}`, `{garage_phone}`. An unknown placeholder is refused when the template is saved.
- Automatic WhatsApp becomes "ask": nothing goes out on WhatsApp without a person pressing Send.
- Never edit migrations 1–9. This plan adds migration 10 only. Update the cloud before the PCs.
- Screens stay English. Message texts exist in English and Arabic, and the contact's language picks the text.

## My calls (append to the spec as "## Part 3b decisions" in Task 1)
1. **Triggers run where the action happens** (the PC or browser that issues the invoice or records the payment), because that is where the PDF can be made. An automatic event with an email recipient is queued silently. "Ask" opens the Send dialog straight away.
2. **Monthly statements are always "ask".** From the 1st of each month, the dashboard shows "Statements to send (N)". Staff send them from there, and the PDFs are made on that PC. *(Cost if wrong: statements aren't fully automatic.)*
3. **Payment due and overdue reminders are email only and automatic, off by default.** They have no attachment, so the sender place queues them in a daily job. Each invoice gets each reminder at most once.
4. **Who gets messages:**
   - Approvals go to contacts marked "approvals"; invoices, receipts and reminders to "invoices"; statements to "statements".
   - "Vehicle received" and "vehicle ready" go to the job card's driver if one is named, otherwise to contacts marked "vehicle ready".
   - An individual customer's own phone and email count as one contact that gets everything.
   - A company's own phone and email are used only when no contact has that tick. It is the company's office, never a driver.
5. **Message language:** contacts carry `language` (`en`/`ar`). The customer's own pseudo-contact uses the new `customers.message_language` (default `en`).
6. **Browser PDFs are images.** The page is drawn with `html-to-image` at 2× and cut into A4 pages with `pdf-lib`. Text isn't selectable, and a line may be cut at a page break. *(Cost if wrong: long invoices sent from the browser app look slightly worse than those from a PC.)*
7. **"Send test email" queues a real message** (event `test`) and the screen follows its status. It therefore tests the real sender, including the cloud's connection to the mail server.
8. **Event triggers:**
   - "Estimate ready" fires from the Send menu on an estimate.
   - If an estimate message was already sent for that estimate, the event becomes "Extra work needs approval".
   - "Vehicle received" fires when a job card is created; "Vehicle ready" when its status becomes `completed`.
9. **Duplicates:** automatic messages carry `dedupe_key = event:documentId:recipient`, which is unique. Queuing the same key twice returns the first message.

## Review Focus
1. **Two senders:** a PC linked while messages are queued must not send them as well, so it stops sending as soon as it's linked. → Task 4 test `linked PC never sends; cloud sends a pushed message once`.
2. **SMTP password leaks:** the password must not appear in GET `/api/settings`, the overview, the audit log or an error message. → Task 2 test `smtp password is write-only`.
3. **Malformed phone numbers:** a UAE number typed as `050 123 4567`, `+971501234567` or `00971 50…` must become `971501234567`; a landline or rubbish is refused before WhatsApp opens. → Task 5 test `uaePhone normalises`.
4. **Retries stop:** an SMTP server that keeps refusing must not retry forever, and an unset mailbox must not retry at all. → Task 3 tests `retries 1/5/30 then failed`, `no mailbox fails at once`.
5. **Wrong recipient:** a fleet's driver must never get the invoice, and the accounts contact must never get "vehicle ready" when a driver is named. → Task 1 test `recipientsFor routes by role`.

---

### Task 1: Shared rules and the database: contacts, driver, messages

**Files:**
- Create: `packages/shared/src/messages.ts`, `packages/shared/test/messages.test.ts`, `packages/server/src/routes/contacts.ts`, `packages/server/test/messages-data.test.ts`
- Modify:
  - `packages/shared/src/{index,schemas,rules}.ts`
  - `packages/server/src/{migrations,app}.ts`
  - `packages/server/src/routes/{customers,documents}.ts`
  - `packages/sync/src/tables.ts`, `packages/sync/test/apply.test.ts`
  - the spec (append the decisions above)

**Interfaces:**
- **Produces, in shared:**
  - `MESSAGE_EVENTS = ["vehicle_received","estimate_ready","estimate_resent","vehicle_ready","invoice_issued","payment_received","payment_due","payment_overdue","statement"] as const` and `type MessageEvent`; `MESSAGE_CHANNELS = ["email","whatsapp"]`.
  - `PLACEHOLDERS` (the 10 names) and `unknownPlaceholders(text: string): string[]`.
  - `fillTemplate(text: string, values: Partial<Record<Placeholder,string>>): string`: a missing value becomes "".
  - `type Recipient = { contactId: string|null; name: string; phone: string|null; email: string|null; language: "en"|"ar" }`.
  - `recipientsFor(event: MessageEvent, customer: {kind, name, phone, email, messageLanguage}, contacts: Contact[], driver?: {name, phone}|null): Recipient[]`.
  - `contactSchema` (name 1–120, phone, email, language, getsApprovals, getsInvoices, getsReady, getsStatements, marketingConsent: boolean).
  - Customer schema: `+ messageLanguage: z.enum(["en","ar"]).default("en")`. Document update schema: `+ driverName`, `driverPhone` (optional text).
  - Rules: action `"messages.send"` for every role.
- **Produces, in migration 10:**
  - `customer_contacts` with the spec's columns: `marketing_consent_at` is the date the box was ticked; ON DELETE CASCADE.
  - `customers.message_language` (NOT NULL DEFAULT 'en', CHECK in en/ar); `documents.driver_name`, `documents.driver_phone`.
  - `messages`: id, customer_id, contact_id, document_id, receipt_id, event, channel, recipient, subject, body, status CHECK(queued|sent|failed|opened), attempts INTEGER DEFAULT 0, next_attempt_at, error, sender_place, dedupe_key UNIQUE, created_by, created_at, sent_at, updated_at.
  - `message_files`: id, message_id, file_name, data_base64, created_at.
  - Sync tables, after `receipt_allocations`: `customer_contacts` (key id), `messages` (key id), `message_files` (key id, insertOnly).
- **Produces, routes:** `GET/POST /api/customers/:id/contacts` and `PATCH/DELETE /api/contacts/:id` (needs `customers.edit`). The customer and document outputs gain `messageLanguage`, `driverName` and `driverPhone`.

- [ ] **Step 1: Write the failing tests**
  - `packages/shared/test/messages.test.ts`:
    - `unknownPlaceholders("Hi {customer}, {total}")` → `["total"]`.
    - `fillTemplate("{doc_number} for {plate}", {doc_number:"INV-00001"})` → `"INV-00001 for "`.
    - **recipientsFor routes by role** (fleet company with an "accounts" contact (invoices) and a "driver" contact (ready), and job card driver "Ali" 0501234567):
      - `invoice_issued` → only accounts.
      - `vehicle_ready` → only Ali.
      - `vehicle_ready` with no driver → only the "ready" contact.
      - A company with no invoices contact → its own email.
      - An individual → their own details for every event, in `messageLanguage`.
  - `packages/server/test/messages-data.test.ts`:
    - **migration 10 keeps old rows**: a migrateTo 9 database with a customer opens with `message_language = 'en'`. Close both Db handles before the test ends (Windows).
    - **contacts round-trip**: create, list, patch; ticking `marketingConsent` stores today's date, and unticking clears it.
    - **driver fields on a job card**: PATCH `driverName`/`driverPhone`, then GET returns them.
    - An advisor can create contacts.
  - `packages/sync/test/apply.test.ts`: **sync carries contacts and messages** (a contact plus a message with a file arrive on the other side).
- [ ] **Step 2: Run them:** `npx vitest run packages/shared/test/messages.test.ts packages/server/test/messages-data.test.ts packages/sync/test/apply.test.ts`. Expected: FAIL (module missing / no such table).
- [ ] **Step 3: Implement** the shared module, migration 10, the sync table entries and the routes above.
- [ ] **Step 4: Run the same command.** Expected: PASS. Then run `npm test`: all pass.
- [ ] **Step 5: Commit** `feat(messages): contacts, job card driver, messages tables and recipient rules`.

### Task 2: Messages settings, templates and the write-only SMTP password

**Files:**
- Modify: `packages/shared/src/settings.ts`, `packages/server/src/settings.ts`, `packages/server/src/routes/settings.ts`, `packages/shared/test/settings.test.ts`, `packages/server/test/settings.test.ts`
- Create: `packages/shared/src/message-texts.ts` (default English and Arabic texts)

**Interfaces:**
- **Produces the `messages` settings section** (added to `SETTINGS_SECTIONS`):
  - Mail server: `smtpHost` optText(200); `smtpPort` int 1–65535, default 587; `smtpSecurity` enum `starttls|ssl|none`, default `starttls`; `smtpUser` optText(200); `fromName` optText(120); `fromAddress` (email or null).
  - Reminders: `dueSoonDays` int 1–60, default 3; `overdueDays` int 1–120, default 7.
  - One field per event, each of `eventSchema = { on: boolean; mode: "auto"|"ask"; channel: "email"|"whatsapp"|"both"; subjectEn; subjectAr; textEn; textAr }`, with text up to 1000 characters and subject up to 200.
  - `eventSchema` refuses unknown placeholders: "Unknown placeholder {x}. Use one of: {customer}, …".
- **Event defaults:**
  - Every event is on, "ask", channel "both".
  - `payment_due`/`payment_overdue`: off, "auto", channel "email". The schema forces them to email.
  - `statement`: "ask". The schema refuses "auto".
- **Produces the password helpers:** `getSecret(db, "smtp.password"): string|null` and `setSecret(db, userId, "smtp.password", value|null)`. They read and write the settings row `secret.smtp.password`.
  - The audit entry is `{ after: { smtpPassword: "(changed)" } }` or `"(removed)"`.
  - Route: `PUT /api/settings/messages/password` `{ password: string|null }` (needs `settings.manage`).
- **Produces in `GET /api/settings/overview`:** `messages: { emailReady: boolean }` (host, from address and password all set) and `failedMessages: number`.

- [ ] **Step 1: Write the failing tests:**
  - **Defaults:** shared `messages defaults and placeholder check`. The defaults parse; `textEn: "Hi {name}"` is refused with a message naming `{name}`; `statement.mode = "auto"` is refused.
  - **smtp password is write-only** (server):
    1. PUT the password `s3cret!`.
    2. Then `JSON.stringify` of GET `/api/settings`, GET `/api/settings/overview` and GET `/api/audit` does not contain `s3cret!`.
    3. The overview's `emailReady` flips to true once the host and from address are also saved.
    4. An advisor gets 403.
- [ ] **Step 2: Run** `npx vitest run packages/shared/test/settings.test.ts packages/server/test/settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the section, the default texts (EN + AR, every one using only known placeholders), the secret helpers and the route.
  - `secret.` rows are never read by `readSettings`: no change is needed there, but check that the GET route never lists raw rows.
- [ ] **Step 4: Run the same command, then `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(messages): Messages settings, EN/AR templates, write-only SMTP password`.

### Task 3: The outbox: queue, send by SMTP, retry, reminders

**Files:**
- Create: `packages/server/src/messages/{outbox,mailer,reminders}.ts`, `packages/server/src/routes/messages.ts`, `packages/server/test/outbox.test.ts`
- Modify: `packages/server/src/app.ts` (`AppOptions.sendsMessages?: boolean` and `onMessageQueued?: () => void`; start and stop the outbox loop), `packages/server/src/index.ts` (`startGarageServer` passes `sendsMessages: !linked`), `packages/server/package.json` (nodemailer), root devDeps (`smtp-server`)

**Interfaces:**
- **Produces the mailer:** `interface Mailer { send(m: { from: string; to: string; subject: string; text: string; attachments: { filename: string; content: Buffer }[] }): Promise<void> }` and `smtpMailer(s: Settings["messages"], password: string): Mailer`.
  - It uses nodemailer with `secure` true only for `ssl`, `requireTLS` for `starttls`, and timeouts of 20 s.
- **Produces the outbox functions:**
  - `queueMessage(db, input: MessageInput, userId): MessageOut`. Input: `{event|"test", channel, customerId|null, contactId?, documentId?, receiptId?, recipient, subject?, body, attachment?: {fileName, base64 ≤ 3 MB}, dedupeKey?}`.
    - Email → `queued`; WhatsApp → `opened` (log only).
    - A repeated `dedupeKey` returns the existing row.
  - `sendDue(db, mailer: Mailer|null, now: Date, place: string): Promise<{ sent: number; failed: number }>`.
    - It sends messages that are `queued` and whose `next_attempt_at` is null or past.
    - On failure: `attempts++`, then retry after `[1,5,30][attempts-1]` minutes; the 4th failure sets `failed`.
    - `mailer` null (mailbox not set up) → `failed` at once, with "Email isn't set up: Settings → Messages".
    - It sets `sender_place` to `place`.
  - `queueReminders(db, today: string /* Asia/Dubai date */): number`.
  - `startOutbox(db, opts: { mailerFor: () => Mailer|null; now?: () => number; place: string; everyMs?: number }): () => void` runs `sendDue` and `queueReminders` (once per Dubai day) every 30 s by default.
- **Produces the routes:**
  - `POST /api/messages` (`messages.send`) → `{ message }`, then calls `onMessageQueued`.
  - `GET /api/messages?customerId=&documentId=&status=` returns rows without file data, plus `fileName`.
  - `POST /api/messages/:id/retry` (failed → queued, attempts 0).
  - `POST /api/messages/test` `{ to }` (`settings.manage`).
  - `GET /api/messages/statements-due` lists customers with a statements contact and a non-zero balance who had no statement message since the 1st of this month.

- [ ] **Step 1: Write the failing tests** (`packages/server/test/outbox.test.ts`, fake `Mailer` recording calls):
  - **queued email is sent once with its attachment**: queue with a PDF, then `sendDue`; the mailer gets one call with `attachments[0].filename`, and the status is `sent`. A second `sendDue` sends nothing.
  - **retries 1/5/30 then failed**: a mailer that always throws. Calls at t+0, then +1m, +6m and +36m end with `failed`, attempts 4 and the error text kept. A call at t+30s doesn't retry early.
  - **no mailbox fails at once**: `mailer` null → `failed` after one call, with the "isn't set up" text.
  - **dedupe**: queuing the same `dedupeKey` twice gives one row.
  - **whatsapp is only logged**: status `opened`, and `sendDue` never mails it.
  - **reminders**:
    - An invoice due in 3 days, with `payment_due` on, gets one `payment_due` message in its contact's language. Running `queueReminders` again the same day adds nothing.
    - With `payment_due` off, it gets nothing.
    - A paid invoice gets nothing.
  - **real SMTP**: a `smtp-server` sink on a random port, with `smtpMailer({smtpSecurity:"none", …})`; the sink receives the subject and an attachment of the right size.
  - **statements-due** lists a customer with a balance and a statements contact, and stops listing them after a `statement` message.
- [ ] **Step 2: Run** `npx vitest run packages/server/test/outbox.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the outbox and routes as above.
- [ ] **Step 4: Run the same command, then `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(messages): outbox with SMTP sending, retries, reminders and statements due`.

### Task 4: The cloud sends for linked garages

**Files:**
- Create: `apps/cloud/src/outbox.ts`, `apps/cloud/test/outbox.test.ts`
- Modify: `apps/cloud/src/server.ts` (start `CloudOutbox`; give the garage apps `onMessageQueued`), `apps/cloud/src/sync-routes.ts` (after a push holding `messages` entries, `outbox.mark(garageId)`), `apps/desktop/src/main/index.ts` (pass `sendsMessages: !link` into `startGarageServer`)

**Interfaces:**
- **Produces `class CloudOutbox`:** `constructor(admin, host, opts: { now; mailerFor: (db) => Mailer|null; everyMs?: number })`, plus `mark(garageId)`, `start()`, `stop()` and `runOnce(): Promise<void>`.
  - It visits marked garages through `host.whenFree`, `host.enter`, `host.get` and `host.leave`, and calls `sendDue(db, mailerFor(db), now, "cloud")`.
  - A garage stays marked while it has queued rows.
  - At start, and once per Dubai day, it marks every garage that isn't suspended, and runs `queueReminders` for each.
- **Consumes:** `sendDue`, `queueReminders`, `getSecret` and `smtpMailer` from Tasks 2–3.

- [ ] **Step 1: Write the failing test** `linked PC never sends; cloud sends a pushed message once`, using the existing `apps/cloud/test/helpers.ts` (cloud plus a linked PC):
  1. On the linked PC's server, which is built with `sendsMessages: false`, queue an email.
  2. Run the PC's `sendDue` path: nothing is sent.
  3. Push to the cloud, then `outbox.runOnce()` with a fake mailer: 1 call.
  4. Run it again: still 1 call.
  5. Pull on the PC: its row shows `sent` with `sender_place = "cloud"`.

  A second test, **browser-queued message is sent**, POSTs `/api/messages` through the cloud's garage API, then `runOnce` sends it.
- [ ] **Step 2: Run** `npx vitest run apps/cloud/test/outbox.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `CloudOutbox` and the wiring above.
- [ ] **Step 4: Run the same command, then `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cloud): send queued messages for linked garages, exactly once`.

### Task 5: PDF bytes and WhatsApp hand-off on PC and browser

**Files:**
- Create: `apps/desktop/src/renderer/messages/{pdf,whatsapp}.ts`, `apps/desktop/test/whatsapp.test.ts`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/lib/types.ts` (bridge type), `apps/desktop/package.json` (html-to-image, pdf-lib)

**Interfaces:**
- **Produces in the main process:**
  - IPC `ffgp:makePdf(html) → base64`: the same `printToPDF` options as `savePdf`.
  - IPC `ffgp:whatsapp({ url, pdf?: { fileName, base64 } })` saves the PDF to `Documents/Fleetfix Garage Pro/Sent/<fileName>`, calls `shell.showItemInFolder`, then `shell.openExternal(url)`. It accepts only `https://wa.me/` URLs.
- **Produces in the renderer:**
  - `makePdf(html: string): Promise<string /*base64*/>`: the bridge if present; otherwise, lazily imported, `html-to-image` `toJpeg` of an A4-wide (794 px) off-screen iframe at pixelRatio 2, sliced into 1123 px pages by `pdf-lib`.
  - `uaePhone(raw: string): string | null` returns `9715XXXXXXXX` for a UAE mobile, or digits for any number already in international form with + or 00; it returns null for anything shorter than 9 digits or with letters.
  - `whatsappUrl(phone: string, text: string): string` builds `https://wa.me/<digits>?text=<encoded>`.
  - `openWhatsApp(phone, text, pdf?)`: the bridge if present; otherwise the PDF downloads through an `<a download>` link and `window.open(url)` runs.

- [ ] **Step 1: Write the failing tests:**
  - `apps/desktop/test/whatsapp.test.ts` (vitest), **uaePhone normalises**:
    - `"050 123 4567"`, `"+971 50 123 4567"`, `"00971501234567"` and `"0501234567"` → `"971501234567"`.
    - `"+44 7700 900123"` → `"447700900123"`.
    - `"abc"` and `"1234"` → null.
    - `whatsappUrl` encodes Arabic and `&`.
  - `electron.spec.ts`, **makePdf returns a PDF**: `window.ffgp.makePdf("<p>hi</p>")` decodes to bytes starting with `%PDF`.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/test/whatsapp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the renderer and main-process code above.
- [ ] **Step 4: Run** the vitest file, then `npm run build -w @ffgp/desktop && npm run e2e:electron -w @ffgp/desktop`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(messages): PDF bytes and WhatsApp hand-off on PC and browser`.

### Task 6: Screens — Messages settings, contacts, driver

**Files:**
- Create: `apps/desktop/src/renderer/pages/settings/sections/MessagesSection.tsx`, `apps/desktop/src/renderer/components/ContactsPanel.tsx`
- Modify:
  - `pages/settings/tiles.ts`: the Messages tile is no longer "coming". Its status is green "Email ready", amber "Email not set up", or red "N messages failed".
  - `pages/settings/SettingsSectionPage.tsx`
  - `pages/CustomerPage.tsx`: a Contacts tab, and "Message language" in the customer form.
  - `pages/DocumentPage.tsx`: Driver name and phone on job cards.
  - `lib/types.ts`

**What the screens hold:**
- **Messages section, in this order:**
  1. **Email (your mailbox)**: host, port, security, user, Password (shows "Set"/"Not set" with a Replace button that opens a password field; never prefilled), from name and from address. "Send test email" takes an address, calls POST `/api/messages/test`, then polls GET `/api/messages?status=` for that id and shows "Sent" or the error.
  2. **Reminders**: due-soon and overdue days.
  3. **Events**: one collapsible card each, with on/off, auto/ask, channel, and subject and text in English and Arabic (the Arabic fields `dir="rtl"`). A placeholder hint lists the 10 names. Save errors show next to the field.
- **Contacts panel**: a table with name, phone, email, language and four "gets" ticks, plus marketing consent (with its date). Add, edit and delete.

- [ ] **Step 1: Write the failing e2e** `apps/desktop/test/messages.spec.ts` (new script `e2e:messages`, the same server and dev setup as `e2e:credit`), **set up email and send a test**:
  1. Start an `smtp-server` sink.
  2. Fill in Settings → Messages with host 127.0.0.1, the sink's port, security none, and a password.
  3. The password field shows "Set" after saving.
  4. Send a test to `owner@example.com`; the status shows "Sent" and the sink got 1 mail.
  5. Add a contact "Accounts" (invoices tick) on a company customer; it shows in the table.
- [ ] **Step 2: Run** `npm run e2e:messages -w @ffgp/desktop`. Expected: FAIL.
- [ ] **Step 3: Implement** the screens. The test server is the standalone PC server, so it sends (`sendsMessages: true`).
- [ ] **Step 4: Run the same command.** Expected: PASS. Then run `npm test`.
- [ ] **Step 5: Commit** `feat(messages): Messages settings screen, customer contacts, job card driver`.

### Task 7: Screens — Send menu, triggers, logs, dashboard

**Files:**
- Create: `apps/desktop/src/renderer/messages/{SendDialog.tsx,triggers.ts,values.ts}`, `apps/desktop/src/renderer/components/MessageLog.tsx`
- Modify: `pages/DocumentPage.tsx` (Send button; triggers after create, issue, status-completed and payment), `components/ReceivePaymentDialog.tsx` (payment_received trigger), `pages/CustomerPage.tsx` (Messages tab; Send on the statement), `pages/DashboardPage.tsx` (failed messages card with Retry; "Statements to send (N)" card with Send all), `README.md` (a "Messages (Settings Part 3b)" section)

**Interfaces:**
- **Produces in `values.ts`:** `messageValues({ customer, contact, doc?, receipt?, garage, balanceFils }): Record<Placeholder,string>`. Amounts use `formatAED`; dates use `formatDate`.
- **Produces in `triggers.ts`:** `afterAction(event: MessageEvent, ctx: { customerId; documentId?; receiptId?; html?: () => string; fileName?: string }): Promise<void>`.
  - It reads settings and recipients. With the event off, nothing happens.
  - "auto" with email recipients: `makePdf` (when `html` is given) and POST each recipient with a `dedupeKey`, then toast "Emailed to …". With no email address on file, a warning toast says who is missing one.
  - WhatsApp, or "ask": open the `SendDialog`.
- **Produces `SendDialog`:**
  - Recipient picker (from `recipientsFor`), a language switch, and editable subject and body (prefilled by `fillTemplate`).
  - Buttons: "Send email" (when an email exists; POST with the PDF) and "Open WhatsApp" (when `uaePhone` succeeds; `openWhatsApp`, then POST a `whatsapp` log).
  - The PDF is made once per dialog.
- **Produces `MessageLog`:** time, event, channel, recipient, status and error. It is used on the customer's Messages tab and under a document.

- [ ] **Step 1: Write the failing e2e** in `messages.spec.ts`:
  - **invoice issued emails the accounts contact with the PDF**:
    1. Set `invoice_issued` to "auto, email".
    2. Issue an invoice for the company.
    3. Within 40 s, the sink got 1 mail to the accounts address, with a `.pdf` attachment whose bytes start with `%PDF`.
    4. The document's log shows "sent".
    5. Reissuing is impossible, and nothing is sent twice.
  - **vehicle ready asks and opens WhatsApp for the driver**:
    1. A job card with driver phone `050 123 4567`.
    2. Set the status to completed: the dialog opens with the driver selected.
    3. "Open WhatsApp" opens a popup whose URL starts with `https://wa.me/971501234567?text=`.
    4. The log shows "opened".
  - **failed message shows on the dashboard and retries**: point SMTP at a closed port; after the retries (with the test clock / `everyMs` shortened through an env var `FFGP_OUTBOX_FAST=1`) the dashboard shows 1 failed; fix the port and press Retry; the sink gets the mail.
- [ ] **Step 2: Run** `npm run e2e:messages -w @ffgp/desktop`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the components and triggers. `FFGP_OUTBOX_FAST=1` sets the retry delays to 1/2/3 s; it is read only by the dev server, never in packaged apps.
- [ ] **Step 4: Run** `npm test`, then every e2e suite: `e2e`, `e2e:settings`, `e2e:credit`, `e2e:messages`, `e2e:electron`, `e2e:cloud`, `e2e:sync`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(messages): Send menu, automatic and ask triggers, message log, dashboard`.

## After merge (not a task)
1. Deploy the cloud first: migration 10.
2. On the live cloud, run **Send test email** with a real mailbox. If the cloud can't reach the mail server (some hosts block outgoing SMTP ports), stop and tell the user before any PC updates. The fallback is "the PC sends even when linked" for desktop garages, and it needs a decision.
