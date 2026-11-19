import { afterEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { dubaiDate } from "@ffgp/shared";
import { smtpMailer, type Mailer, type MailMessage } from "../src/messages/mailer";
import { queueReminders, sendDue } from "../src/messages/outbox";
import { call, makeApp, setUp, type App } from "./helpers";

const PDF = Buffer.from("%PDF-1.4 test").toString("base64");
const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

function fakeMailer(fail = false): Mailer & { sent: MailMessage[]; tries: number } {
  const m = {
    sent: [] as MailMessage[], tries: 0,
    async send(msg: MailMessage) {
      m.tries++;
      if (fail) throw new Error("Connection refused");
      m.sent.push(msg);
    },
  };
  return m;
}

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/messages", owner, { smtpHost: "mail.example.com", fromAddress: "garage@example.com", fromName: "Al Quoz Auto Care" });
  const customer = (await call(app, "POST", "/api/customers", owner, {
    kind: "company", name: "Gulf Fleet LLC", creditAllowed: true, creditLimitFils: 10_000_000, termsDays: 3,
  })).body.customer;
  const contact = (await call(app, "POST", `/api/customers/${customer.id}/contacts`, owner, {
    name: "Accounts", email: "accounts@gulffleet.ae", getsInvoices: true, getsStatements: true, language: "ar",
  })).body.contact;
  const queue = (body: Record<string, unknown>) =>
    call(app, "POST", "/api/messages", owner, { event: "invoice_issued", channel: "email", customerId: customer.id, recipient: "accounts@gulffleet.ae", subject: "Invoice", body: "Hello", ...body });
  return { app, owner, customer, contact, queue };
}

const row = (app: App, id: string) => app.db.get<Record<string, unknown>>("SELECT * FROM messages WHERE id = ?", [id])!;
const at = (t0: Date, ms: number) => new Date(t0.getTime() + ms);
const MIN = 60_000;

