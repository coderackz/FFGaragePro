import { afterEach, describe, expect, it } from "vitest";
import { call, makeApp, setUp, type App } from "./helpers";
import { startFakeProviders, type FakeProviders } from "../src/integrations/fakes";

const fakes: FakeProviders[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });
const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

async function authorize(app: App, authorizeUrl: string) {
  const res = await fetch(authorizeUrl, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  return app.inject({ method: "GET", url: `${back.pathname}${back.search}` });
}
async function garage(provider: "zoho" | "quickbooks" = "zoho", o: { sandbox?: boolean; timeoutMs?: number; perRound?: number } = {}) {
  const fake = await startFakeProviders();
  fakes.push(fake);
  const app = await makeApp(undefined, { integrations: { publicUrl: "https://cloud.test", endpoints: fake.endpoints, timeoutMs: o.timeoutMs, perRound: o.perRound } });
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC", creditAllowed: true })).body.customer;
  const connect = async (sandbox = o.sandbox ?? false) => {
    const body = provider === "zoho" ? { clientId: "1000.ZC", clientSecret: "zoho-secret", region: "com" } : { clientId: "qbo-client", clientSecret: "qbo-secret", sandbox };
    const c = await call(app, "POST", `/api/integrations/${provider}/connect`, owner, body);
    await authorize(app, c.body.authorizeUrl);
    await call(app, "PUT", `/api/integrations/${provider}/mapping`, owner, provider === "zoho"
      ? { taxId: "tax-5", items: { labour: "item-lab", part: "item-part", other: "item-oth" } }
      : { taxId: "5", items: { labour: "11", part: "12", other: "13" } });
  };
  await connect();
  const issue = async (lines: unknown[] = [LINE], pricesIncludeVat?: boolean) => {
    const d = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines, ...(pricesIncludeVat !== undefined ? { pricesIncludeVat } : {}) })).body.document;
    if (pricesIncludeVat !== undefined) {
      app.db.run("UPDATE documents SET prices_include_vat = ? WHERE id = ?", [pricesIncludeVat ? 1 : 0, d.id]);
      await call(app, "PUT", `/api/documents/${d.id}/lines`, owner, { lines });
    }
    return (await call(app, "POST", `/api/documents/${d.id}/issue`, owner, {})).body.document;
  };
  return { app, owner, fake, customer, issue, connect, run: (at = new Date()) => app.integrations!.runOnce(at) };
}
const posted = (fake: FakeProviders, re: RegExp) => fake.calls.filter((c) => c.method === "POST" && re.test(c.path));

