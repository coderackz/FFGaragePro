import { randomBytes, timingSafeEqual } from "node:crypto";
import { dubaiDate } from "@ffgp/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { badRequest, notFound } from "../errors";
import { pushPending, type Pusher } from "./push";
import { clearFailures, endpointsOf, getConfig, hookBase, saveConfig, statusOf, timedFetch, updateConfig, type Endpoints, type IntegrationOptions } from "./store";
import { now as nowIso } from "../db";

export type AccountingProvider = "zoho" | "quickbooks";

/** A connected accounting app: the developer app's keys, the tokens, and what Fleetfix lines become there. */
export interface AccountingConfig {
  connected: boolean;
  /** When this connection was made: a later save checks it's still the same one. */
  since?: string;
  clientId: string;
  clientSecret: string;
  region?: string;
  sandbox?: boolean;
  fromDate: string;
  state?: string | null;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  apiDomain?: string;
  realmId?: string;
  organizationId?: string | null;
  mapping?: Mapping | null;
  label: string | null;
  needsSetup: boolean;
  lastPush?: { at: string; pushed: number; failed: number } | null;
}
export interface Mapping { taxId: string; zeroTaxId?: string | null; items: { labour: string; part: string; other: string } }
export interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number }

/** A provider's API, called with the current token; refreshed when it's (nearly) expired or refused once. */
export type Api = (method: string, path: string, o?: { query?: Record<string, string>; body?: unknown }) => Promise<any>;

export interface Adapter {
  provider: AccountingProvider;
  name: string;
  connectFields: z.ZodRawShape;
  authorizeUrl(cfg: AccountingConfig, e: Endpoints, redirectUri: string, state: string): string;
  exchange(cfg: AccountingConfig, e: Endpoints, http: typeof fetch, code: string, redirectUri: string, query: Record<string, string>): Promise<Tokens & Partial<AccountingConfig>>;
  refresh(cfg: AccountingConfig, e: Endpoints, http: typeof fetch): Promise<Tokens>;
  /** A request to the provider's API with this token (the caller retries once after a refresh on 401). */
  request(cfg: AccountingConfig, e: Endpoints, http: typeof fetch, token: string, method: string, path: string, o: { query?: Record<string, string>; body?: unknown }): Promise<Response>;
  /** Its error, worded for the card: "Zoho Books said: …". */
  error(res: Response): Promise<Error>;
  afterConnect(api: Api, cfg: AccountingConfig): Promise<Pick<AccountingConfig, "label" | "organizationId">>;
  options(api: Api, cfg: AccountingConfig): Promise<{ organizations?: { id: string; name: string }[]; taxes: { id: string; name: string }[]; items: { id: string; name: string }[] }>;
  pusher(api: Api, cfg: AccountingConfig & { mapping: Mapping }): Pusher;
}

const realDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const today = () => dubaiDate(new Date().toISOString());

/** Saved without an activity-log entry (the callback's intermediate steps). */
const quietSave = (db: Db, p: AccountingProvider, cfg: AccountingConfig) => saveConfig(db, null, p, cfg as unknown as Record<string, unknown>, { quiet: true });

/** The company links belong to: another Zoho organization, or QuickBooks company (the sandbox apart), starts afresh. */
export const accountOf = (cfg: Pick<AccountingConfig, "organizationId" | "realmId" | "sandbox">) =>
  cfg.realmId ? `${cfg.realmId}${cfg.sandbox ? ":sandbox" : ""}` : cfg.organizationId ?? "";

