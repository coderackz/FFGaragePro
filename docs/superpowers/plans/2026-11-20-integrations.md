# Integrations (WhatsApp Business API, Zoho Books, QuickBooks Online) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings → Integrations connects the garage's WhatsApp Business account (messages sent by the API from the outbox) and Zoho Books or QuickBooks Online (customers, invoices, credit notes and payments pushed one way).

**Architecture:**
- Integrations run inside a garage's server app only when it's given `integrations` options. The cloud gives them to every garage app; the dev server gives them for e2e.
- Provider secrets are settings secrets `secret.integration.<provider>`, which never reach PCs. A non-secret status row (`integration.status`) does sync to PCs, so the Send dialog knows WhatsApp is connected.
- Webhooks and OAuth callbacks reach a garage through a cloud path that carries the garage code: `/api/hooks/<code>/…` is rewritten to the garage's `/api/integrations/…`.
- Pushing is idempotent, like `postPending`:
  - each round looks for issued invoices, credit notes and receipts that aren't in `integration_links` yet;
  - failures wait with backoff in `integration_failures`.
- WhatsApp messages are queued (`channel = 'whatsapp'`, `status = 'queued'`, with `wa_json`) and sent by the outbox round.

**Tech Stack:** Fastify, node:sqlite, global `fetch` (injectable), Vitest with fake provider servers (Fastify on a random port), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-20-integrations-polish-design.md`, Part D.

## Global Constraints
- Provider tokens and client secrets never leave the cloud. They are never returned by a route; the redacted status shows only "set".
- The WhatsApp webhook checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret). The GET verify checks the verify token.
- OAuth uses a random `state`, compared in constant time and used once.
- One way only:
  - nothing is read back except the lists used for mapping (organizations, taxes, items);
  - nothing pushed is ever changed;
  - `integration_links` (provider, kind, local id) → external id, so nothing is pushed twice.
- Starting point: only documents and receipts on or after the connection's `fromDate` (default: the day it was connected).
- Money in fils internally; providers get AED decimals (`fils / 100`).
- Screens stay English. Nothing changes for garages that don't connect anything.
- Migration 18: the cloud updates before PCs.

## Review Focus
1. A push that fails half-way (customer pushed, invoice refused) → the customer link is kept, the invoice retries later without pushing the customer twice. Test owned by Task 4 (`retries without duplicates`).
2. The webhook with a wrong or missing signature → 401, and nothing changes. Task 3 (`webhook`).
3. An OAuth callback with a wrong or reused state → refused, and no tokens are stored. Task 4 (`oauth state`).
4. An expired access token → refreshed once, then the call is retried. Task 4 (`token refresh`).
5. A garage on PCs only (no `integrations` option) → the page says integrations need Fleetfix Cloud, and the routes answer 404 or "not available". Task 1 (`not available on a PC`).

---

### Task 1: Integrations core
**Files:**
- Create:
  - `packages/server/src/integrations/store.ts`
  - `packages/server/src/routes/integrations.ts`
  - `packages/server/test/integrations-core.test.ts`
- Modify:
  - `migrations.ts`: migration 18;
  - `settings.ts`: `SecretName` gains `` `integration.${Provider}` ``;
  - `app.ts`: `AppOptions.integrations`;
  - `apps/cloud/src/server.ts` and `garages.ts`: the hooks rewrite, and the options per garage;
  - `apps/cloud/src/run.ts`: `FFGP_PUBLIC_URL`.

Migration 18:
```sql
CREATE TABLE integration_links (provider TEXT NOT NULL, kind TEXT NOT NULL, local_id TEXT NOT NULL, external_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (provider, kind, local_id));
CREATE TABLE integration_failures (provider TEXT NOT NULL, kind TEXT NOT NULL, local_id TEXT NOT NULL, label TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT, error TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (provider, kind, local_id));
ALTER TABLE messages ADD COLUMN wa_json TEXT;        -- {name, language, params: string[]}
ALTER TABLE messages ADD COLUMN provider_id TEXT;    -- WhatsApp message id (wamid)
ALTER TABLE messages ADD COLUMN delivery TEXT;       -- delivered | read
```
These two tables are not synced: they exist only where integrations run.

**Interfaces (produces):**
- `type Provider = "whatsapp" | "zoho" | "quickbooks"`.
- `interface IntegrationOptions { publicUrl: string; garageCode?: string; endpoints?: Partial<Endpoints>; fetch?: typeof fetch; ownLoopMs?: number }`.
- `Endpoints = { graph; zohoAccounts /* with "{region}" */; quickbooksAuthorize; quickbooksToken; quickbooksApi; quickbooksSandboxApi }`.
- `hookBase(o)`: `${publicUrl}/api/hooks/${garageCode}` when there's a garage code, else `${publicUrl}/api/integrations`.
- `getConfig<T>(db, p): T | null`, `saveConfig(db, userId, p, cfg | null)`: the secret, plus refreshing the status row and an audit entry "(changed)".
- `statusOf(db): IntegrationStatus`: `{ whatsapp?: { connected, label, since }, zoho?: …, quickbooks?: … }`, stored in settings key `integration.status`, which syncs.
- `link(db, p, kind, localId, extId)`, `linked(db, p, kind, localId): string | null`.
- `recordFailure(db, p, kind, localId, label, error, now)` uses backoff of 1, 5, 30, 120 and 360 minutes; after the 6th failure `next_attempt_at` is NULL, which means it waits for "Retry all". `clearFailure`. `retryAll(db, p)`.
- Routes (all `settings.manage`):
  - `GET /api/integrations` → `{ available: boolean, hookBase, status, failures: {provider,label,error,attempts}[] }`. Without options: `available: false`, and nothing else is registered;
  - `POST /api/integrations/:provider/disconnect`;
  - `POST /api/integrations/:provider/retry`.
- Cloud `handle()`:
  - `/api/hooks/<code>/<rest>` → the garage by code, with `req.url = /api/integrations/<rest>?<query>`;
  - an unknown code → 404;
  - a non-GET garage request marks the outbox: `outbox.mark(g.id)`.

- [ ] Test `integrations-core.test.ts`:
  - `not available on a PC`: `makeApp()` → GET gives `available:false`, and disconnect → 404;
  - `secrets never returned`: save a whatsapp config with `accessToken: "SECRET"`, and no response body contains "SECRET";
  - `status row syncs`: the `integration.status` row exists and has no secret in it;
  - `failure backoff`: attempts 1→6 give next times +1, +5, +30, +120, +360 min, then null; `retryAll` clears `next_attempt_at` and attempts.
- [ ] Run → FAIL. Implement. Run → PASS. Full suite and typecheck. Commit `feat(integrations): core — secrets, links, failures, hooks path`.

### Task 2: Fake providers (test helper)
**Files:** create `packages/server/test/fake-providers.ts`, used by Tasks 3–5 and the e2e (it's also exported for the dev server through `packages/server/src/dev-fakes.ts` behind `FFGP_FAKE_PROVIDERS=1`).
- `startFakeProviders(): Promise<{ url: string; endpoints: Endpoints; calls: {method,path,body,headers}[]; set(k, v); close() }>`. It has state switches: `failNext(pathRegex, status, body)` and `expireToken()`.
- **Graph:**
  - `GET /graph/:phoneId` → `{ display_phone_number: "+971 4 000 0000", id }` (a `Bearer` header is required);
  - `POST /graph/:phoneId/media` (multipart) → `{ id: "media-N" }`;
  - `POST /graph/:phoneId/messages` → `{ messages: [{ id: "wamid.N" }] }`.
- **Zoho:**
  - `GET /zoho-accounts/{region}/oauth/v2/auth` → 302 to `redirect_uri?code=zc&state=<state>`;
  - `POST /zoho-accounts/{region}/oauth/v2/token` → `{ access_token, refresh_token, expires_in: 3600, api_domain: <url>/zoho-api }`; the refresh grant gives a new access token;
  - `/zoho-api/books/v3/organizations`, `/settings/taxes`, `/items` (lists);
  - `POST /contacts`, `/invoices`, `/creditnotes`, `/creditnotes/:id/invoices`, `/customerpayments` → `{ code: 0, contact|invoice|creditnote|payment: { …_id } }`.
  - An expired token gives `401 { code: 57 }`.
- **QuickBooks:**
  - `/qbo-auth` → 302 with `code`, `state`, `realmId=9130`;
  - `POST /qbo-token` (Basic auth) → tokens;
  - `/qbo-api/v3/company/:realm/query?query=` → `QueryResponse` with TaxCode, Item and Customer;
  - `POST /customer`, `/invoice`, `/creditmemo`, `/payment` → `{ Customer|Invoice|CreditMemo|Payment: { Id } }`;
  - a duplicate customer name gives `400 Fault.Error[0].code "6240"`.
- [ ] No separate test: Tasks 3–5 exercise it. Commit with Task 3.

### Task 3: WhatsApp Business API
**Files:**
- Create:
  - `packages/server/src/integrations/whatsapp.ts`
  - `packages/server/test/whatsapp-api.test.ts`
- Modify:
  - `outbox.ts`: `sendWhatsAppDue`;
  - `apps/cloud/src/outbox.ts`: the round runs it, and the "left" check includes queued WhatsApp;
  - `shared/messages.ts`: `messageInputSchema.wa` optional `{ name, language, params: string[] }`;
  - `queueMessage`: a WhatsApp message with `wa` gets status `queued`.

**Interfaces:**
- `whatsappSchema`: `{ phoneNumberId, businessAccountId, accessToken, appSecret }`. The `verifyToken` is generated on connect.
- `waClient(cfg, o): { check(): Promise<string /* display number */>; upload(fileName, base64): Promise<string>; sendTemplate(to, wa, mediaId?, fileName?): Promise<string /* wamid */> }`.
  - The `to` number is digits only, from `whatsappNumber()` (already in shared).
  - Template components: a header document when there's a file, and body text parameters.
- `sendWhatsAppDue(db, client | null, now, place)` has the same claim, retry, `MAY_HAVE_GONE` and fail semantics as email. No client means failed: "WhatsApp Business API isn't connected: Settings → Integrations".
- Routes:
  - `POST /api/integrations/whatsapp/connect` checks the number first, then saves; the status label is the display number;
  - `POST /api/integrations/whatsapp/test {to, templateName, language}`;
  - `GET /api/integrations/whatsapp/webhook` (hub.verify_token → hub.challenge);
  - `POST /api/integrations/whatsapp/webhook`: raw-body HMAC; `statuses[]` → `delivery` delivered/read; `failed` → status failed with the error title.
- [ ] Tests:
  - `connect and test`: wrong token → 400 "WhatsApp said: …"; the right one → connected label "+971 4 000 0000";
  - `queued message is sent by the outbox`: with a PDF it uploads the media first, and the message is sent with provider_id `wamid.1`. The fake saw the header document and body params in order;
  - `webhook`:
    - a bad signature → 401 and no change;
    - a good one → delivered, then read;
    - failed → status failed with the error;
    - the GET verify gives the challenge, and a wrong token → 403;
  - `not connected → failed with the reason`.
- [ ] Commit `feat(integrations): WhatsApp Business API sending and delivery status`.

### Task 4: Zoho Books (OAuth and push engine)
**Files:**
- Create:
  - `packages/server/src/integrations/oauth.ts`
  - `push.ts`
  - `zoho.ts`
  - `packages/server/test/zoho.test.ts`

**Interfaces:**
- `interface Pusher { customer(c): Promise<string>; invoice(doc, customerExt): Promise<string>; creditNote(doc, customerExt, invoiceExt): Promise<string>; payment(receipt, customerExt, allocs: {invoiceExt, amountFils}[]): Promise<string> }`.
- `pushPending(db, provider, pusher, now): Promise<{ pushed: number; failed: number }>`. The order is invoices, then credit notes, then receipts. Each:
  - is skipped while its failure waits;
  - pushes its customer first when it isn't linked;
  - links on success, and records a failure with a label ("INV-00012") otherwise.
- Receipts:
  - pushed once every invoice they're allocated to is linked;
  - only positive allocations; any amount left unallocated goes as unapplied (the provider keeps it as customer credit).
- Credit notes need their invoice linked.
- Lines: when `net_fils === qty × unit_price_fils`, the line goes as qty × unit; otherwise as quantity 1 at the line's net, with "qty × unit (less discount)" in the description.
  - The tax id comes from the mapping: `vat_fils > 0` → `taxId`, otherwise `zeroTaxId`, or none.
  - The item comes from the line's kind (`items.labour|part|other`).
- OAuth:
  - `POST /api/integrations/:provider/connect {clientId, clientSecret, region?, sandbox?, fromDate?}` → `{ authorizeUrl, redirectUri }`;
  - `GET /api/integrations/:provider/callback` checks state (single use; a mismatch → 400 page "That link has expired. Connect again from Settings → Integrations"), exchanges the code, stores the tokens, then sends a 302 to `/#/settings/integrations?connected=<p>`;
  - `GET /api/integrations/:provider/options` → `{ organizations?, taxes, items }`;
  - `PUT /api/integrations/:provider/mapping {organizationId?, taxId, zeroTaxId?, items:{labour, part, other}}`;
  - `POST /api/integrations/:provider/push` → runs `pushPending` now.
  - The status label is the organization name, with `needsSetup` until the mapping is saved.
