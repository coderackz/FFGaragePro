import { afterEach, describe, expect, it } from "vitest";
import { buildApp, SCHEMA_VERSION } from "@ffgp/server";
import { linkDownload, linkUpload, readOnlyGuard, setState, getState, SyncClient, type CloudLink } from "../src/index";
import { api, garageReady, makeClock, SETUP, startCloud } from "../../../apps/cloud/test/helpers";
import { call, tempDir, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

/** A fetch that can be cut off ("offline") or made to fail once on a given call. */
function flakyFetch() {
  const state = { offline: false, failNext: null as null | { path: string; after: boolean }, rewrite: null as null | ((url: string, init?: RequestInit) => [string, RequestInit | undefined]) };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    let url = String(input);
    if (state.offline) throw new TypeError("fetch failed");
    if (state.rewrite) [url, init] = state.rewrite(url, init);
    const fail = state.failNext && url.includes(state.failNext.path) ? state.failNext : null;
    if (fail && !fail.after) {
      state.failNext = null;
      throw new TypeError("fetch failed");
    }
    const res = await fetch(url, init);
    if (fail?.after) {
      state.failNext = null;
      throw new TypeError("connection reset after the request arrived");
    }
    return res;
  }) as typeof fetch;
  return { state, fetch: f };
}

/** A cloud garage set up in the browser, and a PC that downloaded it and runs its own server. */
async function cloudAndPc(o: { now?: () => number } = {}) {
  const cloud = await startCloud({ now: o.now });
  const { token: browser } = await garageReady(cloud, "alquoz-auto", o.now);
  const net = flakyFetch();
  const dataDir = tempDir();
  const link = await linkDownload({ url: cloud.url, garageCode: "alquoz-auto", username: "rashid", password: SETUP.owner.password, deviceName: "Front desk", dataDir, fetch: net.fetch });
  const pc = await pcApp(dataDir, link, net.fetch, o.now);
  return { cloud, browser, net, link, ...pc };
}

async function pcApp(dataDir: string, link: CloudLink, f: typeof fetch, now?: () => number) {
  let client!: SyncClient;
  const app = await buildApp({ dataDir, numbers: { next: (k) => client.numbers().next(k), offlineSeries: link.deviceCode }, guard: readOnlyGuard(() => client) });
  apps.push(app);
  client = new SyncClient(app.db, link, { fetch: f, now });
  const login = await call(app, "POST", "/api/auth/login", undefined, { username: "rashid", password: SETUP.owner.password });
  return { app, client, pcToken: login.body.token as string };
}

const browserCall = (url: string, token: string, method: string, path: string, body?: unknown) => api(url, method, path, { garage: "alquoz-auto", token, body });

