import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_WA_TOKEN, startFakeProviders, type FakeProviders } from "../../../packages/server/src/integrations/fakes";
import { api, garageReady, startCloud } from "./helpers";

const fakes: FakeProviders[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });

describe("integrations in the cloud", () => {
  it("WhatsApp: sent by the outbox round; delivery comes back through /api/hooks/<garage code>/…", async () => {
    const fake = await startFakeProviders();
    fakes.push(fake);
    const cloud = await startCloud({ integrations: { publicUrl: "https://garagepro.test", endpoints: fake.endpoints } });
    const { token } = await garageReady(cloud, "alquoz-auto");
    const g = { garage: "alquoz-auto", token };
    await api(cloud.url, "POST", "/api/integrations/whatsapp/connect", { ...g, body: { phoneNumberId: "1099", businessAccountId: "2088", accessToken: FAKE_WA_TOKEN, appSecret: "app-secret" } });
    const info = (await api(cloud.url, "GET", "/api/integrations/whatsapp", g)).body;
    expect(info.webhookUrl).toMatch(/^https:\/\/garagepro\.test\/api\/hooks\/[^/]+\/whatsapp\/webhook$/i);
    const q = (await api(cloud.url, "POST", "/api/messages", { ...g, body: { event: "test", channel: "whatsapp", recipient: "971501234567", body: "Hi", wa: { name: "hello_world", language: "en", params: [] } } })).body.message;
    await cloud.outbox.runOnce();
    const sent = (await api(cloud.url, "GET", `/api/messages/${q.id}`, g)).body.message;
    expect(sent).toMatchObject({ status: "sent", senderPlace: "cloud" });

    const path = new URL(info.webhookUrl).pathname;
    const verify = await fetch(`${cloud.url}${path}?hub.mode=subscribe&hub.verify_token=${info.verifyToken}&hub.challenge=777`);
    expect([verify.status, await verify.text()]).toEqual([200, "777"]);
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: sent.providerId, status: "read" }] } }] }] });
    const sig = `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;
    const res = await fetch(`${cloud.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw });
    expect(res.status).toBe(200);
    expect((await api(cloud.url, "GET", `/api/messages/${q.id}`, g)).body.message.delivery).toBe("read");
    expect((await fetch(`${cloud.url}/api/hooks/no-such-garage/whatsapp/webhook`)).status).toBe(404);
  });
});