describe("integrations review fixes", () => {
  it("C1: Send now while a round runs pushes once", async () => {
    const { app, owner, fake, issue, run } = await garage();
    await issue();
    await Promise.all([run(), call(app, "POST", "/api/integrations/zoho/push", owner, {}), run()]);
    expect(posted(fake, /\/books\/v3\/contacts$/)).toHaveLength(1);
    expect(posted(fake, /\/books\/v3\/invoices$/)).toHaveLength(1);
  });

  it("C2: receipts that can never go (paying invoices from before the start) don't block later ones", async () => {
    const { app, owner, fake, customer, run } = await garage();
    const old = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [{ ...LINE, unitPriceFils: 200000 }] })).body.document;
    await call(app, "POST", `/api/documents/${old.id}/issue`, owner, {});
    app.db.run("UPDATE documents SET issued_at = '2026-01-10T06:00:00.000Z' WHERE id = ?", [old.id]);
    const t = new Date().toISOString();
    for (let i = 0; i < 120; i++) {
      app.db.run("INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, received_at, created_at) VALUES (?, 'T', ?, ?, ?, 100, 'cash', ?, ?)", [`r-${i}`, i, `RT-${i}`, customer.id, t, t]);
      app.db.run("INSERT INTO receipt_allocations (id, receipt_id, document_id, amount_fils, created_at) VALUES (?, ?, ?, 100, ?)", [`a-${i}`, `r-${i}`, old.id, t]);
    }
    const later = new Date(Date.now() + 1000).toISOString();
    app.db.run("INSERT INTO receipts (id, series, seq, number, customer_id, amount_fils, method, received_at, created_at) VALUES ('r-new', 'T', 999, 'RT-NEW', ?, 5000, 'cash', ?, ?)", [customer.id, later, later]);
    await run();
    expect(posted(fake, /\/customerpayments$/).map((c) => (c.body as { reference_number: string }).reference_number)).toEqual(["RT-NEW"]);
  });

  it("I1: disconnecting while a push is running stays disconnected", async () => {
    const { app, owner, issue, run } = await garage();
    await issue();
    const pushing = run();
    await call(app, "POST", "/api/integrations/zoho/disconnect", owner, {});
    await pushing;
    expect((await call(app, "GET", "/api/integrations", owner)).body.status.zoho).toBeUndefined();
    expect(app.db.get("SELECT 1 AS x FROM settings WHERE key = 'secret.integration.zoho'")).toBeUndefined();
  });

  it("I2: links belong to one company — moving from the sandbox to the real company sends again", async () => {
    const { app, owner, fake, issue, connect, run } = await garage("quickbooks", { sandbox: true });
    await issue();
    await run();
    expect(posted(fake, /^\/qbo-sandbox\/.*\/invoice$/)).toHaveLength(1);
    await call(app, "POST", "/api/integrations/quickbooks/disconnect", owner, {});
    await connect(false);
    await call(app, "PUT", "/api/integrations/quickbooks/mapping", owner, { taxId: "5", items: { labour: "11", part: "12", other: "13" } });
    app.db.run("UPDATE settings SET value = json_set(value, '$.fromDate', '2020-01-01') WHERE key = 'secret.integration.quickbooks'");
    await run();
    expect(posted(fake, /^\/qbo-api\/.*\/customer$/)).toHaveLength(1);
    expect(posted(fake, /^\/qbo-api\/.*\/invoice$/)).toHaveLength(1);
  });

  it("I3: disconnecting clears its failures; nothing is left pending", async () => {
    const { app, owner, fake, issue, run } = await garage();
    await issue();
    fake.failNext(/\/books\/v3\/invoices$/, 400, { code: 1, message: "No" });
    await run();
    expect((await call(app, "GET", "/api/integrations", owner)).body.failures).toHaveLength(1);
    await call(app, "POST", "/api/integrations/zoho/disconnect", owner, {});
    expect((await call(app, "GET", "/api/integrations", owner)).body.failures).toEqual([]);
    expect(await run()).toEqual({ pending: false });
  });

  it("I4: a round sends a limited number, and a provider that hangs times out", async () => {
    const { fake, issue, run } = await garage("zoho", { perRound: 3, timeoutMs: 300 });
    for (let i = 0; i < 5; i++) await issue();
    expect(await run()).toEqual({ pending: true });
    expect(posted(fake, /\/books\/v3\/invoices$/)).toHaveLength(3);
    await run();
    expect(posted(fake, /\/books\/v3\/invoices$/)).toHaveLength(5);
    await issue();
    fake.hangNext(/\/books\/v3\/invoices$/);
    const t0 = Date.now();
    await run();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("I5: a document with prices including VAT goes as tax-inclusive (Zoho and QuickBooks)", async () => {
    const z = await garage("zoho");
    await z.issue([{ ...LINE, unitPriceFils: 10531 }], true);
    await z.run();
    expect(posted(z.fake, /\/books\/v3\/invoices$/)[0]!.body).toMatchObject({ is_inclusive_tax: true, line_items: [{ rate: 105.31, quantity: 1 }] });
    const q = await garage("quickbooks");
    await q.issue([{ ...LINE, unitPriceFils: 10531 }], true);
    await q.run();
    expect(posted(q.fake, /\/invoice$/)[0]!.body).toMatchObject({
      GlobalTaxCalculation: "TaxInclusive",
      Line: [{ Amount: 100.3, SalesItemLineDetail: { Qty: 1, UnitPrice: 100.3, TaxInclusiveAmt: 105.31 } }],
    });
  });

  it("I6: Zoho invoices are marked sent; credit notes opened before they're applied", async () => {
    const { app, owner, fake, issue, run } = await garage();
    const inv = await issue();
    await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "Goodwill", returnToStock: false });
    await run();
    const paths = fake.calls.filter((c) => c.method === "POST").map((c) => c.path.replace(/^\/zoho-api\/books\/v3/, ""));
    expect(paths).toContain("/invoices/zi-2/status/sent");
    expect(paths.indexOf("/creditnotes/zcn-3/status/open")).toBeLessThan(paths.indexOf("/creditnotes/zcn-3/invoices"));
    expect(paths.indexOf("/creditnotes/zcn-3/status/open")).toBeGreaterThan(-1);
  });

  it("I7: an invoice with nothing charged isn't sent and doesn't fail", async () => {
    const { app, owner, fake, customer, run } = await garage();
    const d = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [{ ...LINE, kind: "part", suppliedBy: "fleetfix" }, LINE] })).body.document;
    await call(app, "POST", `/api/documents/${d.id}/issue`, owner, {});
    app.db.run("UPDATE document_lines SET net_fils = 0, vat_fils = 0, gross_fils = 0 WHERE document_id = ?", [d.id]);
    await run();
    expect(posted(fake, /\/books\/v3\/invoices$/)).toHaveLength(0);
    expect((await call(app, "GET", "/api/integrations", owner)).body.failures).toEqual([]);
  });
});