describe("PC sync client", () => {
  it("PC and browser edits meet", async () => {
    const { cloud, browser, app, client, pcToken } = await cloudAndPc();
    const c = (await call(app, "POST", "/api/customers", pcToken, { name: "Made on PC" })).body.customer;
    expect(client.status().pending).toBeGreaterThan(0);
    expect(await client.syncOnce()).toMatchObject({ ok: true });
    expect(client.status()).toMatchObject({ linked: true, pending: 0, readOnly: false });
    const list = await browserCall(cloud.url, browser, "GET", "/api/customers");
    expect(list.body.customers.map((x: { name: string }) => x.name)).toEqual(["Made on PC"]);
    await browserCall(cloud.url, browser, "PATCH", `/api/customers/${c.id}`, { name: "Renamed in browser" });
    await client.syncOnce();
    expect((await call(app, "GET", `/api/customers/${c.id}`, pcToken)).body.customer.name).toBe("Renamed in browser");
  });

  it("offline PC numbers from its own series and syncs later", async () => {
    const { cloud, browser, net, app, client, pcToken } = await cloudAndPc();
    const c = (await call(app, "POST", "/api/customers", pcToken, { name: "Walk-in" })).body.customer;
    net.state.offline = true;
    expect(await client.syncOnce()).toMatchObject({ ok: false, reason: "offline" });
    const offlineInv = (await call(app, "POST", "/api/documents", pcToken, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document;
    expect(offlineInv.number).toBe("INV-P1-00001");
    net.state.offline = false;
    expect(await client.syncOnce()).toMatchObject({ ok: true });
    const docs = await browserCall(cloud.url, browser, "GET", "/api/documents?type=invoice");
    expect(docs.body.documents.map((d: { number: string }) => d.number)).toEqual(["INV-P1-00001"]);
    const browserInv = await browserCall(cloud.url, browser, "POST", "/api/documents", { type: "invoice", customerId: c.id, lines: [LINE] });
    expect(browserInv.body.document.number).toBe("INV-00001");
    // Online again, the PC takes the next main-series number from the cloud.
    expect((await call(app, "POST", "/api/documents", pcToken, { type: "invoice", customerId: c.id, lines: [LINE] })).body.document.number).toBe("INV-00002");
  });

  it("push succeeded, pull failed → next sync applies nothing twice", async () => {
    const { cloud, browser, net, app, client, pcToken } = await cloudAndPc();
    await browserCall(cloud.url, browser, "POST", "/api/customers", { name: "Browser one" });
    await call(app, "POST", "/api/customers", pcToken, { name: "PC one" });
    // The push reaches the cloud but its reply is lost.
    net.state.failNext = { path: "/sync/push", after: true };
    expect(await client.syncOnce()).toMatchObject({ ok: false, reason: "offline" });
    // Then the push goes through but the pull fails.
    net.state.failNext = { path: "/sync/pull", after: false };
    expect(await client.syncOnce()).toMatchObject({ ok: false, reason: "offline" });
    expect(await client.syncOnce()).toMatchObject({ ok: true });
    expect(await client.syncOnce()).toMatchObject({ ok: true, pushed: 0, pulled: 0 });
    const names = async (rows: Promise<{ body: { customers: { name: string }[] } }>) => (await rows).body.customers.map((x) => x.name).sort();
    expect(await names(browserCall(cloud.url, browser, "GET", "/api/customers"))).toEqual(["Browser one", "PC one"]);
    expect(await names(call(app, "GET", "/api/customers", pcToken))).toEqual(["Browser one", "PC one"]);
  });

  it("same plate offline on both sides → both sides end identical with (2)", async () => {
    const { cloud, browser, net, app, client, pcToken } = await cloudAndPc();
    const c = (await call(app, "POST", "/api/customers", pcToken, { name: "Owner" })).body.customer;
    await client.syncOnce();
    net.state.offline = true;
    await call(app, "POST", "/api/vehicles", pcToken, { customerId: c.id, plate: "DXB A 1" });
    await browserCall(cloud.url, browser, "POST", "/api/vehicles", { customerId: c.id, plate: "DXB A 1" });
    net.state.offline = false;
    await client.syncOnce();
    const cloudPlates = (await browserCall(cloud.url, browser, "GET", `/api/customers/${c.id}`)).body.vehicles.map((v: { id: string; plate: string }) => [v.id, v.plate]);
    const pcPlates = (await call(app, "GET", `/api/customers/${c.id}`, pcToken)).body.vehicles.map((v: { id: string; plate: string }) => [v.id, v.plate]);
    expect(cloudPlates.map((p: string[]) => p[1]).sort()).toEqual(["DXB A 1", "DXB A 1 (2)"]);
    expect(pcPlates).toEqual(cloudPlates);
    expect(client.status().issues).toBe(1);
    const issues = (await call(app, "GET", "/api/sync-issues", pcToken)).body.issues;
    expect(issues).toHaveLength(1);
    expect((await browserCall(cloud.url, browser, "GET", "/api/sync-issues")).body.issues).toHaveLength(1);
    expect((await call(app, "POST", `/api/sync-issues/${issues[0].id}/dismiss`, pcToken)).status).toBe(200);
    expect(client.status().issues).toBe(0);
  });

  it("the clash issue reaches the PC even when the push reply is lost", async () => {
    const { cloud, browser, net, app, client, pcToken } = await cloudAndPc();
    const c = (await call(app, "POST", "/api/customers", pcToken, { name: "Owner" })).body.customer;
    await client.syncOnce();
    await call(app, "POST", "/api/vehicles", pcToken, { customerId: c.id, plate: "DXB A 7" });
    await browserCall(cloud.url, browser, "POST", "/api/vehicles", { customerId: c.id, plate: "DXB A 7" });
    net.state.failNext = { path: "/sync/push", after: true };
    expect(await client.syncOnce()).toMatchObject({ ok: false });
    expect(await client.syncOnce()).toMatchObject({ ok: true });
    expect(client.status().issues).toBe(1);
    await client.syncOnce();
    expect(client.status().issues).toBe(1);
  });

  it("downloading never replaces a garage that's already set up on this PC", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    const dataDir = tempDir();
    const standalone = await buildApp({ dataDir });
    const setup = await call(standalone, "POST", "/api/setup", undefined, { garage: { name: "Mine" }, owner: { name: "Mona Saleh", username: "mona", password: "my-pass-123" } });
    expect(setup.status).toBe(200);
    await standalone.close();
    await expect(linkDownload({ url: cloud.url, garageCode: "alquoz-auto", username: "rashid", password: SETUP.owner.password, deviceName: "PC", dataDir })).rejects.toThrow(/already has a garage/);
    const again = await buildApp({ dataDir });
    apps.push(again);
    expect(again.db.get("SELECT name FROM garage")).toEqual({ name: "Mine" });
  });

  it("existing PC garage uploads into an empty cloud garage; browser sign-in works with the PC owner's password", async () => {
    const cloud = await startCloud();
    const g = cloud.admin.createGarage({ code: "pc-garage", name: "PC Garage", notes: null, now: Date.now() });
    const dataDir = tempDir();
    const standalone = await buildApp({ dataDir });
    apps.push(standalone);
    const setup = await call(standalone, "POST", "/api/setup", undefined, { garage: { name: "PC Garage" }, owner: { name: "Pc Owner", username: "pcowner", password: "pc-pass-123" } });
    await call(standalone, "POST", "/api/customers", setup.body.token, { name: "Old customer" });
    const link = await linkUpload({ url: cloud.url, garageCode: "pc-garage", setupCode: g.setup_code!, deviceName: "Office PC", db: standalone.db });
    expect(link.deviceCode).toBe("P1");
    const client = new SyncClient(standalone.db, link, {});
    await call(standalone, "POST", "/api/customers", setup.body.token, { name: "After linking" });
    expect(await client.syncOnce()).toMatchObject({ ok: true });
    const login = await api(cloud.url, "POST", "/api/auth/login", { garage: "pc-garage", body: { username: "pcowner", password: "pc-pass-123" } });
    expect(login.status).toBe(200);
    const list = await api(cloud.url, "GET", "/api/customers", { garage: "pc-garage", token: login.body.token });
    expect(list.body.customers.map((x: { name: string }) => x.name).sort()).toEqual(["After linking", "Old customer"]);
  });

  it("PC older than cloud → update_app, and the PC still saves locally", async () => {
    const { net, app, client, pcToken } = await cloudAndPc();
    net.state.rewrite = (url, init) => {
      const older = url.replace(`schema=${SCHEMA_VERSION}`, `schema=${SCHEMA_VERSION - 1}`);
      if (init?.body && typeof init.body === "string" && url.includes("/sync/push")) {
        return [older, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), schema: SCHEMA_VERSION - 1 }) }];
      }
      return [older, init];
    };
    await call(app, "POST", "/api/customers", pcToken, { name: "Still saves" });
    const r = await client.syncOnce();
    expect(r).toMatchObject({ ok: false, reason: "update_app", message: "Update Fleetfix Garage Pro to keep syncing" });
    expect(client.status().pending).toBeGreaterThan(0);
    expect((await call(app, "POST", "/api/customers", pcToken, { name: "And again" })).status).toBe(200);
  });

  it("licence: 31 days without a check → read-only guard returns 402; a fresh token lifts it; a tampered token is read-only", async () => {
    const clock = makeClock(Date.now());
    const { app, client, pcToken } = await cloudAndPc({ now: clock.now });
    clock.advanceDays(31);
    expect(client.status().readOnly).toBe(true);
    const refused = await call(app, "POST", "/api/customers", pcToken, { name: "Blocked" });
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe("read_only");
    expect((await call(app, "GET", "/api/customers", pcToken)).status).toBe(200);
    expect(await client.syncOnce()).toMatchObject({ ok: true });
    expect(client.status().readOnly).toBe(false);
    expect((await call(app, "POST", "/api/customers", pcToken, { name: "Allowed" })).status).toBe(200);
    const token = getState(app.db, "licence")!;
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), graceEndsAt: "2099-01-01T00:00:00.000Z" })).toString("base64url");
    setState(app.db, "licence", `${forged}.${sig}`);
    expect(client.status().readOnly).toBe(true);
  });
});
