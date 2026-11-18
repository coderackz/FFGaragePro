import { describe, expect, it } from "vitest";
import { api, makeClock, SETUP, startCloud } from "./helpers";

async function staff(cloud: Awaited<ReturnType<typeof startCloud>>) {
  cloud.admin.addStaff({ username: "fleetfix", name: "Fleet Fix Admin", password: "admin-pass-1" });
  const res = await api(cloud.url, "POST", "/admin/api/login", { body: { username: "fleetfix", password: "admin-pass-1" } });
  expect(res.status).toBe(200);
  return res.body.token as string;
}
const listOne = async (url: string, token: string) => (await api(url, "GET", "/admin/api/garages", { token })).body.garages[0];

describe("Fleet Fix admin API", () => {
  it("staff create a garage and see it awaiting setup", async () => {
    const clock = makeClock();
    const cloud = await startCloud({ now: clock.now });
    const token = await staff(cloud);
    const created = await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: " AlQuoz-Auto ", name: "Al Quoz Auto Care" } });
    expect(created.status).toBe(200);
    expect(created.body.garage).toMatchObject({ code: "alquoz-auto", state: "trial", setUp: false });
    const g = await listOne(cloud.url, token);
    expect(g.setupCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(Date.parse(g.trialEndsAt) - clock.now()).toBe(60 * 86_400_000);
  });

  it("a set-up garage shows its users and hides the code", async () => {
    const cloud = await startCloud();
    const token = await staff(cloud);
    const { garage } = (await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: "alquoz-auto", name: "Al Quoz" } })).body;
    await api(cloud.url, "POST", "/api/setup", { garage: "alquoz-auto", setupCode: garage.setupCode, body: SETUP });
    const g = await listOne(cloud.url, token);
    expect(g).toMatchObject({ setUp: true, userCount: 1 });
    expect(g.setupCode).toBeUndefined();
    expect((await api(cloud.url, "POST", `/admin/api/garages/${g.id}/setup-code`, { token })).status).toBe(409);
  });

  it("paid until and pause", async () => {
    const clock = makeClock();
    const cloud = await startCloud({ now: clock.now });
    const token = await staff(cloud);
    const { garage } = (await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: "alquoz-auto", name: "Al Quoz" } })).body;
    const patch = (body: unknown) => api(cloud.url, "PATCH", `/admin/api/garages/${garage.id}`, { token, body });
    expect((await patch({ paidUntil: "2027-12-31" })).body.garage).toMatchObject({ status: "active", state: "active", paidUntil: "2027-12-31" });
    expect((await patch({ paidUntil: "31/12/2027" })).status).toBe(400);
    await patch({ status: "paused" });
    clock.advanceDays(15); // staff sessions last 7 days: sign in again
    const fresh = (await api(cloud.url, "POST", "/admin/api/login", { body: { username: "fleetfix", password: "admin-pass-1" } })).body.token;
    expect((await listOne(cloud.url, fresh)).state).toBe("read_only");
    expect((await api(cloud.url, "PATCH", `/admin/api/garages/${garage.id}`, { token: fresh, body: { status: "active" } })).body.garage.state).toBe("active");
  });

  it("reset owner password", async () => {
    const cloud = await startCloud();
    const token = await staff(cloud);
    const { garage } = (await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: "alquoz-auto", name: "Al Quoz" } })).body;
    await api(cloud.url, "POST", "/api/setup", { garage: "alquoz-auto", setupCode: garage.setupCode, body: SETUP });
    const reset = await api(cloud.url, "POST", `/admin/api/garages/${garage.id}/reset-owner-password`, { token });
    expect(reset.body.username).toBe("rashid");
    expect(reset.body.temporaryPassword).toHaveLength(12);
    const login = (password: string) => api(cloud.url, "POST", "/api/auth/login", { garage: "alquoz-auto", body: { username: "rashid", password } });
    expect((await login(reset.body.temporaryPassword)).status).toBe(200);
    expect((await login(SETUP.owner.password)).status).toBe(401);
  });

  it("needs a staff token", async () => {
    const cloud = await startCloud();
    await staff(cloud);
    for (const [method, path] of [["GET", "/admin/api/garages"], ["POST", "/admin/api/garages"], ["PATCH", "/admin/api/garages/x"]] as const) {
      expect((await api(cloud.url, method, path, { body: method === "GET" ? undefined : {} })).status).toBe(401);
    }
    expect((await api(cloud.url, "POST", "/admin/api/login", { body: { username: "fleetfix", password: "nope" } })).status).toBe(401);
  });

  it("bad and duplicate garage IDs", async () => {
    const cloud = await startCloud();
    const token = await staff(cloud);
    const bad = await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: "al quoz", name: "X" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/letters, numbers/i);
    await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: "alquoz-auto", name: "X" } });
    expect((await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: "AlQuoz-Auto", name: "Y" } })).status).toBe(409);
  });

  it("every change is audited", async () => {
    const cloud = await startCloud();
    const token = await staff(cloud);
    const { garage } = (await api(cloud.url, "POST", "/admin/api/garages", { token, body: { code: "alquoz-auto", name: "Al Quoz" } })).body;
    await api(cloud.url, "PATCH", `/admin/api/garages/${garage.id}`, { token, body: { paidUntil: "2027-12-31" } });
    const rows = cloud.admin.raw.prepare("SELECT action FROM audit ORDER BY at").all() as { action: string }[];
    expect(rows.map((r) => r.action)).toEqual(["garage.create", "garage.update"]);
  });
});
