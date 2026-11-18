import { request } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, garageReady, makeClock, SETUP, startCloud } from "./helpers";

/** Sends a request with the path exactly as given (fetch would strip a #fragment). */
function raw(url: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: any }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("final review fixes", () => {
  it("the setup code can't be skipped with an encoded or fragment path (C1)", async () => {
    const cloud = await startCloud();
    cloud.admin.createGarage({ code: "alquoz-auto", name: "Al Quoz", notes: null, now: Date.now() });
    for (const path of ["/api/%73etup", "/api/setup#x", "/api/set%75p?x=1"]) {
      const res = await raw(cloud.url, "POST", path, { "x-ffgp-garage": "alquoz-auto" }, SETUP);
      expect(res.status, path).toBe(403);
    }
    expect((await api(cloud.url, "GET", "/api/setup/status", { garage: "alquoz-auto" })).body).toEqual({ configured: false });
  });

  it("read-only can't be skipped with an encoded login path, and encoded login still works (C1)", async () => {
    const clock = makeClock();
    const cloud = await startCloud({ now: clock.now });
    const { token } = await garageReady(cloud, "alquoz-auto", clock.now);
    clock.advanceDays(75);
    expect((await raw(cloud.url, "POST", "/api/%63ustomers", { "x-ffgp-garage": "alquoz-auto", authorization: `Bearer ${token}` }, { name: "X" })).status).toBe(402);
    expect((await raw(cloud.url, "POST", "/api/auth/%6cogin", { "x-ffgp-garage": "alquoz-auto" }, { username: "rashid", password: "garage-pass-1" })).status).toBe(200);
  });

  it("a garage whose database can't open fails alone; the cloud keeps serving others (I2)", async () => {
    const cloud = await startCloud({ maxOpen: 1 });
    const good = await garageReady(cloud, "garage-good");
    const bad = cloud.admin.createGarage({ code: "garage-bad", name: "Bad", notes: null, now: Date.now() });
    mkdirSync(join(cloud.dataDir, "garages"), { recursive: true });
    writeFileSync(join(cloud.dataDir, "garages", bad.id), "not a folder");
    expect((await api(cloud.url, "GET", "/api/setup/status", { garage: "garage-bad" })).status).toBe(500);
    for (let i = 0; i < 3; i++) {
      expect((await api(cloud.url, "GET", "/api/customers", { garage: "garage-good", token: good.token })).status).toBe(200);
      expect((await api(cloud.url, "GET", "/api/setup/status", { garage: "garage-bad" })).status).toBe(500);
    }
  });

  it("impossible paid-until dates are refused (I3)", async () => {
    const cloud = await startCloud();
    cloud.admin.addStaff({ username: "fleetfix", name: "FF", password: "admin-pass-1" });
    const token = (await api(cloud.url, "POST", "/admin/api/login", { body: { username: "fleetfix", password: "admin-pass-1" } })).body.token;
    const { garage } = (await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: "alquoz-auto", name: "Al Quoz" } })).body;
    for (const paidUntil of ["2027-13-01", "2027-02-31"]) {
      expect((await api(cloud.url, "PATCH", `/admin/api/garages/${garage.id}`, { token, body: { paidUntil } })).status, paidUntil).toBe(400);
    }
    expect((await api(cloud.url, "GET", "/admin/api/garages", { token })).status).toBe(200);
  });

  it("staff sign-in locks after 5 wrong passwords (I4)", async () => {
    const cloud = await startCloud();
    cloud.admin.addStaff({ username: "fleetfix", name: "FF", password: "admin-pass-1" });
    const login = (password: string) => api(cloud.url, "POST", "/admin/api/login", { body: { username: "fleetfix", password } });
    for (let i = 0; i < 5; i++) expect((await login("wrong")).status).toBe(401);
    const locked = await login("admin-pass-1");
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/locked/i);
  });

  it("garage sign-in lockouts survive the garage being closed and reopened (I5)", async () => {
    const cloud = await startCloud({ maxOpen: 1 });
    await garageReady(cloud, "garage-a");
    await garageReady(cloud, "garage-b");
    const login = (password: string) => api(cloud.url, "POST", "/api/auth/login", { garage: "garage-a", body: { username: "rashid", password } });
    for (let i = 0; i < 5; i++) await login("wrong");
    await api(cloud.url, "GET", "/api/setup/status", { garage: "garage-b" }); // closes garage-a
    expect((await login("garage-pass-1")).status).toBe(429);
  });
});
