import { describe, expect, it } from "vitest";
import { api, garageReady, makeClock, SETUP, startCloud } from "./helpers";

describe("cloud server", () => {
  it("setup needs the setup code; then the garage works in the browser API", async () => {
    const cloud = await startCloud();
    const g = cloud.admin.createGarage({ code: "alquoz-auto", name: "Al Quoz", notes: null, now: Date.now() });
    expect(g.setup_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const setup = (setupCode?: string | null) => api(cloud.url, "POST", "/api/setup", { garage: "alquoz-auto", setupCode, body: SETUP });
    expect((await setup()).status).toBe(403);
    expect((await setup("WRONGCOD")).body.code).toBe("setup_code");
    const ok = await setup(g.setup_code);
    expect(ok.status).toBe(200);
    expect((await setup(g.setup_code)).status).toBe(409);
    const token = ok.body.token;
    const customer = await api(cloud.url, "POST", "/api/customers", { garage: "alquoz-auto", token, body: { name: "Ahmed", phone: "050" } });
    expect(customer.status).toBe(200);
    const jc = await api(cloud.url, "POST", "/api/documents", {
      garage: "alquoz-auto", token,
      body: { type: "jobcard", customerId: customer.body.customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] },
    });
    expect(jc.body.document.number).toBe("JC-00001");
  });

  it("an expired setup code is refused", async () => {
    const clock = makeClock();
    const cloud = await startCloud({ now: clock.now });
    const g = cloud.admin.createGarage({ code: "alquoz-auto", name: "Al Quoz", notes: null, now: clock.now() });
    clock.advanceDays(15);
    expect((await api(cloud.url, "POST", "/api/setup", { garage: "alquoz-auto", setupCode: g.setup_code, body: SETUP })).status).toBe(403);
  });

  it("garage ID is case- and space-insensitive", async () => {
    const cloud = await startCloud();
    await garageReady(cloud, "alquoz-auto");
    expect((await api(cloud.url, "GET", "/api/setup/status", { garage: " AlQuoz-Auto " })).body).toEqual({ configured: true });
  });

  it("unknown garage", async () => {
    const cloud = await startCloud();
    for (const garage of ["nope-garage", undefined]) {
      const res = await api(cloud.url, "GET", "/api/setup/status", { garage });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("unknown_garage");
    }
  });

  it("a token from garage A doesn't work on garage B", async () => {
    const cloud = await startCloud();
    const a = await garageReady(cloud, "garage-a");
    const b = await garageReady(cloud, "garage-b");
    expect((await api(cloud.url, "GET", "/api/customers", { garage: "garage-b", token: a.token })).status).toBe(401);
    await api(cloud.url, "POST", "/api/customers", { garage: "garage-a", token: a.token, body: { name: "Only in A" } });
    expect((await api(cloud.url, "GET", "/api/customers", { garage: "garage-b", token: b.token })).body.customers).toEqual([]);
  });

  it("read-only after trial + grace", async () => {
    const clock = makeClock();
    const cloud = await startCloud({ now: clock.now });
    await garageReady(cloud, "alquoz-auto", clock.now);
    clock.advanceDays(75);
    const login = await api(cloud.url, "POST", "/api/auth/login", { garage: "alquoz-auto", body: { username: "rashid", password: "garage-pass-1" } });
    expect(login.status).toBe(200);
    const token = login.body.token;
    expect((await api(cloud.url, "GET", "/api/customers", { garage: "alquoz-auto", token })).status).toBe(200);
    const write = await api(cloud.url, "POST", "/api/customers", { garage: "alquoz-auto", token, body: { name: "X" } });
    expect(write.status).toBe(402);
    expect(write.body.code).toBe("read_only");
    // "You can still view and print": recording a print of an invoice is allowed.
    expect((await api(cloud.url, "POST", "/api/documents/00000000-0000-4000-8000-000000000000/prints", { garage: "alquoz-auto", token })).status).toBe(404);
    const licence = await api(cloud.url, "GET", "/api/cloud/licence", { garage: "alquoz-auto" });
    expect(licence.body).toMatchObject({ state: "read_only", garage: { code: "alquoz-auto" } });
    expect((await api(cloud.url, "POST", "/api/auth/logout", { garage: "alquoz-auto", token })).status).toBe(200);
  });

  it("licence shows the trial and days left", async () => {
    const clock = makeClock();
    const cloud = await startCloud({ now: clock.now });
    await garageReady(cloud, "alquoz-auto", clock.now);
    clock.advanceDays(50);
    expect((await api(cloud.url, "GET", "/api/cloud/licence", { garage: "alquoz-auto" })).body).toMatchObject({ state: "trial", daysLeft: 10 });
  });

  it("evicted garages reopen", async () => {
    const cloud = await startCloud({ maxOpen: 1 });
    const a = await garageReady(cloud, "garage-a");
    const b = await garageReady(cloud, "garage-b");
    for (let i = 0; i < 5; i++) {
      expect((await api(cloud.url, "GET", "/api/customers", { garage: "garage-a", token: a.token })).status).toBe(200);
      expect((await api(cloud.url, "GET", "/api/customers", { garage: "garage-b", token: b.token })).status).toBe(200);
    }
  });
});