- Tokens: `accessToken`, `refreshToken` and `expiresAt`. It refreshes when the token is within 60 s of expiry, or after one 401 (then retries once).
- The cloud round (`apps/cloud/src/outbox.ts`) calls `runIntegrations(db, options, now)`, which pushes for each connected provider with its mapping set. The dev server runs it on `ownLoopMs`.
- [ ] Tests:
  - `oauth state`: a wrong state → 400 and no tokens; the right state → connected; a reused state → 400;
  - `push`: an issued invoice → contact and invoice. The fake saw `invoice_number` "INV-00001", `ignore_auto_number_generation=true`, the lines with tax_id and item_id, and the date. A second run pushes nothing;
  - `credit note and payment`: the credit note is applied to its invoice; the payment carries `invoices[{invoice_id, amount_applied}]`;
  - `retries without duplicates`: the fake fails `/invoices` once → a failure with the label; the next run (after the backoff, with a fake clock) pushes the invoice and not the contact again;
  - `token refresh`: `expireToken()` → one refresh, then success;
  - `fromDate`: an invoice issued before it isn't pushed.
- [ ] Commit `feat(integrations): Zoho Books — OAuth and one-way push`.

### Task 5: QuickBooks Online
**Files:**
- Create:
  - `packages/server/src/integrations/quickbooks.ts`
  - `packages/server/test/quickbooks.test.ts`
