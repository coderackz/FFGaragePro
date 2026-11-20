import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { buildApp, Db, SCHEMA_VERSION } from "@ffgp/server";
import { installCapture, localChanges, verifyLicence } from "@ffgp/sync";
import { api, garageReady, SETUP, startCloud } from "./helpers";

// Each test runs a real cloud and a PC garage (password hashing, file copies): slow on Windows CI runners.
// A cloud and a PC per test, each garage built through every migration: Windows CI runners need well over 30 s.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

async function raw(url: string, method: string, path: string, headers: Record<string, string>, body?: Uint8Array) {
  return fetch(url + path, { method, headers, body: body as BodyInit | undefined });
}

async function link(url: string, garage: string, body: unknown) {
  return api(url, "POST", "/api/cloud/sync/link", { garage, body });
}

const dev = (garage: string, key: string) => ({ "x-ffgp-garage": garage, "x-ffgp-device-key": key });

async function jsonCall(url: string, method: string, path: string, garage: string, key: string, body?: unknown) {
  const res = await fetch(url + path, {
    method,
    headers: { ...dev(garage, key), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A standalone PC garage's database file, with a customer. */
async function pcGarageFile(o: { sharing?: boolean } = {}): Promise<{ file: Uint8Array; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "ffgp-pc-"));
  const app = await buildApp({ dataDir: dir });
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { garage: { name: "PC Garage" }, owner: { name: "Pc Owner", username: "pcowner", password: "pc-pass-123" } } });
  const token = setup.json().token;
  await app.inject({ method: "POST", url: "/api/customers", headers: { authorization: `Bearer ${token}` }, payload: { name: "From the PC" } });
  app.db.run("INSERT INTO settings (key, value) VALUES ('invoice.note', 'kept')");
  if (o.sharing) app.db.run("INSERT INTO settings (key, value) VALUES ('network.sharing', '1')");
  const out = join(dir, "copy.db");
  app.db.raw.exec(`VACUUM INTO '${out}'`);
  await app.close();
  return { file: readFileSync(out), close: async () => {} };
}