export function apiFor(db: Db, a: Adapter, o: IntegrationOptions): Api {
  const e = endpointsOf(o);
  const http = timedFetch(o);
  const refresh = async (cfg: AccountingConfig) => {
    const t = await a.refresh(cfg, e, http);
    const tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken ?? cfg.refreshToken, expiresAt: t.expiresAt };
    // Only into the same connection: disconnected meanwhile, the new token is dropped (and the call stops).
    if (!updateConfig(db, a.provider, cfg.since, tokens)) throw new Error(`${a.name} isn't connected`);
    return { ...cfg, ...tokens };
  };
  return async (method, path, req = {}) => {
    let cfg = getConfig<AccountingConfig>(db, a.provider);
    if (!cfg?.accessToken) throw new Error(`${a.name} isn't connected`);
    if ((cfg.expiresAt ?? 0) < Date.now() + 60_000) cfg = await refresh(cfg);
    let res = await a.request(cfg, e, http, cfg.accessToken!, method, path, req);
    if (res.status === 401) {
      cfg = await refresh(cfg);
      res = await a.request(cfg, e, http, cfg.accessToken!, method, path, req);
    }
    if (!res.ok) throw await a.error(res);
    return res.json();
  };
}

/** One push at a time per garage and provider: a "Send now" during the cloud's round waits for it, never runs alongside. */
const running = new WeakMap<Db, Map<string, Promise<{ more: boolean }>>>();

