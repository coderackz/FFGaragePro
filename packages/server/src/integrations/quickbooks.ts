import { z } from "zod";
import type { Adapter, AccountingConfig, Mapping } from "./oauth";
import { providerLine, type PushDoc } from "./push";

const aed = (fils: number) => Math.round(fils) / 100;
const apiBase = (cfg: AccountingConfig, e: { quickbooksApi: string; quickbooksSandboxApi: string }) => (cfg.sandbox ? e.quickbooksSandboxApi : e.quickbooksApi);
const basic = (cfg: AccountingConfig) => `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
/** QuickBooks query language string: single quotes escaped. */
const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function token(http: typeof fetch, url: string, cfg: AccountingConfig, form: Record<string, string>) {
  const res = await http(url, {
    method: "POST", headers: { authorization: basic(cfg), accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const b = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !b.access_token) throw new Error(`QuickBooks said: ${b.error ?? `HTTP ${res.status}`}`);
  return b;
}

/** QuickBooks Online (Accounting API v3): customers, invoices, credit memos, payments. */
export const quickbooksAdapter: Adapter = {
  provider: "quickbooks",
  name: "QuickBooks Online",
  connectFields: { sandbox: z.boolean().default(false) },
  authorizeUrl: (cfg, e, redirectUri, state) =>
    `${e.quickbooksAuthorize}?${new URLSearchParams({ client_id: cfg.clientId, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: redirectUri, state })}`,
  async exchange(cfg, e, http, code, redirectUri, query) {
    if (!query.realmId) throw new Error("QuickBooks didn't say which company: connect again");
    const b = await token(http, e.quickbooksToken, cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
    return { accessToken: b.access_token!, refreshToken: b.refresh_token, expiresAt: Date.now() + (b.expires_in ?? 3600) * 1000, realmId: query.realmId };
  },
  async refresh(cfg, e, http) {
    const b = await token(http, e.quickbooksToken, cfg, { grant_type: "refresh_token", refresh_token: cfg.refreshToken ?? "" });
    return { accessToken: b.access_token!, refreshToken: b.refresh_token, expiresAt: Date.now() + (b.expires_in ?? 3600) * 1000 };
  },
  request(cfg, e, http, tok, method, path, o) {
    const qs = new URLSearchParams({ minorversion: "75", ...o.query }).toString();
    return http(`${apiBase(cfg, e)}/v3/company/${cfg.realmId}${path}?${qs}`, {
      method, headers: { authorization: `Bearer ${tok}`, accept: "application/json", ...(o.body ? { "content-type": "application/json" } : {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
  },
  async error(res) {
    const b = (await res.json().catch(() => null)) as { Fault?: { Error?: { Message?: string; Detail?: string; code?: string }[] }; fault?: { error?: { message?: string; code?: string }[] } } | null;
    const err = b?.Fault?.Error?.[0];
    const text = err?.Detail ?? err?.Message ?? b?.fault?.error?.[0]?.message ?? `HTTP ${res.status}`;
    return Object.assign(new Error(`QuickBooks said: ${text}`), { providerCode: err?.code ?? b?.fault?.error?.[0]?.code });
  },
  async afterConnect(api, cfg) {
    const b = (await api("GET", `/companyinfo/${cfg.realmId}`)) as { CompanyInfo?: { CompanyName?: string } };
    return { label: b.CompanyInfo?.CompanyName ?? `Company ${cfg.realmId}`, organizationId: null };
  },
  async options(api) {
    const list = async (entity: string) =>
      (((await api("GET", "/query", { query: { query: `select * from ${entity} maxresults 1000` } })) as { QueryResponse: Record<string, { Id: string; Name: string }[]> }).QueryResponse[entity] ?? [])
        .map((x) => ({ id: x.Id, name: x.Name }));
    return { taxes: await list("TaxCode"), items: await list("Item") };
  },
  pusher(api, cfg) {
    const m: Mapping = cfg.mapping;
    const lines = (d: PushDoc) => d.lines.map((l) => {
      const pl = providerLine(l);
      const tax = l.vatFils > 0 ? m.taxId : m.zeroTaxId;
      return {
        DetailType: "SalesItemLineDetail", Amount: aed(pl.quantity * pl.rateFils), Description: pl.description,
        SalesItemLineDetail: { ItemRef: { value: m.items[l.kind] }, Qty: pl.quantity, UnitPrice: aed(pl.rateFils), ...(tax ? { TaxCodeRef: { value: tax } } : {}) },
      };
    });
    const doc = (d: PushDoc, customerId: string) => ({
      CustomerRef: { value: customerId }, DocNumber: d.number.slice(0, 21), TxnDate: d.date, GlobalTaxCalculation: "TaxExcluded", Line: lines(d),
    });
    return {
      async customer(c) {
        try {
          const b = await api("POST", "/customer", {
            body: { DisplayName: c.name.slice(0, 500), CompanyName: c.name.slice(0, 100), ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}), ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}) },
          });
          return b.Customer.Id as string;
        } catch (e) {
          // "Duplicate Name Exists": the customer is already in QuickBooks; use that one.
          if ((e as { providerCode?: string }).providerCode !== "6240") throw e;
          const found = ((await api("GET", "/query", { query: { query: `select * from Customer where DisplayName = '${q(c.name)}'` } })).QueryResponse.Customer ?? []) as { Id: string }[];
          if (!found.length) throw e;
          return found[0]!.Id;
        }
      },
      async invoice(d, customerId) {
        const b = await api("POST", "/invoice", { body: { ...doc(d, customerId), ...(d.dueDate ? { DueDate: d.dueDate } : {}) } });
        return b.Invoice.Id as string;
      },
      async creditNote(d, customerId, inv) {
        const b = await api("POST", "/creditmemo", { body: { ...doc(d, customerId), PrivateNote: `Credit note for ${inv.number}` } });
        return b.CreditMemo.Id as string;
      },
      async payment(r, customerId, allocs) {
        const b = await api("POST", "/payment", {
          body: {
            CustomerRef: { value: customerId }, TotalAmt: aed(r.amountFils), TxnDate: r.date, PaymentRefNum: (r.reference ?? r.number).slice(0, 21),
            Line: allocs.map((x) => ({ Amount: aed(x.amountFils), LinkedTxn: [{ TxnId: x.invoiceExt, TxnType: "Invoice" }] })),
          },
        });
        return b.Payment.Id as string;
      },
    };
  },
};
