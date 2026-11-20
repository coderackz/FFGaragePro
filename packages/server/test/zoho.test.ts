import { afterEach, describe, expect, it } from "vitest";
import { call, makeApp, setUp, type App } from "./helpers";
import { startFakeProviders, type FakeProviders } from "../src/integrations/fakes";

const fakes: FakeProviders[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });
const LINES = [
  { kind: "labour", description: "Service", qty: 2, unitPriceFils: 5000, discountPct: 0 },
  { kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 3000, discountPct: 10 },
];
const dubaiToday = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

/** Follows the provider's authorize link (the fake sends straight back) into this garage's callback. */
async function authorize(app: App, authorizeUrl: string) {
  const res = await fetch(authorizeUrl, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  return app.inject({ method: "GET", url: `${back.pathname}${back.search}` });
}

async function garage(o: { connect?: boolean } = {}) {
  const fake = await startFakeProviders();
  fakes.push(fake);
  const app = await makeApp(undefined, { integrations: { publicUrl: "https://cloud.test", endpoints: fake.endpoints } });
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC", email: "ap@gulffleet.ae", creditAllowed: true })).body.customer;
  const issue = async (lines = LINES) => {
    const d = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines })).body.document;
    return (await call(app, "POST", `/api/documents/${d.id}/issue`, owner, {})).body.document;
  };
  const run = (at = new Date()) => app.integrations!.runOnce(at);
  if (o.connect !== false) {
    const c = await call(app, "POST", "/api/integrations/zoho/connect", owner, { clientId: "1000.ZC", clientSecret: "zoho-secret", region: "com" });
    await authorize(app, c.body.authorizeUrl);
    await call(app, "PUT", "/api/integrations/zoho/mapping", owner, { taxId: "tax-5", zeroTaxId: "tax-0", items: { labour: "item-lab", part: "item-part", other: "item-oth" } });
  }
  return { app, owner, fake, customer, issue, run };
}
const posts = (fake: FakeProviders, path: string) => fake.calls.filter((c) => c.method === "POST" && c.path === `/zoho-api/books/v3/${path}`);