- Same `Pusher`. Specifics:
  - the realm id comes from the callback;
  - the token endpoint uses Basic auth;
  - API base: `quickbooksApi`, or `quickbooksSandboxApi` when `sandbox`, with `?minorversion=75`;
  - `Customer.DisplayName` (on 6240 duplicate: query by name and link that one);
  - `Invoice { CustomerRef, DocNumber (≤21), TxnDate, GlobalTaxCalculation: "TaxExcluded", Line[SalesItemLineDetail{ItemRef, Qty, UnitPrice, TaxCodeRef}] }`;
  - `CreditMemo` has the same shape;
  - `Payment { CustomerRef, TotalAmt, TxnDate, PaymentRefNum, Line[{Amount, LinkedTxn[{TxnId, TxnType:"Invoice"}]}] }`;
  - the options come from `query` for TaxCode and Item.
- [ ] Tests:
  - `connect with realm`;
  - `push invoice, credit memo, payment`;
  - `duplicate customer name links the existing one`;
  - `sandbox uses the sandbox base`.
- [ ] Commit `feat(integrations): QuickBooks Online push`.

### Task 6: Integrations screens, Send dialog, e2e, docs
**Files:**
- Create:
  - `apps/desktop/src/renderer/pages/settings/sections/IntegrationsSection.tsx`, with its tile and a Settings menu item "Integrations" at `/settings/integrations`;
  - `apps/desktop/test/integrations.spec.ts`, `playwright.integrations.config.ts`, and the `e2e:integrations` script (the dev server runs with `FFGP_FAKE_PROVIDERS=1`).