describe("cloud sync API", () => {
  it("download link needs a real user", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    expect((await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: "wrong-pass-1", deviceName: "Front desk" })).status).toBe(401);
    const a = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "Front desk" });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ deviceCode: "P1", schema: SCHEMA_VERSION });
    expect(a.body.deviceKey).toEqual(expect.any(String));
    const b = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "Workshop" });
    expect(b.body.deviceCode).toBe("P2");
    // A garage that isn't set up has nothing to download.
    cloud.admin.createGarage({ code: "empty-garage", name: "Empty", notes: null, now: Date.now() });
    expect((await link(cloud.url, "empty-garage", { mode: "download", username: "rashid", password: "x-pass-123", deviceName: "PC" })).status).toBe(409);
  });

  it("only an owner can link a PC", async () => {
    const cloud = await startCloud();
    const { token } = await garageReady(cloud, "alquoz-auto");
    await api(cloud.url, "POST", "/api/users", { garage: "alquoz-auto", token, body: { name: "Advisor", username: "adv", role: "advisor", password: "advisor-pass-1" } });
    const res = await link(cloud.url, "alquoz-auto", { mode: "download", username: "adv", password: "advisor-pass-1", deviceName: "PC" });
    expect(res.status).toBe(403);
  });

  it("upload link needs the setup code and an empty garage", async () => {
    const cloud = await startCloud();
    const g = cloud.admin.createGarage({ code: "new-garage", name: "New", notes: null, now: Date.now() });
    expect((await link(cloud.url, "new-garage", { mode: "upload", setupCode: "WRONG123", deviceName: "PC" })).status).toBe(403);
    expect((await link(cloud.url, "new-garage", { mode: "upload", setupCode: g.setup_code, deviceName: "PC" })).status).toBe(200);
    await garageReady(cloud, "set-up-garage");
    const setUp = cloud.admin.garageByCode("set-up-garage")!;
    expect((await link(cloud.url, "set-up-garage", { mode: "upload", setupCode: setUp.setup_code, deviceName: "PC" })).status).toBe(409);
  });

  it("snapshot is a working garage database", async () => {
    const cloud = await startCloud();
    const { token } = await garageReady(cloud, "alquoz-auto");
    await api(cloud.url, "POST", "/api/customers", { garage: "alquoz-auto", token, body: { name: "Browser Customer" } });
    const l = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" });
    const res = await raw(cloud.url, "GET", "/api/cloud/sync/snapshot", dev("alquoz-auto", l.body.deviceKey));
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("x-ffgp-sync-seq"))).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "ffgp-snap-"));
    writeFileSync(join(dir, "garage.db"), new Uint8Array(await res.arrayBuffer()));
    const db = new Db(join(dir, "garage.db"));
    try {
      expect(db.get("SELECT name FROM customers")).toEqual({ name: "Browser Customer" });
      // Cloud sessions and the cloud's log stay in the cloud.
      expect(db.all("SELECT 1 FROM sessions")).toHaveLength(0);
      expect(db.all("SELECT 1 FROM change_log")).toHaveLength(0);
      expect(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger'")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("upload replaces the empty garage; browser sign-in then works with the PC's users", async () => {
    const cloud = await startCloud();
    const g = cloud.admin.createGarage({ code: "pc-garage", name: "PC Garage", notes: null, now: Date.now() });
    const l = await link(cloud.url, "pc-garage", { mode: "upload", setupCode: g.setup_code, deviceName: "PC" });
    const pc = await pcGarageFile();
    const up = await raw(cloud.url, "PUT", "/api/cloud/sync/upload", { ...dev("pc-garage", l.body.deviceKey), "content-type": "application/octet-stream" }, pc.file);
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ seq: 0 });
    const login = await api(cloud.url, "POST", "/api/auth/login", { garage: "pc-garage", body: { username: "pcowner", password: "pc-pass-123" } });
    expect(login.status).toBe(200);
    const customers = await api(cloud.url, "GET", "/api/customers", { garage: "pc-garage", token: login.body.token });
    expect(customers.body.customers.map((c: { name: string }) => c.name)).toEqual(["From the PC"]);
    expect(cloud.admin.garageByCode("pc-garage")!.setup_code).toBeNull();
    // Only once: the garage is set up now.
    const again = await raw(cloud.url, "PUT", "/api/cloud/sync/upload", { ...dev("pc-garage", l.body.deviceKey), "content-type": "application/octet-stream" }, pc.file);
    expect(again.status).toBe(409);
  });

  it("this PC's network sharing settings never travel through the cloud", async () => {
    const cloud = await startCloud();
    const g = cloud.admin.createGarage({ code: "pc-garage", name: "PC Garage", notes: null, now: Date.now() });
    const l = await link(cloud.url, "pc-garage", { mode: "upload", setupCode: g.setup_code, deviceName: "Main PC" });
    const pc = await pcGarageFile({ sharing: true });
    expect((await raw(cloud.url, "PUT", "/api/cloud/sync/upload", { ...dev("pc-garage", l.body.deviceKey), "content-type": "application/octet-stream" }, pc.file)).status).toBe(200);
    const second = await link(cloud.url, "pc-garage", { mode: "download", username: "pcowner", password: "pc-pass-123", deviceName: "Second PC" });
    const snap = await raw(cloud.url, "GET", "/api/cloud/sync/snapshot", dev("pc-garage", second.body.deviceKey));
    const dir = mkdtempSync(join(tmpdir(), "ffgp-snap-"));
    writeFileSync(join(dir, "garage.db"), new Uint8Array(await snap.arrayBuffer()));
    const db = new Db(join(dir, "garage.db"));
    try {
      expect(db.all("SELECT key FROM settings WHERE key LIKE 'network.%'")).toEqual([]);
      expect(db.get("SELECT value FROM settings WHERE key = 'invoice.note'")).toEqual({ value: "kept" });
    } finally {
      db.close();
    }
  });

  it("two uploads into the same empty garage: one wins, the other is refused", async () => {
    const cloud = await startCloud();
    const g = cloud.admin.createGarage({ code: "pc-garage", name: "PC Garage", notes: null, now: Date.now() });
    const a = await link(cloud.url, "pc-garage", { mode: "upload", setupCode: g.setup_code, deviceName: "PC A" });
    const b = await link(cloud.url, "pc-garage", { mode: "upload", setupCode: g.setup_code, deviceName: "PC B" });
    const file = (await pcGarageFile()).file;
    const up = (key: string) => raw(cloud.url, "PUT", "/api/cloud/sync/upload", { ...dev("pc-garage", key), "content-type": "application/octet-stream" }, file);
    const statuses = (await Promise.all([up(a.body.deviceKey), up(b.body.deviceKey)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("pushed changes must be well formed", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    const l = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" });
    const entry = { seq: 1, origin: "local", originSeq: 1, table: "customers", rowId: "x", op: "insert", data: {}, changed: null, at: new Date().toISOString() };
    const push = (entries: unknown[]) => jsonCall(cloud.url, "POST", "/api/cloud/sync/push", "alquoz-auto", l.body.deviceKey, { schema: SCHEMA_VERSION, entries });
    expect((await push([{ ...entry, table: "sessions" }])).status).toBe(400);
    expect((await push([{ ...entry, originSeq: 1e300 }])).status).toBe(400);
    expect((await push([{ ...entry, originSeq: 5 }])).status).toBe(400);
    expect((await push([{ ...entry, op: "drop" }])).status).toBe(400);
  });

  it("device codes stay unique even after a device row is removed", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    const body = { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" };
    await link(cloud.url, "alquoz-auto", body);
    await link(cloud.url, "alquoz-auto", body);
    cloud.admin.raw.prepare("DELETE FROM devices WHERE device_code = 'P1'").run();
    const third = await link(cloud.url, "alquoz-auto", body);
    expect(third.status).toBe(200);
    expect(third.body.deviceCode).toBe("P3");
  });

  it("push/pull round trip, own entries excluded", async () => {
    const cloud = await startCloud();
    const { token } = await garageReady(cloud, "alquoz-auto");
    const l = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" });
    const key = l.body.deviceKey;
    // The browser adds one customer; the PC pushes another.
    await api(cloud.url, "POST", "/api/customers", { garage: "alquoz-auto", token, body: { name: "Browser" } });
    const dir = mkdtempSync(join(tmpdir(), "ffgp-pcdb-"));
    const snap = await raw(cloud.url, "GET", "/api/cloud/sync/snapshot", dev("alquoz-auto", key));
    writeFileSync(join(dir, "garage.db"), new Uint8Array(await snap.arrayBuffer()));
    const since = Number(snap.headers.get("x-ffgp-sync-seq"));
    const pcDb = new Db(join(dir, "garage.db"));
    installCapture(pcDb, "local");
    const t = new Date().toISOString();
    pcDb.run("INSERT INTO customers (id, kind, name, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'individual', 'From PC', ?, ?)", [t, t]);
    const push = await jsonCall(cloud.url, "POST", "/api/cloud/sync/push", "alquoz-auto", key, { schema: SCHEMA_VERSION, entries: localChanges(pcDb, 0) });
    pcDb.close();
    expect(push.status).toBe(200);
    expect(push.body).toMatchObject({ lastOriginSeq: expect.any(Number), issues: [] });
    expect(verifyLicence(l.body.publicKey, push.body.licence)).toMatchObject({ garageCode: "alquoz-auto", state: "trial" });
    const customers = await api(cloud.url, "GET", "/api/customers", { garage: "alquoz-auto", token });
    expect(customers.body.customers.map((c: { name: string }) => c.name).sort()).toEqual(["Browser", "From PC"]);
    const pull = await jsonCall(cloud.url, "GET", `/api/cloud/sync/pull?since=${since}&schema=${SCHEMA_VERSION}`, "alquoz-auto", key);
    expect(pull.status).toBe(200);
    expect(pull.body.more).toBe(false);
    const names = pull.body.entries.filter((e: { table: string }) => e.table === "customers").map((e: { data: { name: string } }) => e.data.name);
    expect(names).toEqual([]);
    const all = await jsonCall(cloud.url, "GET", `/api/cloud/sync/pull?since=0&schema=${SCHEMA_VERSION}`, "alquoz-auto", key);
    expect(all.body.entries.some((e: { origin: string }) => e.origin === "P1")).toBe(false);
    expect(cloud.admin.garageByCode("alquoz-auto")!.last_sync_at).not.toBeNull();
  });

  it("schema mismatch → 409 update_app", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    const l = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" });
    const older = await jsonCall(cloud.url, "POST", "/api/cloud/sync/push", "alquoz-auto", l.body.deviceKey, { schema: SCHEMA_VERSION - 1, entries: [] });
    expect(older.status).toBe(409);
    expect(older.body.code).toBe("update_app");
    const newer = await jsonCall(cloud.url, "GET", `/api/cloud/sync/pull?since=0&schema=${SCHEMA_VERSION + 1}`, "alquoz-auto", l.body.deviceKey);
    expect(newer.body.code).toBe("update_cloud");
  });

  it("licence token verifies with the returned public key; tampering fails", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    const l = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" });
    const payload = verifyLicence(l.body.publicKey, l.body.licence);
    expect(payload).toMatchObject({ garageCode: "alquoz-auto", state: "trial", endsAt: expect.any(String), graceEndsAt: expect.any(String), checkedAt: expect.any(String) });
    const [body, sig] = l.body.licence.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, endsAt: "2099-01-01T00:00:00.000Z" })).toString("base64url");
    expect(verifyLicence(l.body.publicKey, `${forged}.${sig}`)).toBeNull();
    expect(verifyLicence(l.body.publicKey, `${body}.${sig}x`)).toBeNull();
    expect(verifyLicence(l.body.publicKey, "garbage")).toBeNull();
  });

  it("the licence public key is published, the same one each link returns", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    const published = await api(cloud.url, "GET", "/api/cloud/licence-key");
    const l = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" });
    expect(published.status).toBe(200);
    expect(published.body.publicKey).toBe(l.body.publicKey);
    expect(published.body.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });

  it("revoked device → 401", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    const l = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" });
    const ok = await jsonCall(cloud.url, "GET", `/api/cloud/sync/pull?since=0&schema=${SCHEMA_VERSION}`, "alquoz-auto", l.body.deviceKey);
    expect(ok.status).toBe(200);
    cloud.admin.revokeDevice(cloud.admin.garageByCode("alquoz-auto")!.id, "P1", Date.now());
    const no = await jsonCall(cloud.url, "GET", `/api/cloud/sync/pull?since=0&schema=${SCHEMA_VERSION}`, "alquoz-auto", l.body.deviceKey);
    expect(no.status).toBe(401);
    expect(no.body.code).toBe("device_not_linked");
    // A key from another garage doesn't open this one either.
    await garageReady(cloud, "other-garage");
    const other = await jsonCall(cloud.url, "GET", `/api/cloud/sync/pull?since=0&schema=${SCHEMA_VERSION}`, "other-garage", l.body.deviceKey);
    expect(other.status).toBe(401);
  });

  it("numbers come from the cloud's main series and continue after browser-created invoices", async () => {
    const cloud = await startCloud();
    const { token } = await garageReady(cloud, "alquoz-auto");
    const l = await link(cloud.url, "alquoz-auto", { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" });
    const c = (await api(cloud.url, "POST", "/api/customers", { garage: "alquoz-auto", token, body: { name: "A" } })).body.customer;
    const inv = await api(cloud.url, "POST", "/api/documents", {
      garage: "alquoz-auto", token, body: { type: "invoice", customerId: c.id, lines: [{ kind: "labour", description: "x", qty: 1, unitPriceFils: 100, discountPct: 0 }] },
    });
    expect(inv.body.document.number).toBe("INV-00001");
    const n = await jsonCall(cloud.url, "POST", "/api/cloud/sync/numbers", "alquoz-auto", l.body.deviceKey, { kind: "invoice" });
    expect(n.body).toEqual({ series: "", seq: 2 });
    const next = await api(cloud.url, "POST", "/api/documents", {
      garage: "alquoz-auto", token, body: { type: "invoice", customerId: c.id, lines: [{ kind: "labour", description: "x", qty: 1, unitPriceFils: 100, discountPct: 0 }] },
    });
    expect(next.body.document.number).toBe("INV-00003");
    expect((await jsonCall(cloud.url, "POST", "/api/cloud/sync/numbers", "alquoz-auto", l.body.deviceKey, { kind: "nonsense" })).status).toBe(400);
  });
});
