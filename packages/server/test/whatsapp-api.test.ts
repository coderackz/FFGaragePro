import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { call, makeApp, setUp, type App } from "./helpers";
import { FAKE_WA_TOKEN, startFakeProviders, type FakeProviders } from "../src/integrations/fakes";

const fakes: FakeProviders[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });
const WA = { phoneNumberId: "1099", businessAccountId: "2088", accessToken: FAKE_WA_TOKEN, appSecret: "app-secret" };
const PDF = Buffer.from("%PDF-1.4 test").toString("base64");

async function connected() {
  const fake = await startFakeProviders();
  fakes.push(fake);
  const app = await makeApp(undefined, { integrations: { publicUrl: "https://cloud.test", endpoints: fake.endpoints } });
  const owner = await setUp(app);
  return { app, owner, fake };
}
const sign = (raw: string, secret = "app-secret") => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const hook = (app: App, raw: string, signature?: string) =>
  app.inject({ method: "POST", url: "/api/integrations/whatsapp/webhook", headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) }, payload: raw });
const statusHook = (wamid: string, status: string, extra = {}) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "2088", changes: [{ field: "messages", value: { statuses: [{ id: wamid, status, ...extra }] } }] }] });

describe("WhatsApp Business API", () => {
  it("connect and test", async () => {
    const { app, owner, fake } = await connected();
    const bad = await call(app, "POST", "/api/integrations/whatsapp/connect", owner, { ...WA, accessToken: "EAAGfake000000000000000000bad0" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/WhatsApp said: Invalid OAuth access token/);
    const ok = await call(app, "POST", "/api/integrations/whatsapp/connect", owner, WA);
    expect(ok.status).toBe(200);
    expect(ok.body.status.whatsapp).toMatchObject({ connected: true, label: "+971 4 000 0000" });
    const info = (await call(app, "GET", "/api/integrations/whatsapp", owner)).body;
    expect(info.webhookUrl).toBe("https://cloud.test/api/integrations/whatsapp/webhook");
    expect(info.verifyToken).toMatch(/^[0-9a-f]{24}$/);
    const test = await call(app, "POST", "/api/integrations/whatsapp/test", owner, { to: "050 123 4567", templateName: "hello_world", language: "en_US" });
    expect(test.body).toMatchObject({ id: "wamid.1" });
    const sent = fake.calls.find((c) => c.path === "/graph/1099/messages")!;
    expect(sent.body).toMatchObject({ messaging_product: "whatsapp", to: "971501234567", type: "template", template: { name: "hello_world", language: { code: "en_US" } } });
  });

  it("queued message is sent by the outbox, the PDF as the header document", async () => {
    const { app, owner, fake } = await connected();
    await call(app, "POST", "/api/integrations/whatsapp/connect", owner, WA);
    const customer = (await call(app, "POST", "/api/customers", owner, { kind: "individual", name: "Mona Saeed", phone: "050 765 4321" })).body.customer;
    const queued = await call(app, "POST", "/api/messages", owner, {
      event: "invoice_issued", channel: "whatsapp", customerId: customer.id, recipient: "971507654321", body: "Your invoice INV-00001",
      attachment: { fileName: "INV-00001.pdf", base64: PDF }, wa: { name: "invoice_ready", language: "en", params: ["Mona Saeed", "INV-00001"] },
    });
    expect(queued.body.message.status).toBe("queued");
    await app.integrations!.runOnce(new Date());
    const m = (await call(app, "GET", `/api/messages/${queued.body.message.id}`, owner)).body.message;
    expect(m).toMatchObject({ status: "sent", providerId: "wamid.2", senderPlace: "cloud" });
    const upload = fake.calls.find((c) => c.path === "/graph/1099/media")!;
    expect(String(upload.headers["content-type"])).toMatch(/multipart\/form-data/);
    expect(String(upload.body)).toContain("INV-00001.pdf");
    const msg = fake.calls.find((c) => c.path === "/graph/1099/messages")!;
    expect(msg.body).toMatchObject({
      to: "971507654321",
      template: {
        name: "invoice_ready", language: { code: "en" },
        components: [
          { type: "header", parameters: [{ type: "document", document: { id: "media-1", filename: "INV-00001.pdf" } }] },
          { type: "body", parameters: [{ type: "text", text: "Mona Saeed" }, { type: "text", text: "INV-00001" }] },
        ],
      },
    });
    expect(app.db.get("SELECT data_base64 AS d FROM message_files")).toEqual({ d: "" });
  });

  it("not connected → failed with the reason", async () => {
    const { app, owner } = await connected();
    const queued = await call(app, "POST", "/api/messages", owner, { event: "test", channel: "whatsapp", recipient: "971501234567", body: "Hi", wa: { name: "hello_world", language: "en", params: [] } });
    await app.integrations!.runOnce(new Date());
    expect((await call(app, "GET", `/api/messages/${queued.body.message.id}`, owner)).body.message).toMatchObject({ status: "failed", error: expect.stringMatching(/isn't connected: Settings → Integrations/) });
  });

  it("webhook", async () => {
    const { app, owner } = await connected();
    await call(app, "POST", "/api/integrations/whatsapp/connect", owner, WA);
    const { verifyToken } = (await call(app, "GET", "/api/integrations/whatsapp", owner)).body;
    const verify = await app.inject({ method: "GET", url: `/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345` });
    expect([verify.statusCode, verify.body]).toEqual([200, "12345"]);
    expect((await app.inject({ method: "GET", url: "/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" })).statusCode).toBe(403);

    const q = (await call(app, "POST", "/api/messages", owner, { event: "test", channel: "whatsapp", recipient: "971501234567", body: "Hi", wa: { name: "hello_world", language: "en", params: [] } })).body.message;
    await app.integrations!.runOnce(new Date());
    const wamid = (await call(app, "GET", `/api/messages/${q.id}`, owner)).body.message.providerId;
    const delivered = statusHook(wamid, "delivered");
    expect((await hook(app, delivered)).statusCode).toBe(401);
    expect((await hook(app, delivered, sign(delivered, "wrong"))).statusCode).toBe(401);
    expect((await call(app, "GET", `/api/messages/${q.id}`, owner)).body.message.delivery).toBeNull();
    expect((await hook(app, delivered, sign(delivered))).statusCode).toBe(200);
    expect((await call(app, "GET", `/api/messages/${q.id}`, owner)).body.message.delivery).toBe("delivered");
    const read = statusHook(wamid, "read");
    await hook(app, read, sign(read));
    await hook(app, delivered, sign(delivered));
    expect((await call(app, "GET", `/api/messages/${q.id}`, owner)).body.message.delivery).toBe("read");
    const failed = statusHook(wamid, "failed", { errors: [{ code: 131026, title: "Message undeliverable" }] });
    await hook(app, failed, sign(failed));
    expect((await call(app, "GET", `/api/messages/${q.id}`, owner)).body.message).toMatchObject({ status: "failed", error: "WhatsApp: Message undeliverable" });
  });
});
