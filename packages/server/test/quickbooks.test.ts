import { afterEach, describe, expect, it } from "vitest";
import { call, makeApp, setUp, type App } from "./helpers";
import { startFakeProviders, type FakeProviders } from "../src/integrations/fakes";

const fakes: FakeProviders[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });
const LINES = [
  { kind: "labour", description: "Service", qty: 2, unitPriceFils: 5000, discountPct: 0 },
  { kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 3000, discountPct: 0 },
];

async function authorize(app: App, authorizeUrl: string) {
  const res = await fetch(authorizeUrl, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  return app.inject({ method: "GET", url: `${back.pathname}${back.search}` });
}
async function garage(sandbox = false) {
  const fake = await startFakeProviders();
  fakes.push(fake);
  const app = await makeApp(undefined, { integrations: { publicUrl: "https://cloud.test", endpoints: fake.endpoints } });
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC", email: "ap@gulffleet.ae", creditAllowed: true })).body.customer;
  const c = await call(app, "POST", "/api/integrations/quickbooks/connect", owner, { clientId: "qbo-client", clientSecret: "qbo-secret", sandbox });
  const back = await authorize(app, c.body.authorizeUrl);
  await call(app, "PUT", "/api/integrations/quickbooks/mapping", owner, { taxId: "5", zeroTaxId: "6", items: { labour: "11", part: "12", other: "13" } });
  const issue = async () => {
    const d = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: LINES })).body.document;
    return (await call(app, "POST", `/api/documents/${d.id}/issue`, owner, {})).body.document;
  };
  return { app, owner, fake, customer, issue, back, connect: c.body, run: () => app.integrations!.runOnce(new Date()) };
}
const posts = (fake: FakeProviders, what: string) => fake.calls.filter((c) => c.method === "POST" && c.path.endsWith(`/v3/company/9130/${what}`));

describe("QuickBooks Online", () => {
  it("connect with realm", async () => {
    const { app, owner, fake, back, connect } = await garage();
    const url = new URL(connect.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "qbo-client", response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: "https://cloud.test/api/integrations/quickbooks/callback" });
    expect(back.headers.location).toBe("https://cloud.test/#/settings/integrations?connected=quickbooks");
    const token = fake.calls.find((c) => c.path === "/qbo-token")!;
    expect(token.headers.authorization).toBe(`Basic ${Buffer.from("qbo-client:qbo-secret").toString("base64")}`);
    expect((await call(app, "GET", "/api/integrations", owner)).body.status.quickbooks).toMatchObject({ connected: true, label: "Al Quoz Auto Care LLC", needsSetup: false });
    const options = (await call(app, "GET", "/api/integrations/quickbooks/options", owner)).body;
    expect(options.taxes).toContainEqual({ id: "5", name: "SR Standard Rated (5%)" });
    expect(options.items).toContainEqual({ id: "11", name: "Labour" });
  });

  it("push invoice, credit memo, payment", async () => {
    const { app, owner, fake, issue, run } = await garage();
    const inv = await issue();
    await call(app, "POST", `/api/documents/${inv.id}/payments`, owner, { amountFils: 5000, method: "bank_transfer", reference: "TT-889" });
    const cn = (await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "Filter returned", lines: [{ lineId: inv.lines[1].id, qty: 1 }], returnToStock: false })).body.document;
    await run();
    expect(posts(fake, "customer")[0]!.body).toMatchObject({ DisplayName: "Gulf Fleet LLC", PrimaryEmailAddr: { Address: "ap@gulffleet.ae" } });
    const sent = posts(fake, "invoice")[0]!;
    expect(sent.query).toMatchObject({ minorversion: "75" });
    expect(sent.body).toMatchObject({
      CustomerRef: { value: "qc-1" }, DocNumber: inv.number, GlobalTaxCalculation: "TaxExcluded",
      Line: [
        { DetailType: "SalesItemLineDetail", Amount: 100, Description: "Service", SalesItemLineDetail: { ItemRef: { value: "11" }, Qty: 2, UnitPrice: 50, TaxCodeRef: { value: "5" } } },
        { DetailType: "SalesItemLineDetail", Amount: 30, Description: "Oil filter", SalesItemLineDetail: { ItemRef: { value: "12" }, Qty: 1, UnitPrice: 30, TaxCodeRef: { value: "5" } } },
      ],
    });
    expect(posts(fake, "creditmemo")[0]!.body).toMatchObject({ CustomerRef: { value: "qc-1" }, DocNumber: cn.number, Line: [{ Amount: 30, SalesItemLineDetail: { ItemRef: { value: "12" } } }] });
    expect(posts(fake, "payment")[0]!.body).toMatchObject({ CustomerRef: { value: "qc-1" }, TotalAmt: 50, PaymentRefNum: "TT-889", Line: [{ Amount: 50, LinkedTxn: [{ TxnId: "qi-2", TxnType: "Invoice" }] }] });
  });

  it("duplicate customer name links the existing one", async () => {
    const { fake, issue, run } = await garage();
    await fetch(`${fake.url}/qbo-api/v3/company/9130/customer`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token-1" }, body: JSON.stringify({ DisplayName: "Gulf Fleet LLC" }) });
    await issue();
    await run();
    expect(posts(fake, "invoice")[0]!.body).toMatchObject({ CustomerRef: { value: "qc-1" } });
  });

  it("sandbox uses the sandbox base", async () => {
    const { fake, issue, run } = await garage(true);
    await issue();
    await run();
    expect(fake.calls.some((c) => c.method === "POST" && c.path === "/qbo-sandbox/v3/company/9130/invoice")).toBe(true);
    expect(fake.calls.some((c) => c.path.startsWith("/qbo-api/"))).toBe(false);
  });
});
