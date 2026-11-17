import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, SETUP, setUp } from "./helpers";

describe("setup and auth", () => {
  it("sets up once", async () => {
    const app = await makeApp();
    expect((await call(app, "GET", "/api/setup/status")).body.configured).toBe(false);
    await setUp(app);
    expect((await call(app, "GET", "/api/setup/status")).body.configured).toBe(true);
    expect((await call(app, "POST", "/api/setup", undefined, SETUP)).status).toBe(409);
  });

  it("rejects bad setup input with a readable message", async () => {
    const app = await makeApp();
    const res = await call(app, "POST", "/api/setup", undefined, { ...SETUP, owner: { ...SETUP.owner, password: "short" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it("logs in and rejects a wrong password", async () => {
    const app = await makeApp();
    await setUp(app);
    expect((await call(app, "POST", "/api/auth/login", undefined, { username: "owner", password: "nope" })).status).toBe(401);
    const ok = await call(app, "POST", "/api/auth/login", undefined, { username: "OWNER", password: "owner-pass-1" });
    expect(ok.status).toBe(200);
    expect((await call(app, "GET", "/api/me", ok.body.token)).body.user.role).toBe("owner");
  });

  it("requires a session", async () => {
    const app = await makeApp();
    await setUp(app);
    expect((await call(app, "GET", "/api/me")).status).toBe(401);
    expect((await call(app, "GET", "/api/me", "made-up")).status).toBe(401);
  });

  it("logout ends the session", async () => {
    const app = await makeApp();
    const token = await setUp(app);
    await call(app, "POST", "/api/auth/logout", token);
    expect((await call(app, "GET", "/api/me", token)).status).toBe(401);
  });
});

describe("users and roles", () => {
  it("only the owner manages users and settings", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const advisor = await addUser(app, owner, "advisor");
    const accountant = await addUser(app, owner, "accountant");
    expect((await call(app, "GET", "/api/users", advisor)).status).toBe(403);
    expect((await call(app, "GET", "/api/users", accountant)).status).toBe(403);
    expect((await call(app, "GET", "/api/users", owner)).body.users).toHaveLength(3);
    expect((await call(app, "PATCH", "/api/settings", advisor, SETUP.garage)).status).toBe(403);
    expect((await call(app, "GET", "/api/settings", advisor)).body.garage.trn).toBe(SETUP.garage.trn);
  });

  it("deactivated users are signed out and cannot log in", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const advisor = await addUser(app, owner, "advisor");
    const list = (await call(app, "GET", "/api/users", owner)).body.users;
    const id = list.find((u: any) => u.role === "advisor").id;
    await call(app, "PATCH", `/api/users/${id}`, owner, { active: false });
    expect((await call(app, "GET", "/api/me", advisor)).status).toBe(401);
    expect((await call(app, "POST", "/api/auth/login", undefined, { username: "advisor", password: "advisor-pass-1" })).status).toBe(401);
  });

  it("keeps at least one active owner", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const me = (await call(app, "GET", "/api/me", owner)).body.user;
    const res = await call(app, "PATCH", `/api/users/${me.id}`, owner, { role: "advisor" });
    expect(res.status).toBe(400);
  });

  it("duplicate usernames are rejected", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const res = await call(app, "POST", "/api/users", owner, { name: "X", username: "Owner", role: "advisor", password: "12345678" });
    expect(res.status).toBe(409);
  });
});

describe("cross-origin access", () => {
  it("allows the screens to PATCH and PUT from another origin", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/documents/x",
      headers: { origin: "http://localhost:5180", "access-control-request-method": "PATCH" },
    });
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(res.headers["access-control-allow-methods"]).toContain("PUT");
  });
});