- Modify:
  - `SendDialog.tsx`;
  - `help/guides.ts` (the integrations guide);
  - `README.md`.
- **Page:**
  - When it isn't available, a notice: "Integrations run in Fleetfix Cloud. Open your garage at garagepro.fleetfix.ae as the owner to connect them."
  - One card per provider, each with:
    - its state badge;
    - the connect form (WhatsApp fields; Zoho region, client ID and secret; QuickBooks client ID, secret and sandbox), with the redirect URI or webhook URL and verify token shown to copy;
    - "Send earlier documents from" (date);
    - after connecting: the mapping pickers, Save, "Send now", the failures with "Retry all", the last result, and Disconnect.
- **Send dialog:** when `status.whatsapp.connected` and the chosen template has `waTemplateName`, the WhatsApp button reads "Send on WhatsApp". It queues `{channel:"whatsapp", wa:{name, language, params: values in order}}` and shows "Queued". Otherwise the wa.me flow stays as it is.
- [ ] e2e:
  1. WhatsApp connect, then Test;
  2. a template with an approved name → Send on WhatsApp → the log shows Sent (after the outbox round);
  3. Zoho connect → the fake authorize → back, connected;
  4. mapping → issue an invoice → Send now → the card shows "1 pushed, 0 waiting";
  5. Disconnect.
- [ ] Run the typecheck, unit tests, build and all e2e suites. Commit `feat(integrations): Integrations page, WhatsApp API sending from the Send dialog`.
