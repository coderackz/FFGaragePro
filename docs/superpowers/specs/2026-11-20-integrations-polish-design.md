# Fleetfix Garage Pro — Integrations, menu, message templates, promo codes — Design

## Why
The app's core is built and the owner is happy with it. Four things came up before planning the next stage (user, 2026-11-20):
1. **Integrations:** connect to the WhatsApp Business API, Zoho Books and QuickBooks.
2. **The side menu:** "Money" and the other headings don't read well. Use standard headings.
3. **Message templates:** templates for both WhatsApp and email.
4. **Promo codes:** discount coupon codes on estimates and invoices.

## Decided by the user
- **Integrations: "an Integrations page and all three."**
  - WhatsApp Business API sends messages by itself.
  - Zoho Books and QuickBooks get customers, invoices, credit notes and payments pushed one way from Fleetfix.
  - Each provider needs a developer app (client ID and secret) that the garage registers with Meta, Zoho or Intuit.
- **Menu headings:** Operations · Finance · Accounts · HR & Payroll · Inventory · Reports · Knowledge · Settings. Reports and Knowledge are two separate groups.
- **Promo codes: "codes with limits":**
  - % off or a fixed AED amount off;
  - valid from and to;
  - an optional minimum bill;
  - optional maximum uses, and once per customer;
  - labour, parts or both;
  - typed on an estimate or invoice, with the discount coming off before VAT and printing on the document;
  - a report of each code's use.

## Part A — Menu and Knowledge
- **The menu** (screens are only regrouped; nothing is renamed or removed):
  - Dashboard;
  - **Operations:** Estimates, Job Cards, Invoices, Customers, Vehicles;
  - **Finance:** Receipts, Credit Notes, Bills, Expenses, Bank & cash;
  - **Accounts:** Books, VAT return, Fixed assets;
  - **HR & Payroll:** Employees, Payroll;
  - **Inventory:** Parts, Purchase orders, Suppliers;
  - **Reports:** Customer aging, Supplier aging, Promo codes report;
  - **Knowledge:** Help & guides;
  - **Settings:** Settings, Integrations.

  Each item keeps its permission check, and a group with nothing visible for a role is hidden.
- **Knowledge, Help & guides:**
  - short how-to pages kept in the app (no network needed), one per area: getting started, workshop flow, getting paid, purchases and stock, the books, the VAT return, payroll and leavers, fixed assets, messages and templates, promo codes, integrations, backups and the cloud;
  - a search box over the titles and text;
  - English only (screens stay English).

## Part B — Message templates
- **Settings → Message templates** is a library of the garage's own templates. Each template has:
  - a name;
  - the channel: email, WhatsApp or both;
  - for email, a subject;
  - the text in English and in Arabic;
  - the same placeholders as the event messages ({customer}, {plate}, {doc_number}, {amount} and the rest).
- The existing per-event texts (Settings → Messages) stay as the **default** for each event.
- **In the Send dialog,** a "Template" picker lists the default and the garage's templates for that channel. Choosing one fills the subject and text, which can still be edited before sending.
- **For the WhatsApp Business API** (Part D):
  - A template can carry the name and language of a **Meta-approved template** with an ordered list of placeholders for its body parameters.
  - Business-initiated WhatsApp messages through the API must use an approved template, as Meta requires.
- The library syncs like other settings data (a mergeable `message_templates` table). Templates can be archived, not deleted, so messages sent from them still make sense.

## Part C — Promo codes
- **Settings → Promo codes** manages the codes. Each code has:
  - the code, unique and case-insensitive;
  - a description;
  - the kind, percent or fixed AED, and its value;
  - what it applies to: labour, parts or all;
  - valid from and to;
  - an optional minimum net (of the lines it applies to);
  - optional maximum uses;
  - once per customer (yes or no);
  - active or not.
- **On an estimate, job card or invoice while it's a draft**, an "Apply promo code" box.
  - The code is checked: active, inside its dates, minimum met, uses left, and not already used by this customer when that limit is on.
  - It is stored on the document as the code, its kind and value, and the discount amount in fils.
- **The discount and VAT:**
  - It comes off the net of the matching lines before VAT, spread across them in proportion. VAT is then worked on the reduced net, as UAE VAT treats discounts given at the time of supply.
  - Line discounts still apply first.
  - Per line, the promo share is rounded to the fil, and the last line takes the remainder.
- **The printout** shows a "Promo {CODE}" line with the discount and the totals after it.
- **A use** counts when the invoice is issued. A credit note that cancels the whole invoice frees the use again.
  - An estimate converted to a job card or invoice carries its code, re-checked when the invoice is issued.
  - A code that expired before issue is refused with the reason, unless the owner overrides it, which is recorded in the audit log.