describe("outbox", () => {
  it("queued email is sent once with its attachment", async () => {
    const { app, queue } = await garage();
    const res = await queue({ attachment: { fileName: "INV-00001.pdf", base64: PDF } });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ status: "queued", fileName: "INV-00001.pdf" });
    const mailer = fakeMailer();
    expect(await sendDue(app.db, mailer, new Date(), "pc")).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent[0]).toMatchObject({ from: '"Al Quoz Auto Care" <garage@example.com>', to: "accounts@gulffleet.ae", subject: "Invoice", text: "Hello" });
    expect(mailer.sent[0]!.attachments[0]!.filename).toBe("INV-00001.pdf");
    expect(mailer.sent[0]!.attachments[0]!.content.toString()).toBe("%PDF-1.4 test");
    expect(row(app, res.body.message.id)).toMatchObject({ status: "sent", sender_place: "pc" });
    expect(await sendDue(app.db, mailer, new Date(), "pc")).toEqual({ sent: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(1);
  });

  it("retries 1/5/30 then failed", async () => {
    const { app, queue } = await garage();
    const id = (await queue({})).body.message.id;
    const mailer = fakeMailer(true);
    const t0 = new Date();
    await sendDue(app.db, mailer, t0, "pc");
    expect(row(app, id)).toMatchObject({ status: "queued", attempts: 1 });
    await sendDue(app.db, mailer, at(t0, 30_000), "pc");
    expect(mailer.tries).toBe(1);
    await sendDue(app.db, mailer, at(t0, MIN), "pc");
    expect(row(app, id)).toMatchObject({ status: "queued", attempts: 2 });
    await sendDue(app.db, mailer, at(t0, 6 * MIN), "pc");
    expect(row(app, id)).toMatchObject({ status: "queued", attempts: 3 });
    await sendDue(app.db, mailer, at(t0, 35 * MIN), "pc");
    expect(row(app, id).status).toBe("queued");
    expect(await sendDue(app.db, mailer, at(t0, 36 * MIN), "pc")).toEqual({ sent: 0, failed: 1 });
    expect(row(app, id)).toMatchObject({ status: "failed", attempts: 4, error: "Connection refused" });
    expect(mailer.tries).toBe(4);
  });

  it("no mailbox fails at once", async () => {
    const { app, queue } = await garage();
    const id = (await queue({})).body.message.id;
    expect(await sendDue(app.db, null, new Date(), "pc")).toEqual({ sent: 0, failed: 1 });
    expect(row(app, id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(String(row(app, id).error)).toContain("isn't set up");
  });

  it("failed messages can be retried", async () => {
    const { app, owner, queue } = await garage();
    const id = (await queue({})).body.message.id;
    await sendDue(app.db, null, new Date(), "pc");
    expect((await call(app, "GET", "/api/messages?status=failed", owner)).body.messages.map((m: { id: string }) => m.id)).toEqual([id]);
    expect((await call(app, "POST", `/api/messages/${id}/retry`, owner)).body.message).toMatchObject({ status: "queued", attempts: 0, error: null });
    const mailer = fakeMailer();
    await sendDue(app.db, mailer, new Date(), "pc");
    expect(row(app, id).status).toBe("sent");
  });

  it("dedupe: the same key twice gives one message", async () => {
    const { app, queue } = await garage();
    const a = (await queue({ dedupeKey: "invoice_issued:d1:accounts@gulffleet.ae" })).body.message;
    const b = (await queue({ dedupeKey: "invoice_issued:d1:accounts@gulffleet.ae" })).body.message;
    expect(b.id).toBe(a.id);
    expect(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages")!.n).toBe(1);
  });

  it("whatsapp is only logged", async () => {
    const { app, queue } = await garage();
    const msg = (await queue({ channel: "whatsapp", recipient: "971501234567" })).body.message;
    expect(msg.status).toBe("opened");
    const mailer = fakeMailer();
    await sendDue(app.db, mailer, new Date(), "pc");
    expect(mailer.tries).toBe(0);
  });

  it("bad input is refused", async () => {
    const { queue } = await garage();
    expect((await queue({ recipient: "not-an-email" })).status).toBe(400);
    expect((await queue({ event: "party" })).status).toBe(400);
    expect((await queue({ attachment: { fileName: "x.pdf", base64: "a".repeat(4 * 1024 * 1024 + 4) } })).status).toBe(400);
  });

  it("queuing calls onMessageQueued for email only", async () => {
    let calls = 0;
    const { buildApp } = await import("../src/app");
    const { tempDir } = await import("./helpers");
    const app = await buildApp({ dataDir: tempDir(), onMessageQueued: () => calls++ });
    try {
      const owner = await setUp(app);
      const c = (await call(app, "POST", "/api/customers", owner, { name: "M" })).body.customer;
      await call(app, "POST", "/api/messages", owner, { event: "test", channel: "email", customerId: c.id, recipient: "a@b.ae", subject: "T", body: "T" });
      await call(app, "POST", "/api/messages", owner, { event: "vehicle_ready", channel: "whatsapp", customerId: c.id, recipient: "971501234567", body: "T" });
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("test email queues a real message (owner only)", async () => {
    const { app, owner } = await garage();
    const { addUser } = await import("./helpers");
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "POST", "/api/messages/test", advisor, { to: "me@example.com" })).status).toBe(403);
    const msg = (await call(app, "POST", "/api/messages/test", owner, { to: "me@example.com" })).body.message;
    expect(msg).toMatchObject({ event: "test", status: "queued", recipient: "me@example.com" });
  });
});

describe("reminders", () => {
  async function withInvoice() {
    const g = await garage();
    const inv = (await call(g.app, "POST", "/api/documents", g.owner, { type: "invoice", customerId: g.customer.id, lines: [LINE] })).body.document;
    const issued = (await call(g.app, "POST", `/api/documents/${inv.id}/issue`, g.owner)).body.document;
    const m = (await call(g.app, "GET", "/api/settings", g.owner)).body.settings.messages;
    await call(g.app, "PUT", "/api/settings/messages", g.owner, { ...m, payment_due: { ...m.payment_due, on: true }, payment_overdue: { ...m.payment_overdue, on: true } });
    return { ...g, inv: issued };
  }
  const today = () => dubaiDate(new Date().toISOString());
  const plus = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  it("an invoice due in 3 days gets one reminder in its contact's language", async () => {
    const { app, inv } = await withInvoice();
    expect(inv.dueDate).toBe(plus(today(), 3));
    expect(queueReminders(app.db, today())).toBe(1);
    expect(queueReminders(app.db, today())).toBe(0);
    const m = app.db.get<{ event: string; recipient: string; body: string; status: string }>("SELECT event, recipient, body, status FROM messages")!;
    expect(m).toMatchObject({ event: "payment_due", recipient: "accounts@gulffleet.ae", status: "queued" });
    expect(m.body).toContain("عزيزي Accounts");
    expect(m.body).toContain(inv.number);
    expect(m.body).toContain("AED 105.00");
  });

  it("an invoice overdue by 7 days gets the overdue reminder", async () => {
    const { app } = await withInvoice();
    expect(queueReminders(app.db, plus(today(), 10))).toBe(1);
    expect(app.db.get("SELECT event FROM messages")).toEqual({ event: "payment_overdue" });
  });

  it("reminders off or a paid invoice send nothing", async () => {
    const { app, owner, inv, customer } = await withInvoice();
    const gross = inv.totals.grossFils;
    const paid = await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: gross, method: "cash", allocations: [{ documentId: inv.id, amountFils: gross }] });
    expect(paid.status).toBe(200);
    expect(queueReminders(app.db, today())).toBe(0);
    const m = (await call(app, "GET", "/api/settings", owner)).body.settings.messages;
    await call(app, "PUT", "/api/settings/messages", owner, { ...m, payment_due: { ...m.payment_due, on: false } });
    expect(queueReminders(app.db, today())).toBe(0);
  });

  it("statements due: customers with a balance and a statements contact, until one is sent", async () => {
    const { app, owner, customer } = await withInvoice();
    const due = (await call(app, "GET", "/api/messages/statements-due", owner)).body.customers;
    expect(due.map((c: { id: string }) => c.id)).toEqual([customer.id]);
    await call(app, "POST", "/api/messages", owner, { event: "statement", channel: "email", customerId: customer.id, recipient: "accounts@gulffleet.ae", subject: "S", body: "S" });
    expect((await call(app, "GET", "/api/messages/statements-due", owner)).body.customers).toEqual([]);
  });
});

