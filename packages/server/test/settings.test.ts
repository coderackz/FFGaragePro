import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("settings API", () => {
  it("anyone signed in reads settings with defaults", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const advisor = await addUser(app, owner, "advisor");
    const res = await call(app, "GET", "/api/settings", advisor);
    expect(res.status).toBe(200);
    expect(res.body.garage.name).toBe("Al Quoz Auto Care");
    expect(res.body.settings.numbering.invoicePrefix).toBe("INV");
  });

  it("only the owner saves a section", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const accountant = await addUser(app, owner, "accountant");
    expect((await call(app, "PUT", "/api/settings/pricing", accountant, { labourRateFils: 18000 })).status).toBe(403);
    const saved = await call(app, "PUT", "/api/settings/pricing", owner, { labourRateFils: 18000 });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.pricing.labourRateFils).toBe(18000);
    expect((await call(app, "GET", "/api/settings", owner)).body.settings.pricing.labourRateFils).toBe(18000);
    expect((await call(app, "PUT", "/api/settings/marketing", owner, {})).status).toBe(404);
  });

  it("saving one section never touches another", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    await call(app, "PUT", "/api/settings/pricing", owner, { labourRateFils: 18000 });
    const before = new Map(app.db.all<{ key: string; value: string }>("SELECT key, value FROM settings").map((r) => [r.key, r.value]));
    await call(app, "PUT", "/api/settings/inventory", owner, { belowZero: "block" });
    const after = app.db.all<{ key: string; value: string }>("SELECT key, value FROM settings");
    const changed = after.filter((r) => before.get(r.key) !== r.value).map((r) => r.key);
    expect(changed.every((k) => k.startsWith("inventory."))).toBe(true);
    expect((await call(app, "GET", "/api/settings", owner)).body.settings.pricing.labourRateFils).toBe(18000);
  });

  it("bad input is refused and nothing written", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const res = await call(app, "PUT", "/api/settings/documents", owner, { logo: "data:image/gif;base64,R0lG" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Use a PNG or JPG image under 500 KB");
    expect((await call(app, "GET", "/api/settings", owner)).body.settings.documents.logo).toBeNull();
    expect(app.db.get("SELECT 1 FROM settings WHERE key LIKE 'documents.%'")).toBeUndefined();
  });

  it("every change is in the activity log", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const accountant = await addUser(app, owner, "accountant");
    await call(app, "PUT", "/api/settings/pricing", owner, { labourRateFils: 18000 });
    const log = await call(app, "GET", "/api/audit", owner);
    expect(log.status).toBe(200);
    expect(log.body.entries[0]).toMatchObject({
      action: "settings.change", entityId: "pricing", before: { labourRateFils: null }, after: { labourRateFils: 18000 }, user: "Owner One",
    });
    expect((await call(app, "GET", "/api/audit", accountant)).status).toBe(403);
  });

  it("logo changes are logged without the image", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    await call(app, "PUT", "/api/settings/documents", owner, { logo: PNG_1x1 });
    const entry = (await call(app, "GET", "/api/audit?action=settings.change", owner)).body.entries[0];
    expect(entry.after.logo).toBe("(image)");
    expect(entry.before.logo).toBeNull();
  });

  it("garage profile changes are logged", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    await call(app, "PATCH", "/api/settings", owner, { name: "Al Quoz Auto Care LLC", trn: "100123456700003", address: "Al Quoz 3, Dubai", phone: "+971 4 000 0000" });
    const entry = (await call(app, "GET", "/api/audit", owner)).body.entries[0];
    expect(entry).toMatchObject({ action: "settings.change", entityId: "profile", before: { name: "Al Quoz Auto Care" }, after: { name: "Al Quoz Auto Care LLC" } });
  });

  it("overview", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    await call(app, "PUT", "/api/settings/pricing", owner, { labourRateFils: 18000 });
    const res = await call(app, "GET", "/api/settings/overview", owner);
    expect(res.body).toEqual({
      nextNumbers: { estimate: "EST-00001", jobcard: "JC-00001", invoice: "INV-00001", purchase_order: "PO-00001", credit_note: "CN-00001", receipt: "RCT-00001", journal: "JV-00001", supplier_payment: "PV-00001", expense: "EX-00001" },
      users: 1,
      changesThisWeek: 1,
      messages: { emailReady: false, passwordSet: false },
      failedMessages: 0,
    });
  });

  it("user changes are logged", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    await call(app, "POST", "/api/users", owner, { name: "Sara", username: "sara", role: "advisor", password: "sara-pass-1" });
    const entry = (await call(app, "GET", "/api/audit?action=user.create", owner)).body.entries[0];
    expect(entry.after).toMatchObject({ username: "sara", role: "advisor" });
    expect(JSON.stringify(entry)).not.toMatch(/scrypt|password/i);
  });

  it("smtp password is write-only", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "PUT", "/api/settings/messages/password", advisor, { password: "s3cret!" })).status).toBe(403);
    expect((await call(app, "PUT", "/api/settings/messages/password", owner, { password: "s3cret!" })).status).toBe(200);
    expect((await call(app, "GET", "/api/settings/overview", owner)).body.messages).toEqual({ emailReady: false, passwordSet: true });
    await call(app, "PUT", "/api/settings/messages", owner, { smtpHost: "mail.example.com", fromAddress: "garage@example.com" });
    const overview = await call(app, "GET", "/api/settings/overview", owner);
    expect(overview.body.messages).toEqual({ emailReady: true, passwordSet: true });
    for (const url of ["/api/settings", "/api/settings/overview", "/api/audit"]) {
      expect(JSON.stringify((await call(app, "GET", url, owner)).body)).not.toContain("s3cret!");
    }
    const logged = (await call(app, "GET", "/api/audit", owner)).body.entries.find((e: { entityId: string }) => e.entityId === "messages.password");
    expect(logged.after).toEqual({ smtpPassword: "(changed)" });
    await call(app, "PUT", "/api/settings/messages/password", owner, { password: null });
    expect((await call(app, "GET", "/api/settings/overview", owner)).body.messages).toEqual({ emailReady: false, passwordSet: false });
  });
});
