import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { addUser, call, setUp, tempDir } from "./helpers";

const LAN = "192.168.1.31"; // another PC on the garage network

async function clockApp() {
  let t = Date.parse("2026-11-17T08:00:00Z");
  const app = await buildApp({ dataDir: tempDir(), now: () => t });
  return { app, advance: (ms: number) => (t += ms), close: () => app.close() };
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function req(app: App, o: { method?: string; url: string; token?: string; body?: unknown; from?: string; device?: string; origin?: string }) {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.device) headers["x-ffgp-device"] = o.device;
  if (o.origin) headers.origin = o.origin;
  if (o.method === "OPTIONS") headers["access-control-request-method"] = "GET";
  const res = await app.inject({ method: (o.method ?? "GET") as "GET", url: o.url, headers, payload: o.body as object | undefined, remoteAddress: o.from ?? "127.0.0.1" });
  return { status: res.statusCode, body: res.headers["content-type"]?.toString().includes("json") ? (JSON.parse(res.body) as any) : null, headers: res.headers };
}

async function pairedDevice(app: App, owner: string, name = "Front desk") {
  const code = (await req(app, { method: "POST", url: "/api/network/pairing-code", token: owner })).body.code as string;
  const paired = await req(app, { method: "POST", url: "/api/pair", body: { code, deviceName: name }, from: LAN });
  expect(paired.status).toBe(200);
  return paired.body.deviceKey as string;
}

describe("main-computer mode", () => {
  it("only lets paired PCs on the network in; the main computer itself needs no key", async () => {
    const { app, close } = await clockApp();
    try {
      const owner = await setUp(app);
      const blocked = await req(app, { url: "/api/me", token: owner, from: LAN });
      expect(blocked.status).toBe(401);
      expect(blocked.body.code).toBe("device_not_paired");
      expect((await req(app, { url: "/api/health", from: LAN })).status).toBe(200);
      expect((await req(app, { url: "/api/me", token: owner, from: "::ffff:127.0.0.1" })).status).toBe(200);
      expect((await req(app, { url: "/api/me", token: owner, from: LAN, device: "made-up-key" })).body.code).toBe("device_not_paired");

      const key = await pairedDevice(app, owner);
      expect((await req(app, { url: "/api/me", token: owner, from: LAN, device: key })).status).toBe(200);
      const login = await req(app, { method: "POST", url: "/api/auth/login", body: { username: "owner", password: "owner-pass-1" }, from: LAN, device: key });
      expect(login.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("pairing code: right code once, garage name returned; reuse, expiry and guessing all fail", async () => {
    const { app, advance, close } = await clockApp();
    try {
      const owner = await setUp(app);
      const pair = (code: string) => req(app, { method: "POST", url: "/api/pair", body: { code, deviceName: "Advisor PC" }, from: LAN });
      expect((await pair("123456")).status).toBe(400); // no code issued yet

      const first = await req(app, { method: "POST", url: "/api/network/pairing-code", token: owner });
      expect(first.body.code).toMatch(/^\d{6}$/);
      const ok = await pair(first.body.code);
      expect(ok.status).toBe(200);
      expect(ok.body.garage.name).toBe("Al Quoz Auto Care");
      expect(ok.body.deviceKey.length).toBeGreaterThanOrEqual(40);
      expect((await pair(first.body.code)).status).toBe(400); // single use

      const second = (await req(app, { method: "POST", url: "/api/network/pairing-code", token: owner })).body.code as string;
      advance(10 * 60_000 + 1);
      expect((await pair(second)).status).toBe(400); // expired after 10 minutes

      const third = (await req(app, { method: "POST", url: "/api/network/pairing-code", token: owner })).body.code as string;
      const wrong = third === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) expect((await pair(wrong)).status).toBe(400);
      expect((await pair(third)).status).toBe(400); // cancelled after 5 wrong tries
    } finally {
      await close();
    }
  });

  it("owner sees, shares and removes PCs; other roles can't", async () => {
    const { app, close } = await clockApp();
    try {
      const owner = await setUp(app);
      const advisor = await addUser(app, owner, "advisor");
      for (const [method, url] of [["GET", "/api/network"], ["POST", "/api/network/pairing-code"], ["PUT", "/api/network/sharing"]] as const) {
        expect((await req(app, { method, url, token: advisor, body: method === "PUT" ? { enabled: true } : undefined })).status).toBe(403);
      }

      expect((await req(app, { url: "/api/network", token: owner })).body).toMatchObject({ sharing: false, port: 47820, devices: [] });
      expect((await req(app, { method: "PUT", url: "/api/network/sharing", token: owner, body: { enabled: true } })).body.sharing).toBe(true);
      const key = await pairedDevice(app, owner, "Front desk");
      const net = (await req(app, { url: "/api/network", token: owner })).body;
      expect(net.sharing).toBe(true);
      expect(net.devices).toHaveLength(1);
      expect(net.devices[0]).toMatchObject({ name: "Front desk" });
      expect(Array.isArray(net.addresses)).toBe(true);

      expect((await req(app, { method: "DELETE", url: `/api/network/devices/${net.devices[0].id}`, token: owner })).status).toBe(200);
      expect((await req(app, { url: "/api/me", token: owner, from: LAN, device: key })).body.code).toBe("device_not_paired");
      expect((await req(app, { url: "/api/network", token: owner })).body.devices).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("locks a login for 5 minutes after 5 wrong passwords", async () => {
    const { app, advance, close } = await clockApp();
    try {
      await setUp(app);
      const login = (username: string, password: string) => call(app, "POST", "/api/auth/login", undefined, { username, password });
      for (let i = 0; i < 4; i++) expect((await login("owner", "wrong")).status).toBe(401);
      expect((await login("owner", "owner-pass-1")).status).toBe(200); // success resets the count
      for (let i = 0; i < 5; i++) expect((await login("owner", "wrong")).status).toBe(401);
      const locked = await login("OWNER", "owner-pass-1"); // case doesn't dodge the lock
      expect(locked.status).toBe(429);
      expect(locked.body.error).toMatch(/5 minutes/);
      advance(5 * 60_000);
      expect((await login("owner", "owner-pass-1")).status).toBe(200);
    } finally {
      await close();
    }
  }, 20_000); // scrypt-heavy: many password checks; slow when the whole suite runs in parallel

  it("answers only the app's own pages across origins", async () => {
    const { app, close } = await clockApp();
    try {
      const preflight = (origin: string) => req(app, { method: "OPTIONS", url: "/api/me", origin });
      expect((await preflight("https://evil.example")).headers["access-control-allow-origin"]).toBeUndefined();
      expect((await preflight("null")).headers["access-control-allow-origin"]).toBe("null");
      expect((await preflight("http://localhost:5180")).headers["access-control-allow-origin"]).toBe("http://localhost:5180");
    } finally {
      await close();
    }
  });
});