describe("smtp", () => {
  let server: SMTPServer | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("sends through a real SMTP server with the attachment", async () => {
    const received: string[] = [];
    let user = "";
    server = new SMTPServer({
      secure: false, disabledCommands: ["STARTTLS"], allowInsecureAuth: true, authOptional: false,
      onAuth(auth, _s, cb) { user = `${auth.username}:${auth.password}`; cb(null, { user: auth.username }); },
      onData(stream, _s, cb) { const chunks: Buffer[] = []; stream.on("data", (c: Buffer) => chunks.push(c)); stream.on("end", () => { received.push(Buffer.concat(chunks).toString()); cb(); }); },
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    const mailer = smtpMailer({ smtpHost: "127.0.0.1", smtpPort: port, smtpSecurity: "none", smtpUser: "garage@example.com", fromName: null, fromAddress: "garage@example.com" }, "pw");
    await mailer.send({ from: "garage@example.com", to: "x@example.com", subject: "Invoice INV-00001", text: "Hello", attachments: [{ filename: "INV-00001.pdf", content: Buffer.from("%PDF-1.4 test") }] });
    expect(user).toBe("garage@example.com:pw");
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("Subject: Invoice INV-00001");
    expect(received[0]).toMatch(/filename=.?INV-00001\.pdf/);
    expect(received[0]).toContain(Buffer.from("%PDF-1.4 test").toString("base64"));
  });
});
