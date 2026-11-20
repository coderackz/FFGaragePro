import { audit } from "../audit";
import { now as nowIso, type Db } from "../db";
import { getSecret, setSecret } from "../settings";

export const PROVIDERS = ["whatsapp", "zoho", "quickbooks"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<Provider, string> = { whatsapp: "WhatsApp Business API", zoho: "Zoho Books", quickbooks: "QuickBooks Online" };

/** Where each provider's API is: the real ones, or a fake server's in tests and the e2e. */
export interface Endpoints {
  graph: string;
  /** Has "{region}" in it: com, eu, in, com.au, sa. */
  zohoAccounts: string;
  quickbooksAuthorize: string;
  quickbooksToken: string;
  quickbooksApi: string;
  quickbooksSandboxApi: string;
}
export const REAL_ENDPOINTS: Endpoints = {
  graph: "https://graph.facebook.com/v21.0",
  zohoAccounts: "https://accounts.zoho.{region}",
  quickbooksAuthorize: "https://appcenter.intuit.com/connect/oauth2",
  quickbooksToken: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  quickbooksApi: "https://quickbooks.api.intuit.com",
  quickbooksSandboxApi: "https://sandbox-quickbooks.api.intuit.com",
};

/** Given to a garage's app where integrations run (the cloud; the dev server for the e2e). */
export interface IntegrationOptions {
  /** The address the garage's browser app and providers reach, e.g. https://garagepro.fleetfix.ae. */
  publicUrl: string;
  /** The cloud: callbacks and webhooks come in on /api/hooks/<code>/…; without it, straight on /api/integrations/…. */
  garageCode?: string;
  endpoints?: Partial<Endpoints>;
  fetch?: typeof fetch;
  /** Where the browser app is, to come back to after connecting (default: publicUrl; the dev web app is elsewhere). */
  appUrl?: string;
  /** Push and send on a timer of its own (the dev server); the cloud's outbox round does it otherwise. */
  ownLoopMs?: number;
}
export const endpointsOf = (o: IntegrationOptions): Endpoints => ({ ...REAL_ENDPOINTS, ...o.endpoints });
export const hookBase = (o: IntegrationOptions) =>
  o.garageCode ? `${o.publicUrl.replace(/\/$/, "")}/api/hooks/${o.garageCode}` : `${o.publicUrl.replace(/\/$/, "")}/api/integrations`;

/** Every provider's config holds a `label` (what the card shows: a number, an organization) and its secrets. */
export interface BaseConfig { label?: string | null; since?: string; needsSetup?: boolean }

export function getConfig<T>(db: Db, p: Provider): T | null {
  const raw = getSecret(db, `integration.${p}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface IntegrationStatus { [p: string]: { connected: boolean; label: string | null; since: string; needsSetup: boolean } | undefined }
const STATUS_KEY = "integration.status";

/** The non-secret status: kept as a plain setting so it syncs to PCs (the Send dialog asks it). */
export function statusOf(db: Db): IntegrationStatus {
  const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [STATUS_KEY]);
  try {
    return row ? (JSON.parse(row.value) as IntegrationStatus) : {};
  } catch {
    return {};
  }
}

/** Saves (or with null, removes) a provider's config, and the status row with it. Logged as "(changed)" only. */
export function saveConfig(db: Db, userId: string | null, p: Provider, cfg: (BaseConfig & Record<string, unknown>) | null, o: { quiet?: boolean } = {}): void {
  db.tx(() => {
    const before = getConfig<BaseConfig>(db, p);
    const value = cfg ? { ...cfg, since: cfg.since ?? before?.since ?? nowIso() } : null;
    setSecret(db, userId ?? "", `integration.${p}`, value ? JSON.stringify(value) : null, { silent: true });
    const status = statusOf(db);
    if (value && (value as { connected?: boolean }).connected !== false) {
      status[p] = { connected: true, label: (value.label as string | null) ?? null, since: value.since as string, needsSetup: !!value.needsSetup };
    } else delete status[p];
    db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [STATUS_KEY, JSON.stringify(status)]);
    if (!o.quiet && (!!before !== !!value || (before && value))) {
      audit(db, {
        action: "settings.change", entity: "settings", entityId: `integration.${p}`, before: null,
        after: { [p]: value ? (before ? "(changed)" : "(connected)") : "(disconnected)" }, userId,
      });
    }
  });
}

export const linked = (db: Db, p: Provider, kind: string, localId: string) =>
  db.get<{ e: string }>("SELECT external_id AS e FROM integration_links WHERE provider = ? AND kind = ? AND local_id = ?", [p, kind, localId])?.e ?? null;
export function link(db: Db, p: Provider, kind: string, localId: string, externalId: string): void {
  db.run("INSERT OR REPLACE INTO integration_links (provider, kind, local_id, external_id, created_at) VALUES (?, ?, ?, ?, ?)", [p, kind, localId, externalId, nowIso()]);
  clearFailure(db, p, kind, localId);
}

/** Minutes to wait after the 1st…5th failed push; after the 6th it waits for "Retry all". */
export const PUSH_RETRY_MINUTES = [1, 5, 30, 120, 360];
export function recordFailure(db: Db, p: Provider, kind: string, localId: string, label: string, error: string, now: Date): void {
  const prev = db.get<{ attempts: number }>("SELECT attempts FROM integration_failures WHERE provider = ? AND kind = ? AND local_id = ?", [p, kind, localId]);
  const attempts = (prev?.attempts ?? 0) + 1;
  const wait = PUSH_RETRY_MINUTES[attempts - 1];
  const next = wait === undefined ? null : new Date(now.getTime() + wait * 60_000).toISOString();
  db.run(
    `INSERT INTO integration_failures (provider, kind, local_id, label, attempts, next_attempt_at, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, kind, local_id) DO UPDATE SET label = excluded.label, attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at,
       error = excluded.error, updated_at = excluded.updated_at`,
    [p, kind, localId, label, attempts, next, error.slice(0, 500), now.toISOString()],
  );
}
export const clearFailure = (db: Db, p: Provider, kind: string, localId: string) =>
  db.run("DELETE FROM integration_failures WHERE provider = ? AND kind = ? AND local_id = ?", [p, kind, localId]);
/** A failed item that's due again: never tried since Retry all (attempts 0), or its wait is over. */
export const failureWaits = (db: Db, p: Provider, kind: string, localId: string, now: Date) => {
  const f = db.get<{ attempts: number; next_attempt_at: string | null }>(
    "SELECT attempts, next_attempt_at FROM integration_failures WHERE provider = ? AND kind = ? AND local_id = ?", [p, kind, localId],
  );
  if (!f || f.attempts === 0) return false;
  return f.next_attempt_at === null || f.next_attempt_at > now.toISOString();
};
export const retryAll = (db: Db, p: Provider) => db.run("UPDATE integration_failures SET attempts = 0, next_attempt_at = NULL WHERE provider = ?", [p]);
export const failuresOf = (db: Db) =>
  db.all<{ provider: string; label: string; error: string; attempts: number; next_attempt_at: string | null }>(
    "SELECT provider, label, error, attempts, next_attempt_at FROM integration_failures ORDER BY updated_at DESC LIMIT 100",
  ).map((f) => ({ provider: f.provider, label: f.label, error: f.error, attempts: f.attempts, nextAttemptAt: f.next_attempt_at }));