describe("Zoho Books", () => {
  it("oauth state", async () => {
    const { app, owner } = await garage({ connect: false });
    const c = await call(app, "POST", "/api/integrations/zoho/connect", owner, { clientId: "1000.ZC", clientSecret: "zoho-secret", region: "eu" });
    expect(c.body.redirectUri).toBe("https://cloud.test/api/integrations/zoho/callback");
    const url = new URL(c.body.authorizeUrl);
    expect(url.pathname).toBe("/zoho-accounts/eu/oauth/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "1000.ZC", response_type: "code", access_type: "offline", scope: "ZohoBooks.fullaccess.all", redirect_uri: c.body.redirectUri });
    const wrong = await app.inject({ method: "GET", url: "/api/integrations/zoho/callback?code=zoho-code&state=forged" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toMatch(/expired/);
    expect((await call(app, "GET", "/api/integrations", owner)).body.status.zoho).toBeUndefined();
    const ok = await authorize(app, c.body.authorizeUrl);
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe("https://cloud.test/#/settings/integrations?connected=zoho");
    expect((await call(app, "GET", "/api/integrations", owner)).body.status.zoho).toMatchObject({ connected: true, label: "Al Quoz Auto Care LLC", needsSetup: true });
    const reused = await app.inject({ method: "GET", url: `/api/integrations/zoho/callback?code=zoho-code&state=${url.searchParams.get("state")}` });
    expect(reused.statusCode).toBe(400);
    const options = (await call(app, "GET", "/api/integrations/zoho/options", owner)).body;
    expect(options.taxes).toContainEqual({ id: "tax-5", name: "VAT 5%" });
    expect(options.items).toContainEqual({ id: "item-lab", name: "Labour" });
  });

  it("push", async () => {
    const { app, owner, fake, issue, run } = await garage();
    expect((await call(app, "GET", "/api/integrations", owner)).body.status.zoho.needsSetup).toBe(false);
    const inv = await issue();
    await run();
    expect(posts(fake, "contacts")).toHaveLength(1);
    expect(posts(fake, "contacts")[0]!.body).toMatchObject({ contact_name: "Gulf Fleet LLC", contact_type: "customer", email: "ap@gulffleet.ae" });
    const sent = posts(fake, "invoices");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.query).toMatchObject({ organization_id: "org-1", ignore_auto_number_generation: "true" });
    expect(sent[0]!.body).toMatchObject({
      customer_id: "zc-1", invoice_number: inv.number, date: dubaiToday(), is_inclusive_tax: false,
      line_items: [
        { item_id: "item-lab", description: "Service", quantity: 2, rate: 50, tax_id: "tax-5" },
        { item_id: "item-part", description: "Oil filter (1 × AED 30.00, less 10%)", quantity: 1, rate: 27, tax_id: "tax-5" },
      ],
    });
    await run();
    expect(posts(fake, "invoices")).toHaveLength(1);
  });

  it("credit note and payment", async () => {
    const { app, owner, fake, issue, run } = await garage();
    const inv = await issue();
    await call(app, "POST", `/api/documents/${inv.id}/payments`, owner, { amountFils: 5000, method: "card", reference: "AUTH 1" });
    const cn = (await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "Filter returned", lines: [{ lineId: inv.lines[1].id, qty: 1 }], returnToStock: false })).body.document;
    await run();
    expect(posts(fake, "creditnotes")[0]!.body).toMatchObject({ customer_id: "zc-1", creditnote_number: cn.number, reference_number: inv.number, line_items: [{ item_id: "item-part", rate: 27 }] });
    const apply = fake.calls.find((c) => /\/creditnotes\/zcn-\d+\/invoices$/.test(c.path))!;
    expect(apply.body).toMatchObject({ invoices: [{ invoice_id: "zi-2", amount_applied: 28.35 }] });
    expect(posts(fake, "customerpayments")[0]!.body).toMatchObject({ customer_id: "zc-1", payment_mode: "creditcard", amount: 50, reference_number: "AUTH 1", invoices: [{ invoice_id: "zi-2", amount_applied: 50 }] });
  });

  it("retries without duplicates", async () => {
    const { app, owner, fake, issue, run } = await garage();
    const inv = await issue();
    fake.failNext(/\/books\/v3\/invoices$/, 400, { code: 1001, message: "Invoice number already exists" });
    const t0 = Date.now();
    await run(new Date(t0));
    const failures = (await call(app, "GET", "/api/integrations", owner)).body.failures;
    expect(failures).toEqual([expect.objectContaining({ provider: "zoho", label: inv.number, error: "Zoho Books said: Invoice number already exists", attempts: 1 })]);
    await run(new Date(t0 + 30_000));
    expect(posts(fake, "invoices")).toHaveLength(1);
    await run(new Date(t0 + 61_000));
    expect(posts(fake, "invoices")).toHaveLength(2);
    expect(posts(fake, "contacts")).toHaveLength(1);
    expect((await call(app, "GET", "/api/integrations", owner)).body.failures).toEqual([]);
  });

  it("an existing contact with the same name is linked, not duplicated", async () => {
    const { app, owner, fake, customer, run } = await garage();
    await fetch(`${fake.url}/zoho-api/books/v3/contacts`, { method: "POST", headers: { "content-type": "application/json", authorization: "Zoho-oauthtoken token-1" }, body: JSON.stringify({ contact_name: "Gulf Fleet LLC" }) });
    const d = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: LINES })).body.document;
    await call(app, "POST", `/api/documents/${d.id}/issue`, owner, {});
    await run();
    expect(posts(fake, "invoices")[0]!.body).toMatchObject({ customer_id: "zc-1" });
  });

  it("token refresh", async () => {
    const { fake, issue, run } = await garage();
    await issue();
    fake.expireTokens();
    await run();
    expect(fake.calls.filter((c) => c.path.endsWith("/oauth/v2/token") && (c.body as Record<string, string>).grant_type === "refresh_token")).toHaveLength(1);
    expect(posts(fake, "invoices")).toHaveLength(1);
  });

  it("fromDate: earlier invoices aren't sent unless asked", async () => {
    const { app, owner, fake, issue, run } = await garage();
    const old = await issue();
    app.db.run("UPDATE documents SET issued_at = '2026-01-10T06:00:00.000Z' WHERE id = ?", [old.id]);
    await run();
    expect(posts(fake, "invoices")).toHaveLength(0);
    const c = await call(app, "POST", "/api/integrations/zoho/connect", owner, { clientId: "1000.ZC", clientSecret: "zoho-secret", region: "com", fromDate: "2026-01-01" });
    await authorize(app, c.body.authorizeUrl);
    await call(app, "PUT", "/api/integrations/zoho/mapping", owner, { taxId: "tax-5", items: { labour: "item-lab", part: "item-part", other: "item-oth" } });
    await run();
    expect(posts(fake, "invoices").map((x) => (x.body as { invoice_number: string }).invoice_number)).toEqual([old.number]);
  });
});
