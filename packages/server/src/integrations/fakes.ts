import Fastify from "fastify";
import type { Endpoints } from "./store";

/**
 * Stand-ins for Meta's Graph API, Zoho Books and QuickBooks Online, shaped like their documented REST APIs. Used by
 * the tests and by the dev server for the e2e (FFGP_FAKE_PROVIDERS=1). Never used against real garages.
 */
/** The access token the fake Graph API accepts. */
export const FAKE_WA_TOKEN = "EAAGfake000000000000000000good";

export interface FakeCall { method: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, unknown> }
export interface FakeProviders {
  url: string;
  endpoints: Endpoints;
  calls: FakeCall[];
  /** The next request whose path matches fails with this status and body. */
  failNext(path: RegExp, status: number, body: unknown): void;
  /** Access tokens issued so far stop working (the next call gets the provider's "expired" answer). */
  expireTokens(): void;
  close(): Promise<void>;
}

export async function startFakeProviders(port = 0): Promise<FakeProviders> {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))));
  const calls: FakeCall[] = [];
  const failures: { path: RegExp; status: number; body: unknown }[] = [];
  let tokenGen = 1;
  let n = 0;
  const id = (prefix: string) => `${prefix}${++n}`;
  const valid = () => `token-${tokenGen}`;
  const qboCustomers = new Map<string, string>();

  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    calls.push({ method: req.method, path, query: req.query as Record<string, string>, body: Buffer.isBuffer(req.body) ? req.body.toString("latin1") : req.body, headers: req.headers });
    const i = failures.findIndex((f) => f.path.test(path));
    if (i >= 0) {
      const f = failures.splice(i, 1)[0]!;
      return reply.status(f.status).send(f.body);
    }
    const auth = String(req.headers.authorization ?? "");
    if (path.startsWith("/graph/") && auth !== `Bearer ${FAKE_WA_TOKEN}`) {
      return reply.status(401).send({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } });
    }
    if (path.startsWith("/zoho-api/") && auth !== `Zoho-oauthtoken ${valid()}`) return reply.status(401).send({ code: 57, message: "You are not authorized to perform this operation" });
    if (path.startsWith("/qbo-api/") && auth !== `Bearer ${valid()}`) {
      return reply.status(401).send({ fault: { error: [{ message: "message=AuthenticationFailed", code: "3200" }], type: "AUTHENTICATION" } });
    }
  });

  // ── Meta Graph (WhatsApp Cloud API) ──
  app.get<{ Params: { phone: string } }>("/graph/:phone", async (req) => ({ id: req.params.phone, display_phone_number: "+971 4 000 0000", verified_name: "Al Quoz Auto Care" }));
  app.post("/graph/:phone/media", async () => ({ id: id("media-") }));
  app.post("/graph/:phone/messages", async () => ({ messaging_product: "whatsapp", contacts: [{ wa_id: "x" }], messages: [{ id: id("wamid.") }] }));

  // ── Zoho accounts (OAuth) and Books ──
  app.get<{ Params: { region: string }; Querystring: Record<string, string> }>("/zoho-accounts/:region/oauth/v2/auth", async (req, reply) =>
    reply.redirect(`${req.query.redirect_uri}?code=zoho-code&state=${encodeURIComponent(req.query.state ?? "")}&location=us`));
  app.post<{ Body: Record<string, string> }>("/zoho-accounts/:region/oauth/v2/token", async (req, reply) => {
    const b = req.body;
    if (b.grant_type === "authorization_code" && b.code !== "zoho-code") return reply.status(400).send({ error: "invalid_code" });
    if (b.grant_type === "refresh_token" && b.refresh_token !== "zoho-refresh") return reply.status(400).send({ error: "invalid_code" });
    return { access_token: valid(), ...(b.grant_type === "authorization_code" ? { refresh_token: "zoho-refresh" } : {}), expires_in: 3600, api_domain: `${base}/zoho-api`, token_type: "Bearer" };
  });
  app.get("/zoho-api/books/v3/organizations", async () => ({ code: 0, organizations: [{ organization_id: "org-1", name: "Al Quoz Auto Care LLC" }] }));
  app.get("/zoho-api/books/v3/settings/taxes", async () => ({ code: 0, taxes: [{ tax_id: "tax-5", tax_name: "VAT 5%", tax_percentage: 5 }, { tax_id: "tax-0", tax_name: "Zero rated", tax_percentage: 0 }] }));
  app.get("/zoho-api/books/v3/items", async () => ({ code: 0, items: [{ item_id: "item-lab", name: "Labour" }, { item_id: "item-part", name: "Parts" }, { item_id: "item-oth", name: "Other" }] }));
  const zohoContacts = new Map<string, string>();
  app.post<{ Body: { contact_name?: string } }>("/zoho-api/books/v3/contacts", async (req, reply) => {
    const name = req.body?.contact_name ?? "";
    if (zohoContacts.has(name)) return reply.status(400).send({ code: 3062, message: "The contact name already exists. Please specify a different name." });
    const cid = id("zc-");
    zohoContacts.set(name, cid);
    return { code: 0, contact: { contact_id: cid } };
  });
  app.get<{ Querystring: { contact_name?: string } }>("/zoho-api/books/v3/contacts", async (req) => {
    const cid = zohoContacts.get(req.query.contact_name ?? "");
    return { code: 0, contacts: cid ? [{ contact_id: cid, contact_name: req.query.contact_name }] : [] };
  });
  app.post("/zoho-api/books/v3/invoices", async () => ({ code: 0, invoice: { invoice_id: id("zi-") } }));
  app.post("/zoho-api/books/v3/creditnotes", async () => ({ code: 0, creditnote: { creditnote_id: id("zcn-") } }));
  app.post("/zoho-api/books/v3/creditnotes/:id/invoices", async () => ({ code: 0, message: "Credits have been applied to the invoice(s)." }));
  app.post("/zoho-api/books/v3/customerpayments", async () => ({ code: 0, payment: { payment_id: id("zp-") } }));

  // ── QuickBooks Online ──
  app.get<{ Querystring: Record<string, string> }>("/qbo-auth", async (req, reply) =>
    reply.redirect(`${req.query.redirect_uri}?code=qbo-code&state=${encodeURIComponent(req.query.state ?? "")}&realmId=9130`));
  app.post<{ Body: Record<string, string> }>("/qbo-token", async (req, reply) => {
    if (req.headers.authorization !== `Basic ${Buffer.from("qbo-client:qbo-secret").toString("base64")}`) return reply.status(401).send({ error: "invalid_client" });
    const b = req.body;
    if (b.grant_type === "authorization_code" && b.code !== "qbo-code") return reply.status(400).send({ error: "invalid_grant" });
    return { access_token: valid(), refresh_token: "qbo-refresh", expires_in: 3600, x_refresh_token_expires_in: 8_726_400, token_type: "bearer" };
  });
  for (const prefix of ["/qbo-api", "/qbo-sandbox"]) {
    app.get<{ Querystring: { query?: string } }>(`${prefix}/v3/company/:realm/query`, async (req) => {
      const q = req.query.query ?? "";
      if (/from TaxCode/i.test(q)) return { QueryResponse: { TaxCode: [{ Id: "5", Name: "SR Standard Rated (5%)" }, { Id: "6", Name: "ZR Zero Rated" }] } };
      if (/from Item/i.test(q)) return { QueryResponse: { Item: [{ Id: "11", Name: "Labour" }, { Id: "12", Name: "Parts" }, { Id: "13", Name: "Other" }] } };
      const name = /DisplayName = '(.*)'/i.exec(q)?.[1]?.replace(/\\'/g, "'");
      if (/from Customer/i.test(q)) return { QueryResponse: name && qboCustomers.has(name) ? { Customer: [{ Id: qboCustomers.get(name), DisplayName: name }] } : {} };
      return { QueryResponse: {} };
    });
    app.post<{ Body: { DisplayName?: string } }>(`${prefix}/v3/company/:realm/customer`, async (req, reply) => {
      const name = req.body?.DisplayName ?? "";
      if (qboCustomers.has(name)) return reply.status(400).send({ Fault: { Error: [{ Message: "Duplicate Name Exists Error", code: "6240" }], type: "ValidationFault" } });
      const cid = id("qc-");
      qboCustomers.set(name, cid);
      return { Customer: { Id: cid, DisplayName: name } };
    });
    app.post(`${prefix}/v3/company/:realm/invoice`, async () => ({ Invoice: { Id: id("qi-") } }));
    app.post(`${prefix}/v3/company/:realm/creditmemo`, async () => ({ CreditMemo: { Id: id("qcm-") } }));
    app.post(`${prefix}/v3/company/:realm/payment`, async () => ({ Payment: { Id: id("qp-") } }));
  }

  const address = await app.listen({ host: "127.0.0.1", port });
  const base = address.replace("localhost", "127.0.0.1");
  return {
    url: base,
    endpoints: {
      graph: `${base}/graph`,
      zohoAccounts: `${base}/zoho-accounts/{region}`,
      quickbooksAuthorize: `${base}/qbo-auth`,
      quickbooksToken: `${base}/qbo-token`,
      quickbooksApi: `${base}/qbo-api`,
      quickbooksSandboxApi: `${base}/qbo-sandbox`,
    },
    calls,
    failNext: (path, status, body) => void failures.push({ path, status, body }),
    expireTokens: () => void tokenGen++,
    close: () => app.close(),
  };
}