- **The books** need no new account: discounted sales post at their reduced net, as line discounts already do (spec §"Discounts are already inside each line's net").
- **Reports → Promo codes:** for each code, its uses, the discount given and the invoices.
- **Who can do what:**
  - managing codes: `settings.manage`;
  - applying one: anyone who edits documents;
  - the owner override: `credit.override`-style, Owner only.

## Part D — Integrations
- **Settings → Integrations** shows one card per provider: WhatsApp Business API, Zoho Books and QuickBooks Online. Each card shows its state (not connected, connected or error), Connect and Disconnect, "Test", and the last sync with any errors.
- **Where integrations run:** at the place that sends messages and posts the books (`postsBooks`). That is **the cloud** for a linked garage. A garage on PCs only can't use them (shown on the page). Secrets, meaning tokens and client secrets, are stored like the SMTP password: settings secrets that never go down to PCs.
- **WhatsApp Business API** (Meta Cloud API, Graph API):
  - **Settings:** phone number ID, WhatsApp business account ID and a permanent access token (system user). "Test" sends a template message to a number you type.
  - **Sending:** with the API connected, a WhatsApp message is **queued like an email** and sent by the outbox instead of opening wa.me.
    - It uses the event's (or chosen) template's approved Meta template, with its parameters filled from the placeholders.
    - A PDF (invoice, statement, payslip) goes as the template's document header, uploaded to Meta's media endpoint first.
    - Without an approved template mapped for that message, it falls back to the wa.me flow, as today.
  - **Delivery statuses** (sent, delivered, read, failed) come back through a webhook on the cloud (`/api/integrations/whatsapp/webhook`, verify token check) and update the message.
- **Zoho Books and QuickBooks Online** (one-way push from Fleetfix):
  - **Connecting:** OAuth 2 ("Connect" sends you to the provider; the callback is on the cloud).
    - Zoho needs the region (.com, .eu, .in, .com.au, .sa) and the organization ID, picked after connecting.
    - QuickBooks keeps its realm ID.
  - **What's pushed:**
    - customers, when first used;
    - issued invoices, as invoices with their lines;
    - credit notes (Zoho credit notes, QuickBooks credit memos);
    - receipts, as customer payments applied to their invoices.

    Settings map the VAT tax code and the item or account used for labour, parts and other lines (picked from the provider's own lists after connecting).
  - **How it pushes:**
    - an `integration_links` table keeps (provider, kind, fleetfix id) → the external id, so nothing is pushed twice;
    - a queue retries failed pushes with backoff;
    - errors show on the card, with "Retry all".
  - **Starting point:** documents issued before connecting are pushed only if "Also send earlier documents from <date>" is chosen when connecting.
  - **Never:** Fleetfix doesn't read anything back from Zoho or QuickBooks and never changes what's there after pushing. A credit note in Fleetfix becomes a credit note there; nothing is edited in place.
- **Testing:** each connector is written against the provider's documented REST API and tested in this repo against a fake provider server (recorded request and response shapes). A live check needs the garage's own developer apps and sandbox accounts. That's the user's step, listed on each card.

## Constraints
- Money in fils. Promo discounts never make a line negative, and a fixed AED code never takes more than the matching lines' net.
- Nothing changes for garages that don't use these features.
- Sync:
  - promo codes and templates sync like settings data;
  - promo uses are counted at the place that issues the invoice, and the cloud referees: a second use beyond the limit, arriving from an offline PC, is accepted and flagged on the report, because the invoice is already issued;
  - integrations run only at the cloud.
- Screens stay English. Templates have English and Arabic text.
- **Security:**
  - provider tokens never leave the cloud;
  - the WhatsApp webhook checks Meta's signature (`X-Hub-Signature-256`) with the app secret;
  - OAuth uses a state parameter.

## Approaches
- **Integrations:**
  - **A. Built-in connectors** (chosen by the user).
  - **B. An open API with webhooks** for Zapier or Make: cheaper, but someone has to set up each link. Not chosen; it can come later.
- **Promo discount:**
  - **A. Spread over the matching lines before VAT** (chosen): VAT stays right per line, and the books need no new account.
  - **B. A separate negative "discount" line:** simpler to print, but it mixes VAT treatments and a discount account in the books. Rejected.

## Anti-goals
- A promo code that makes VAT or a line negative, or is counted twice for one invoice.
- Customer data or tokens sent anywhere the garage didn't connect.
- A WhatsApp message sent through the API without an approved template when Meta requires one (it would be rejected).
- Pushing the same invoice twice to Zoho or QuickBooks.

## Left to the builder
- The exact wording and order of the help pages.
- The card layouts.
- The retry backoff.
- How each provider's error is worded for the user.
