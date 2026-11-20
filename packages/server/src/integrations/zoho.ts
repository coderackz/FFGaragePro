import { z } from "zod";
import type { Adapter, AccountingConfig, Mapping } from "./oauth";
import { providerLine, type PushDoc } from "./push";

const accounts = (cfg: AccountingConfig, base: string) => base.replace("{region}", cfg.region ?? "com");
const MODES: Record<string, string> = { cash: "cash", card: "creditcard", bank_transfer: "banktransfer", cheque: "check" };
const aed = (fils: number) => Math.round(fils) / 100;

async function token(http: typeof fetch, url: string, form: Record<string, string>) {
  const res = await http(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const b = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; api_domain?: string; error?: string };
  if (!res.ok || !b.access_token) throw new Error(`Zoho said: ${b.error ?? `HTTP ${res.status}`}`);
  return b;
}

/** Zoho Books (v3 API): contacts, invoices, credit notes (applied to their invoice), customer payments. */
export const zohoAdapter: Adapter = {
  provider: "zoho",
  name: "Zoho Books",
  connectFields: { region: z.enum(["com", "eu", "in", "com.au", "sa", "jp", "ca"]).default("com") },
  authorizeUrl: (cfg, e, redirectUri, state) =>
    `${accounts(cfg, e.zohoAccounts)}/oauth/v2/auth?${new URLSearchParams({
      scope: "ZohoBooks.fullaccess.all", client_id: cfg.clientId, response_type: "code", redirect_uri: redirectUri, access_type: "offline", prompt: "consent", state,
    })}`,
  async exchange(cfg, e, http, code, redirectUri) {
    const b = await token(http, `${accounts(cfg, e.zohoAccounts)}/oauth/v2/token`, {
      grant_type: "authorization_code", client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, code,
    });
    return { accessToken: b.access_token!, refreshToken: b.refresh_token, expiresAt: Date.now() + (b.expires_in ?? 3600) * 1000, apiDomain: b.api_domain };
  },
  async refresh(cfg, e, http) {
    const b = await token(http, `${accounts(cfg, e.zohoAccounts)}/oauth/v2/token`, {
      grant_type: "refresh_token", client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken ?? "",
    });
    return { accessToken: b.access_token!, expiresAt: Date.now() + (b.expires_in ?? 3600) * 1000 };
  },
  request(cfg, _e, http, tok, method, path, o) {
    const query = new URLSearchParams({ ...(cfg.organizationId && !path.endsWith("/organizations") ? { organization_id: cfg.organizationId } : {}), ...o.query });
    const qs = query.toString();
    return http(`${cfg.apiDomain}/books/v3${path}${qs ? `?${qs}` : ""}`, {
      method, headers: { authorization: `Zoho-oauthtoken ${tok}`, ...(o.body ? { "content-type": "application/json" } : {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
  },
  async error(res) {
    const b = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
    return Object.assign(new Error(`Zoho Books said: ${b?.message ?? `HTTP ${res.status}`}`), { providerCode: b?.code });
  },
  async afterConnect(api) {
    const orgs = ((await api("GET", "/organizations")) as { organizations: { organization_id: string; name: string }[] }).organizations;
    return orgs.length === 1 ? { organizationId: orgs[0]!.organization_id, label: orgs[0]!.name } : { organizationId: null, label: "Choose the organization" };
  },
  async options(api, cfg) {
    const organizations = ((await api("GET", "/organizations")) as { organizations: { organization_id: string; name: string }[] }).organizations
      .map((x) => ({ id: x.organization_id, name: x.name }));
    if (!cfg.organizationId) return { organizations, taxes: [], items: [] };
    const taxes = ((await api("GET", "/settings/taxes")) as { taxes: { tax_id: string; tax_name: string }[] }).taxes.map((t) => ({ id: t.tax_id, name: t.tax_name }));
    const items = ((await api("GET", "/items")) as { items: { item_id: string; name: string }[] }).items.map((i) => ({ id: i.item_id, name: i.name }));
    return { organizations, taxes, items };
  },
  pusher(api, cfg) {
    const m: Mapping = cfg.mapping;
    const lines = (d: PushDoc) => d.lines.map((l) => {
      const pl = providerLine(l);
      const tax = l.vatFils > 0 ? m.taxId : m.zeroTaxId;
      return { item_id: m.items[l.kind], description: pl.description, quantity: pl.quantity, rate: aed(pl.rateFils), ...(tax ? { tax_id: tax } : {}) };
    });
    return {
      async customer(c) {
        try {
          const b = await api("POST", "/contacts", { body: { contact_name: c.name, company_name: c.name, contact_type: "customer", ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}) } });
          return b.contact.contact_id as string;
        } catch (e) {
          // Already in Zoho under the same name (a garage moving its books): use that contact.
          if ((e as { providerCode?: number }).providerCode !== 3062) throw e;
          const found = (await api("GET", "/contacts", { query: { contact_name: c.name } })).contacts as { contact_id: string }[];
          if (!found.length) throw e;
          return found[0]!.contact_id;
        }
      },
      async invoice(d, customerId) {
        const b = await api("POST", "/invoices", {
          query: { ignore_auto_number_generation: "true" },
          body: { customer_id: customerId, invoice_number: d.number, date: d.date, ...(d.dueDate ? { due_date: d.dueDate } : {}), ...(d.reference ? { reference_number: d.reference } : {}), is_inclusive_tax: false, line_items: lines(d) },
        });
        return b.invoice.invoice_id as string;
      },
      async creditNote(d, customerId, inv) {
        const b = await api("POST", "/creditnotes", {
          query: { ignore_auto_number_generation: "true" },
          body: { customer_id: customerId, creditnote_number: d.number, date: d.date, reference_number: inv.number, is_inclusive_tax: false, line_items: lines(d) },
        });
        const id = b.creditnote.creditnote_id as string;
        // Applied to its invoice, as in Fleetfix. The credit note exists either way: a refusal here isn't retried
        // (that would make a second credit note); it stays as customer credit in Zoho.
        try {
          await api("POST", `/creditnotes/${id}/invoices`, { body: { invoices: [{ invoice_id: inv.ext, amount_applied: aed(d.grossFils) }] } });
        } catch (e) {
          console.error(`Zoho Books: credit note ${d.number} not applied to ${inv.number}:`, (e as Error).message);
        }
        return id;
      },
      async payment(r, customerId, allocs) {
        const b = await api("POST", "/customerpayments", {
          body: {
            customer_id: customerId, payment_mode: MODES[r.method] ?? "cash", amount: aed(r.amountFils), date: r.date, reference_number: r.reference ?? r.number,
            invoices: allocs.map((x) => ({ invoice_id: x.invoiceExt, amount_applied: aed(x.amountFils) })),
          },
        });
        return b.payment.payment_id as string;
      },
    };
  },
};
