import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";
import { Db, HttpError, newId, SCHEMA_VERSION, type NumberSource } from "@ffgp/server";
import { GARAGE_HEADER } from "@ffgp/shared";
import { recordIssues, applyAtPc, type SyncIssue } from "./apply";
import { installCapture, localChanges, maxSeq, removeCapture, type ChangeEntry } from "./capture";
import { licenceView, type LicenceView } from "./licence";
import { getState, numState, setState } from "./state";
import { trustedLink } from "./trust";

/** What a PC keeps (in its config) about the cloud garage it's linked to. */
export interface CloudLink {
  url: string;
  garageCode: string;
  deviceCode: string;
  deviceKey: string;
  publicKey: string;
}

export type SyncFailure = "offline" | "update_app" | "update_cloud" | "not_linked" | "error";
export type SyncResult = { ok: true; pushed: number; pulled: number; issues: number } | { ok: false; reason: SyncFailure; message: string };

export interface SyncStatus {
  linked: true;
  garageCode: string;
  deviceCode: string;
  lastSyncAt: string | null;
  /** This PC's changes the cloud hasn't got yet. */
  pending: number;
  licence: LicenceView;
  readOnly: boolean;
  /** Sync issues the owner hasn't dismissed. */
  issues: number;
  lastError: { reason: SyncFailure; message: string } | null;
}

const DEVICE_KEY_HEADER = "x-ffgp-device-key";
const NUMBERS_TIMEOUT_MS = 2000;
const PAGE = 500;

export class CloudError extends Error {
  constructor(readonly reason: SyncFailure | "refused", message: string, readonly status = 0) {
    super(message);
  }
}

/** One request to the cloud; network failures become `offline`, refusals carry the cloud's message and code. */
async function request<T>(f: typeof fetch, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ body: T; res: Response }> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : init.signal });
  } catch {
    throw new CloudError("offline", "Can't reach Fleetfix cloud. Changes are kept on this PC and will sync when it's back.");
  }
  if (res.ok) {
    const type = res.headers.get("content-type") ?? "";
    return { body: (type.includes("json") ? await res.json() : await res.arrayBuffer()) as T, res };
  }
  const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  const message = err.error ?? `Fleetfix cloud answered ${res.status}`;
  if (err.code === "update_app" || err.code === "update_cloud") throw new CloudError(err.code, message, res.status);
  if (err.code === "device_not_linked") throw new CloudError("not_linked", message, res.status);
  throw new CloudError("refused", message, res.status);
}

const base = (url: string) => url.replace(/\/+$/, "");
const garageHeaders = (garageCode: string, deviceKey?: string): Record<string, string> => ({
  [GARAGE_HEADER]: garageCode,
  ...(deviceKey ? { [DEVICE_KEY_HEADER]: deviceKey } : {}),
});

interface LinkReply {
  deviceCode: string;
  deviceKey: string;
  publicKey: string;
  licence: string;
  schema: number;
}