/** Pushes for one provider if it's connected and set up (a round's worth); the result is kept for the card. */
export function pushProvider(db: Db, a: Adapter, o: IntegrationOptions, now: Date): Promise<{ more: boolean }> {
  const mine = running.get(db) ?? running.set(db, new Map()).get(db)!;
  const busy = mine.get(a.provider);
  if (busy) return busy;
  const p = (async () => {
    const cfg = getConfig<AccountingConfig>(db, a.provider);
    if (!cfg?.connected || cfg.needsSetup || !cfg.mapping) return { more: false };
    const r = await pushPending(db, a.provider, a.pusher(apiFor(db, a, o), cfg as AccountingConfig & { mapping: Mapping }), now, cfg.fromDate, {
      account: accountOf(cfg), cap: o.perRound ?? 20,
    });
    if (r.pushed || r.failed || !cfg.lastPush) updateConfig(db, a.provider, cfg.since, { lastPush: { at: now.toISOString(), pushed: r.pushed, failed: r.failed } });
    return { more: r.more };
  })().finally(() => mine.delete(a.provider));
  mine.set(a.provider, p);
  return p;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:1.3rem">${esc(title)}</h1><p>${esc(text)}</p><p><a href="/#/settings/integrations">Back to Settings → Integrations</a></p></body>`;

/** Connect (OAuth 2), callback, lists for the mapping, the mapping itself, and "Send now". */
export function accountingRoutes(app: FastifyInstance, db: Db, o: IntegrationOptions, a: Adapter): void {
  const base = `/api/integrations/${a.provider}`;
  const redirectUri = () => `${hookBase(o)}/${a.provider}/callback`;
  const e = endpointsOf(o);
  const http = timedFetch(o);

  app.post(`${base}/connect`, async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "settings.manage");
    const input = z.object({
      clientId: z.string().trim().min(4, "Paste the client ID").max(200),
      clientSecret: z.string().trim().min(4, "Paste the client secret").max(400),
      fromDate: realDate.optional(),
      ...a.connectFields,
    }).parse(req.body) as { clientId: string; clientSecret: string; fromDate?: string; region?: string; sandbox?: boolean };
    const state = randomBytes(18).toString("hex");
    const cfg: AccountingConfig = {
      connected: false, since: nowIso(), clientId: input.clientId, clientSecret: input.clientSecret, region: input.region, sandbox: input.sandbox,
      fromDate: input.fromDate ?? today(), state, label: null, needsSetup: true,
    };
    saveConfig(db, user.id, a.provider, cfg as unknown as Record<string, unknown>);
    clearFailures(db, a.provider);
    return { authorizeUrl: a.authorizeUrl(cfg, e, redirectUri(), state), redirectUri: redirectUri() };
  });

  // The provider sends the browser back here: no session, so the one-time state is what proves it's ours.
  app.get<{ Querystring: Record<string, string> }>(`${base}/callback`, async (req, reply) => {
    const cfg = getConfig<AccountingConfig>(db, a.provider);
    const state = req.query.state ?? "";
    const expired = page(`${a.name}: not connected`, "That link has expired. Connect again from Settings → Integrations.");
    if (!cfg?.state || !state || !same(state, cfg.state)) return reply.status(400).type("text/html").send(expired);
    if (req.query.error || !req.query.code) {
      saveConfig(db, null, a.provider, { ...cfg, state: null } as unknown as Record<string, unknown>, { quiet: true });
      return reply.status(400).type("text/html").send(page(`${a.name}: not connected`, `${a.name} said: ${req.query.error_description ?? req.query.error ?? "no permission given"}.`));
    }
    let next: AccountingConfig;
    try {
      const t = await a.exchange(cfg, e, http, req.query.code, redirectUri(), req.query);
      next = { ...cfg, ...t, state: null, connected: true };
      quietSave(db, a.provider, next);
      next = { ...next, ...(await a.afterConnect(apiFor(db, a, o), next)), needsSetup: true };
    } catch (err) {
      saveConfig(db, null, a.provider, { ...cfg, state: null } as unknown as Record<string, unknown>, { quiet: true });
      return reply.status(400).type("text/html").send(page(`${a.name}: not connected`, (err as Error).message));
    }
    saveConfig(db, null, a.provider, next as unknown as Record<string, unknown>);
    return reply.redirect(`${(o.appUrl ?? o.publicUrl).replace(/\/$/, "")}/#/settings/integrations?connected=${a.provider}`);
  });

  const connected = () => {
    const cfg = getConfig<AccountingConfig>(db, a.provider);
    if (!cfg?.connected) throw notFound(`${a.name} isn't connected`);
    return cfg;
  };
  app.get(`${base}/options`, async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const cfg = connected();
    try {
      return { ...(await a.options(apiFor(db, a, o), cfg)), mapping: cfg.mapping ?? null, organizationId: cfg.organizationId ?? null, fromDate: cfg.fromDate, lastPush: cfg.lastPush ?? null };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });
  app.put(`${base}/mapping`, async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "settings.manage");
    const cfg = connected();
    // Zoho with several organizations: the organization first, then (with its taxes and items listed) the rest.
    const only = z.object({ organizationId: z.string().trim().min(1) }).strict().safeParse(req.body);
    if (only.success) {
      const orgs = (await a.options(apiFor(db, a, o), cfg)).organizations ?? [];
      const org = orgs.find((x) => x.id === only.data.organizationId);
      if (!org) throw badRequest("That organization isn't in this Zoho account");
      saveConfig(db, user.id, a.provider, { ...cfg, organizationId: org.id, label: org.name, mapping: null, needsSetup: true } as unknown as Record<string, unknown>);
      if (org.id !== cfg.organizationId) clearFailures(db, a.provider);
      return { status: statusOf(db) };
    }
    const m = z.object({
      organizationId: z.string().trim().min(1).optional(),
      taxId: z.string().trim().min(1, "Pick the VAT 5% tax"),
      zeroTaxId: z.string().trim().nullable().optional(),
      items: z.object({ labour: z.string().trim().min(1, "Pick an item for labour"), part: z.string().trim().min(1, "Pick an item for parts"), other: z.string().trim().min(1, "Pick an item for other lines") }),
    }).parse(req.body);
    const organizationId = m.organizationId ?? cfg.organizationId ?? null;
    if (a.provider === "zoho" && !organizationId) throw badRequest("Pick the Zoho Books organization");
    let label = cfg.label;
    if (m.organizationId && m.organizationId !== cfg.organizationId) {
      const orgs = (await a.options(apiFor(db, a, o), cfg)).organizations ?? [];
      label = orgs.find((x) => x.id === m.organizationId)?.name ?? label;
    }
    if (organizationId !== (cfg.organizationId ?? null)) clearFailures(db, a.provider);
    saveConfig(db, user.id, a.provider, { ...cfg, organizationId, label, mapping: { taxId: m.taxId, zeroTaxId: m.zeroTaxId ?? null, items: m.items }, needsSetup: false } as unknown as Record<string, unknown>);
    return { status: statusOf(db) };
  });
  app.post(`${base}/push`, async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    connected();
    await pushProvider(db, a, o, new Date());
    return { lastPush: getConfig<AccountingConfig>(db, a.provider)?.lastPush ?? null };
  });
}
