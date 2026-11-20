import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Db, SCHEMA_VERSION, startGarageServer, type Mailer, type MailMessage } from "@ffgp/server";
import { installCapture, localChanges } from "@ffgp/sync";
import { api, garageReady, makeClock, SETUP, startCloud } from "./helpers";

// A cloud and a PC per test, each garage built through every migration: Windows CI runners need well over 30 s.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

function fakeMailer() {
  const sent: MailMessage[] = [];
  const mailer: Mailer = { async send(m) { sent.push(m); } };
  return { sent, mailerFor: () => mailer };
}

const dev = (garage: string, key: string) => ({ "x-ffgp-garage": garage, "x-ffgp-device-key": key });
async function jsonCall(url: string, method: string, path: string, garage: string, key: string, body?: unknown) {
  const res = await fetch(url + path, {
    method, headers: { ...dev(garage, key), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const MAIL = { smtpHost: "mail.example.com", fromAddress: "garage@example.com" };

/** Writes a queued email straight into a garage database (as a PC's screen would through its own server). */
function queueInto(db: Db, id: string) {
  const t = new Date().toISOString();
  db.run(
    `INSERT INTO messages (id, event, channel, recipient, subject, body, status, created_at, updated_at)
     VALUES (?, 'test', 'email', 'me@example.com', 'Test', 'Hello', 'queued', ?, ?)`,
    [id, t, t],
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cloud outbox", () => {
  it("linked PC never sends; cloud sends a pushed message once", async () => {
    const mail = fakeMailer();
    const cloud = await startCloud({ mailerFor: mail.mailerFor });
    const { token } = await garageReady(cloud, "alquoz-auto");
    await api(cloud.url, "PUT", "/api/settings/messages", { garage: "alquoz-auto", token, body: MAIL });
    const l = await api(cloud.url, "POST", "/api/cloud/sync/link", { garage: "alquoz-auto", body: { mode: "download", username: "rashid", password: SETUP.owner.password, deviceName: "PC" } });
    const key = l.body.deviceKey as string;
    const snap = await fetch(`${cloud.url}/api/cloud/sync/snapshot`, { headers: dev("alquoz-auto", key) });
    const since = Number(snap.headers.get("x-ffgp-sync-seq"));
    const bytes = new Uint8Array(await snap.arrayBuffer());

    // The PC's own server, linked (numbers come from the cloud): it must leave the queued email alone.
    const linkedDir = mkdtempSync(join(tmpdir(), "ffgp-linked-"));
    writeFileSync(join(linkedDir, "garage.db"), bytes);
    const seed = new Db(join(linkedDir, "garage.db"));
    queueInto(seed, "m-linked");
    seed.close();
    const linked = await startGarageServer({ dataDir: linkedDir, app: { numbers: { reserve: async () => null } as never } });
    await wait(400);
    expect(linked.db.get("SELECT status FROM messages WHERE id = 'm-linked'")).toEqual({ status: "queued" });
    await linked.close();

    // Control: the same PC unlinked is the sender (no password here, so it fails at once instead of waiting).
    const standaloneDir = mkdtempSync(join(tmpdir(), "ffgp-standalone-"));
    writeFileSync(join(standaloneDir, "garage.db"), bytes);
    const seed2 = new Db(join(standaloneDir, "garage.db"));
    queueInto(seed2, "m-standalone");
    seed2.close();
    const standalone = await startGarageServer({ dataDir: standaloneDir });
    await wait(400);
    expect(standalone.db.get("SELECT status FROM messages WHERE id = 'm-standalone'")).toEqual({ status: "failed" });
    await standalone.close();

    // The linked PC's message reaches the cloud by sync; the cloud sends it once.
    const pcDir = mkdtempSync(join(tmpdir(), "ffgp-pc-"));
    writeFileSync(join(pcDir, "garage.db"), bytes);
    const pc = new Db(join(pcDir, "garage.db"));
    installCapture(pc, "local");
    queueInto(pc, "m1");
    const push = await jsonCall(cloud.url, "POST", "/api/cloud/sync/push", "alquoz-auto", key, { schema: SCHEMA_VERSION, entries: localChanges(pc, 0) });
    expect(push.status).toBe(200);
    await cloud.outbox.runOnce();
    expect(mail.sent.map((m) => m.to)).toEqual(["me@example.com"]);
    await cloud.outbox.runOnce();
    expect(mail.sent).toHaveLength(1);

    const pull = await jsonCall(cloud.url, "GET", `/api/cloud/sync/pull?since=${since}&schema=${SCHEMA_VERSION}`, "alquoz-auto", key);
    const update = pull.body.entries.filter((e: { table: string; rowId: string }) => e.table === "messages").at(-1);
    expect(update.data).toMatchObject({ id: "m1", status: "sent", sender_place: "cloud" });
    pc.close();
  });

  it("browser-queued message is sent", async () => {
    const mail = fakeMailer();
    const cloud = await startCloud({ mailerFor: mail.mailerFor });
    const { token } = await garageReady(cloud, "alquoz-auto");
    await api(cloud.url, "PUT", "/api/settings/messages", { garage: "alquoz-auto", token, body: MAIL });
    const queued = await api(cloud.url, "POST", "/api/messages/test", { garage: "alquoz-auto", token, body: { to: "owner@example.com" } });
    expect(queued.body.message.status).toBe("queued");
    await cloud.outbox.runOnce();
    expect(mail.sent.map((m) => m.to)).toEqual(["owner@example.com"]);
    const after = await api(cloud.url, "GET", `/api/messages/${queued.body.message.id}`, { garage: "alquoz-auto", token });
    expect(after.body.message).toMatchObject({ status: "sent", senderPlace: "cloud" });
    // After the first (daily) round only marked garages are visited: queuing marks the garage.
    await api(cloud.url, "POST", "/api/messages/test", { garage: "alquoz-auto", token, body: { to: "second@example.com" } });
    await cloud.outbox.runOnce();
    expect(mail.sent.map((m) => m.to)).toEqual(["owner@example.com", "second@example.com"]);
  });

  it("I3: a read-only garage (subscription ended) sends nothing from the cloud", async () => {
    const mail = fakeMailer();
    const clock = makeClock();
    const cloud = await startCloud({ mailerFor: mail.mailerFor, now: clock.now });
    const { token } = await garageReady(cloud, "alquoz-auto", clock.now);
    await api(cloud.url, "PUT", "/api/settings/messages", { garage: "alquoz-auto", token, body: MAIL });
    await api(cloud.url, "POST", "/api/messages/test", { garage: "alquoz-auto", token, body: { to: "owner@example.com" } });
    clock.advanceDays(400);
    await cloud.outbox.runOnce();
    expect(mail.sent).toEqual([]);
  });
});