async function link(f: typeof fetch, url: string, garageCode: string, body: unknown): Promise<LinkReply> {
  const { body: reply } = await request<LinkReply>(f, `${base(url)}/api/cloud/sync/link`, {
    method: "POST",
    headers: { ...garageHeaders(garageCode), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (reply.schema !== SCHEMA_VERSION) {
    throw new CloudError(reply.schema > SCHEMA_VERSION ? "update_app" : "update_cloud", reply.schema > SCHEMA_VERSION ? "Update Fleetfix Garage Pro to keep syncing" : "Fleetfix cloud is being updated. Try again later.");
  }
  return reply;
}

/** Whether a garage file has a set-up garage in it (a download must never replace one). Unreadable counts as yes. */
function hasGarage(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'garage'").get();
      return !!table && !!db.prepare("SELECT 1 FROM garage").get();
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}

/**
 * A new PC joins a cloud garage: signs in, then the garage's whole database is written as `<dataDir>/garage.db`.
 * Call it before the PC's own server opens that file.
 */
export async function linkDownload(o: {
  url: string; garageCode: string; username: string; password: string; deviceName: string; dataDir: string; fetch?: typeof fetch;
  /** Licence keys built into the app, by cloud address: a server at that address with another key is refused. */
  pinned?: Record<string, string>;
}): Promise<CloudLink> {
  const f = o.fetch ?? fetch;
  const file = join(o.dataDir, "garage.db");
  if (hasGarage(file)) throw new CloudError("refused", "This PC already has a garage. Upload it to a new cloud garage instead (Settings → Fleetfix cloud).");
  const reply = await link(f, o.url, o.garageCode, { mode: "download", username: o.username, password: o.password, deviceName: o.deviceName });
  const linked = trustedLink({ url: base(o.url), garageCode: o.garageCode, deviceCode: reply.deviceCode, deviceKey: reply.deviceKey, publicKey: reply.publicKey }, o.pinned ?? {}, { linking: true });
  const { body, res } = await request<ArrayBuffer>(f, `${base(o.url)}/api/cloud/sync/snapshot`, { headers: garageHeaders(o.garageCode, reply.deviceKey) });
  mkdirSync(o.dataDir, { recursive: true });
  const temp = join(o.dataDir, `garage.download-${newId()}.db`);
  writeFileSync(temp, new Uint8Array(body));
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  renameSync(temp, file);
  const db = new Db(file);
  try {
    installCapture(db, "local");
    db.tx(() => {
      setState(db, "last_pulled_seq", String(Number(res.headers.get("x-ffgp-sync-seq") ?? 0)));
      setState(db, "last_pushed_seq", String(maxSeq(db)));
      setState(db, "licence", reply.licence);
    });
  } finally {
    db.close();
  }
  return linked;
}

/** An existing standalone PC garage moves into a new, empty cloud garage (with its setup code), losing nothing. */
export async function linkUpload(o: {
  url: string; garageCode: string; setupCode: string; deviceName: string; db: Db; fetch?: typeof fetch; pinned?: Record<string, string>;
}): Promise<CloudLink> {
  const f = o.fetch ?? fetch;
  const reply = await link(f, o.url, o.garageCode, { mode: "upload", setupCode: o.setupCode, deviceName: o.deviceName });
  const linked = trustedLink({ url: base(o.url), garageCode: o.garageCode, deviceCode: reply.deviceCode, deviceKey: reply.deviceKey, publicKey: reply.publicKey }, o.pinned ?? {}, { linking: true });
  const dir = join(o.db.raw.location() ?? ".", "..");
  const temp = join(dir, `garage.upload-${newId()}.db`);
  // Capture starts before the copy, so anything saved while the file is uploading is pushed afterwards.
  installCapture(o.db, "local");
  const uploadedUpTo = maxSeq(o.db);
  try {
    o.db.raw.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
    await request(f, `${base(o.url)}/api/cloud/sync/upload`, {
      method: "PUT",
      headers: { ...garageHeaders(o.garageCode, reply.deviceKey), "content-type": "application/octet-stream" },
      body: new Uint8Array(readFileSync(temp)),
    });
  } catch (error) {
    removeCapture(o.db);
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
  o.db.tx(() => {
    setState(o.db, "last_pushed_seq", String(uploadedUpTo));
    setState(o.db, "last_pulled_seq", "0");
    setState(o.db, "licence", reply.licence);
  });
  return linked;
}

/** A linked PC's side of sync: push its changes, pull the cloud's, keep the licence token. */
export class SyncClient {
  private running: Promise<SyncResult> | null = null;
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly getDb: () => Db;
  private lastError: SyncStatus["lastError"] = null;

  constructor(db: Db | (() => Db), readonly link: CloudLink, o: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.getDb = typeof db === "function" ? db : () => db;
    this.f = o.fetch ?? ((...args) => fetch(...args));
    this.now = o.now ?? Date.now;
  }

  private get db(): Db {
    return this.getDb();
  }

  private headers(json = false): Record<string, string> {
    return { ...garageHeaders(this.link.garageCode, this.link.deviceKey), ...(json ? { "content-type": "application/json" } : {}) };
  }

  /** One full sync; overlapping calls share the run in progress. */
  syncOnce(): Promise<SyncResult> {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<SyncResult> {
    const db = this.db;
    let pushed = 0;
    let pulled = 0;
    let issues = 0;
    try {
      // Push first: the cloud referees, then the pull brings back its verdict.
      for (;;) {
        const entries: ChangeEntry[] = localChanges(db, numState(db, "last_pushed_seq"), PAGE);
        if (!entries.length) break;
        const { body } = await request<{ issues: SyncIssue[]; licence: string }>(this.f, `${this.link.url}/api/cloud/sync/push`, {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ schema: SCHEMA_VERSION, entries }),
        });
        db.tx(() => {
          recordIssues(db, body.issues);
          setState(db, "licence", body.licence);
          setState(db, "last_pushed_seq", String(entries.at(-1)!.seq));
        });
        pushed += entries.length;
        issues += body.issues.length;
      }
      for (;;) {
        const since = numState(db, "last_pulled_seq");
        const issuesSince = numState(db, "last_issue_seq");
        const { body } = await request<{ entries: ChangeEntry[]; more: boolean; licence: string; issues?: SyncIssue[]; issuesSeq?: number }>(
          this.f,
          `${this.link.url}/api/cloud/sync/pull?since=${since}&limit=${PAGE}&schema=${SCHEMA_VERSION}&issuesSince=${issuesSince}`,
          { headers: this.headers() },
        );
        const result = applyAtPc(db, body.entries);
        db.tx(() => {
          // Issues the cloud recorded about this PC's changes (already known ones are stored once).
          recordIssues(db, body.issues ?? []);
          if (body.issuesSeq !== undefined) setState(db, "last_issue_seq", String(body.issuesSeq));
          setState(db, "licence", body.licence);
        });
        pulled += result.applied;
        issues += result.issues.length;
        if (!body.more || !body.entries.length) break;
      }
      setState(db, "last_sync_at", new Date(this.now()).toISOString());
      this.lastError = null;
      return { ok: true, pushed, pulled, issues };
    } catch (error) {
      const e = error instanceof CloudError ? error : new CloudError("error", (error as Error).message);
      const reason: SyncFailure = e.reason === "refused" ? "error" : e.reason;
      this.lastError = { reason, message: e.message };
      return { ok: false, reason, message: e.message };
    }
  }

  licence(): LicenceView {
    return licenceView(getState(this.db, "licence"), this.link.publicKey, this.now());
  }

  status(): SyncStatus {
    const db = this.db;
    const licence = this.licence();
    return {
      linked: true,
      garageCode: this.link.garageCode,
      deviceCode: this.link.deviceCode,
      lastSyncAt: getState(db, "last_sync_at") ?? null,
      pending: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM change_log WHERE origin = 'local' AND seq > ?", [numState(db, "last_pushed_seq")])!.n,
      licence,
      readOnly: licence.readOnly,
      issues: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_issues WHERE dismissed_at IS NULL")!.n,
      lastError: this.lastError,
    };
  }

  /** Numbers for the PC's server: the cloud's main series if it answers within 2 s, else this PC's own series. */
  numbers(): NumberSource {
    return {
      offlineSeries: this.link.deviceCode,
      next: async (kind) => {
        try {
          const { body } = await request<{ series: string; seq: number }>(this.f, `${this.link.url}/api/cloud/sync/numbers`, {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ kind }),
            timeoutMs: NUMBERS_TIMEOUT_MS,
          });
          return typeof body.seq === "number" ? { series: body.series ?? "", seq: body.seq } : null;
        } catch {
          return null;
        }
      },
    };
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALWAYS_ALLOWED = new Set(["/api/auth/login", "/api/auth/logout"]);

/** The PC's own read-only rule, the same as the cloud's: no writes (except signing in and out) while the licence says so. */
export function readOnlyGuard(client: SyncClient | (() => SyncClient | undefined)) {
  const get = typeof client === "function" ? client : () => client;
  return (req: FastifyRequest, route: string | undefined): void => {
    if (READ_METHODS.has(req.method) || (route && ALWAYS_ALLOWED.has(route))) return;
    const c = get();
    if (!c || !c.licence().readOnly) return;
    const l = c.licence();
    throw new HttpError(
      402,
      l.reason === "not_checked"
        ? "This PC hasn't reached Fleetfix cloud for 30 days. Connect to the internet to keep working; you can still view and print."
        : "This garage's subscription has ended. You can still view and print. Contact Fleet Fix to renew.",
      "read_only",
    );
  };
}
