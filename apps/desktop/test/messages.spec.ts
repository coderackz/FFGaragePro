import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { SMTPServer } from "smtp-server";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

/** A mail server for the test: keeps every message it receives (raw). */
async function mailSink() {
  const mails: { to: string[]; raw: string }[] = [];
  const server = new SMTPServer({
    secure: false, disabledCommands: ["STARTTLS"], allowInsecureAuth: true,
    onAuth(_a, _s, cb) { cb(null, { user: "garage" }); },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        mails.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString() });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  return { mails, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test.describe.serial("messages", () => {
  let sink: Awaited<ReturnType<typeof mailSink>>;
  test.beforeAll(async () => {
    sink = await mailSink();
  });
  test.afterAll(async () => {
    await sink.close();
  });

  test("set up email and send a test", async ({ page }) => {
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    const shot = shooter(page, "messages-");
    await page.goto("/");
    await setUpGarage(page);

    await nav(page, "Settings");
    await page.getByTestId("tile-messages").click();
    await expect(page.getByRole("heading", { name: "Messages", exact: true })).toBeVisible();
    await page.getByLabel("Mail server").fill("127.0.0.1");
    await page.getByLabel("Port").fill(String(sink.port));
    await page.getByLabel("Security").selectOption("none");
    await page.getByLabel("Username").fill("garage@example.com");
    await page.getByLabel("From name").fill("Al Quoz Auto Care");
    await page.getByLabel("From address").fill("garage@example.com");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    await expect(page.getByTestId("smtp-password")).toHaveText("Not set");
    await page.getByRole("button", { name: "Set password" }).click();
    await page.getByLabel("New password").fill("mail-pass-1");
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page.getByTestId("smtp-password")).toHaveText("Set");
    await expect(page.getByLabel("New password")).toHaveCount(0);

    // A placeholder that doesn't exist is caught next to the field, before saving.
    await page.getByText("Invoice issued", { exact: true }).click();
    const textEn = page.getByLabel("Invoice issued — text (English)");
    await textEn.fill("Hi {name}, your invoice {doc_number}");
    await expect(page.getByText("Unknown placeholder {name}")).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();

    await page.getByLabel("Send a test to").fill("owner@example.com");
    await page.getByRole("button", { name: "Send test email" }).click();
    await expect(page.getByTestId("test-email-status")).toHaveText("Sent", { timeout: 20_000 });
    expect(sink.mails).toHaveLength(1);
    expect(sink.mails[0]!.to).toEqual(["owner@example.com"]);
    expect(sink.mails[0]!.raw).toContain("Test email from Al Quoz Auto Care");
    await shot("01-settings");
  });

  test("customer contacts and a job card driver", async ({ page, request }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill("rashid");
    await page.getByLabel("Password").fill("garage-pass-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Customers", exact: true })).toBeVisible();
    const headers = { authorization: `Bearer ${await token(page)}` };
    const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { kind: "company", name: "Gulf Fleet LLC", email: "office@gulffleet.ae" } })).json()).customer;

    await page.goto(`/#/customers/${customer.id}`);
    await page.getByRole("tab", { name: "Contacts" }).click();
    await page.getByRole("button", { name: "Add contact" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Accounts");
    await page.getByLabel("Email", { exact: true }).fill("accounts@gulffleet.ae");
    await page.getByLabel("Message language").selectOption("ar");
    await page.getByLabel("Invoices & receipts").check();
    await page.getByLabel("Statements").check();
    await page.getByRole("button", { name: "Save contact" }).click();
    const row = page.getByTestId("contacts").getByRole("row", { name: /Accounts/ });
    await expect(row).toContainText("accounts@gulffleet.ae");
    await expect(row).toContainText("Invoices");
    await expect(row).toContainText("Arabic");

    const jc = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "jobcard", customerId: customer.id } })).json()).document;
    await page.goto(`/#/documents/${jc.id}`);
    await page.getByLabel("Driver name").fill("Ali");
    await page.getByLabel("Driver phone").fill("050 123 4567");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Job card saved")).toBeVisible();
    const saved = (await (await request.get(`${API}/api/documents/${jc.id}`, { headers })).json()).document;
    expect(saved).toMatchObject({ driverName: "Ali", driverPhone: "050 123 4567" });
  });

  /** Signs in and returns API headers. */
  async function signIn(page: Page) {
    await page.goto("/");
    await page.getByLabel("Username").fill("rashid");
    await page.getByLabel("Password").fill("garage-pass-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Customers", exact: true })).toBeVisible();
    return { authorization: `Bearer ${await token(page)}` };
  }

  /** Changes some Messages settings through the API, keeping the rest. */
  async function setMessages(request: APIRequestContext, headers: Record<string, string>, change: (m: any) => any) {
    const m = (await (await request.get(`${API}/api/settings`, { headers })).json()).settings.messages;
    const res = await request.put(`${API}/api/settings/messages`, { headers, data: change(m) });
    expect(res.status()).toBe(200);
  }

  /** The first attachment of a raw email, decoded. */
  function attachment(raw: string): { name: string; bytes: Buffer } {
    const m = /filename="?([^"\r\n]+)"?[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n--/.exec(raw);
    if (!m) throw new Error("no attachment");
    return { name: m[1]!, bytes: Buffer.from(m[2]!.replace(/\s+/g, ""), "base64") };
  }

  test("invoice issued emails the accounts contact with the PDF", async ({ page, request }) => {
    page.on("dialog", (d) => void d.accept()); // "Issue this tax invoice?"
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    const headers = await signIn(page);
    await setMessages(request, headers, (m) => ({ ...m, invoice_issued: { ...m.invoice_issued, mode: "auto", channel: "email" } }));
    await page.reload(); // the app reads settings when it starts
    const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { kind: "company", name: "Desert Logistics LLC" } })).json()).customer;
    await request.post(`${API}/api/customers/${customer.id}/contacts`, { headers, data: { name: "Accounts", email: "ap@desertlogistics.ae", getsInvoices: true } });
    await request.post(`${API}/api/customers/${customer.id}/contacts`, { headers, data: { name: "Driver Ahmed", phone: "0501112222", getsReady: true } });
    const inv = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "invoice", customerId: customer.id, lines: [{ kind: "labour", description: "Brake service", qty: 1, unitPriceFils: 45000, discountPct: 0 }] } })).json()).document;
    const before = sink.mails.length;

    await page.goto(`/#/documents/${inv.id}`);
    await page.getByRole("button", { name: "Issue invoice" }).click();
    await expect(page.getByText("Emailed to Accounts")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => sink.mails.length, { timeout: 40_000 }).toBe(before + 1);
    const mail = sink.mails.at(-1)!;
    expect(mail.to).toEqual(["ap@desertlogistics.ae"]);
    const file = attachment(mail.raw);
    expect(file.name).toMatch(/^INV-\d+.*\.pdf$/);
    expect(file.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await expect(page.getByTestId("message-log")).toContainText("Sent", { timeout: 20_000 });
    await expect(page.getByTestId("message-log")).toContainText("ap@desertlogistics.ae");

    // Issued once, sent once: reloading the page doesn't send it again.
    await page.reload();
    await expect(page.getByTestId("message-log")).toContainText("Sent");
    await page.waitForTimeout(1500);
    expect(sink.mails.length).toBe(before + 1);
  });

  test("vehicle ready asks and opens WhatsApp for the driver", async ({ page, request, context }) => {
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    await context.route("https://wa.me/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>WhatsApp</p>" }));
    const headers = await signIn(page);
    const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { kind: "company", name: "City Taxis LLC", email: "ops@citytaxis.ae" } })).json()).customer;
    const jc = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "jobcard", customerId: customer.id, driverName: "Ali", driverPhone: "050 123 4567" } })).json()).document;

    await page.goto(`/#/documents/${jc.id}`);
    await page.getByLabel("Status").selectOption("completed");
    // "Ask first" doesn't interrupt: a notification offers the message.
    await expect(page.getByText("Vehicle ready: Send a message?")).toBeVisible();
    await page.getByRole("button", { name: "Send message" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Vehicle ready")).toBeVisible();
    await expect(dialog.getByLabel("Send to")).toHaveValue(/Ali/);
    await expect(dialog.getByLabel("Message")).toHaveValue(/is ready for collection/);
    const popup = context.waitForEvent("page");
    await dialog.getByRole("button", { name: "Open WhatsApp" }).click();
    expect((await popup).url()).toMatch(/^https:\/\/wa\.me\/971501234567\?text=/);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("message-log")).toContainText("Opened in WhatsApp");
  });

  test("a template of the garage's own fills the message", async ({ page, request }) => {
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    const headers = await signIn(page);
    // Settings → Message templates: a WhatsApp and email template.
    await nav(page, "Settings");
    await page.getByTestId("tile-message-templates").click();
    await page.getByRole("button", { name: "New template" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name", { exact: true }).fill("Thank you note");
    await form.getByLabel("Subject (English)").fill("Thank you from {garage}");
    await form.getByLabel("Text (English)").fill("Dear {customer}, thank you for choosing {garage}.");
    await form.getByLabel("Text (Arabic)").fill("عزيزي {customer}، شكراً لاختياركم {garage}.");
    await form.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByRole("row", { name: /Thank you note/ })).toBeVisible();

    const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { kind: "individual", name: "Mona Saeed", phone: "050 765 4321" } })).json()).customer;
    const jc = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "jobcard", customerId: customer.id } })).json()).document;
    await page.goto(`/#/documents/${jc.id}`);
    await page.getByLabel("Status").selectOption("completed");
    await page.getByRole("button", { name: "Send message" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Template").selectOption({ label: "Thank you note" });
    await expect(dialog.getByLabel("Message")).toHaveValue(/^Dear Mona Saeed, thank you for choosing/);
  });

  test("failed message shows on the dashboard and retries", async ({ page, request }) => {
    const headers = await signIn(page);
    // A mail server that isn't there: tried 4 times (fast in tests), then failed.
    await setMessages(request, headers, (m) => ({ ...m, smtpPort: 1 }));
    const queued = (await (await request.post(`${API}/api/messages/test`, { headers, data: { to: "retry@example.com" } })).json()).message;
    await expect.poll(async () => (await (await request.get(`${API}/api/messages/${queued.id}`, { headers })).json()).message.status, { timeout: 30_000 }).toBe("failed");

    await page.goto("/");
    const card = page.getByTestId("failed-messages");
    await expect(card).toContainText("1 message didn't go");
    await expect(card).toContainText("retry@example.com");
    await setMessages(request, headers, (m) => ({ ...m, smtpPort: sink.port }));
    const before = sink.mails.length;
    await card.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => sink.mails.length, { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId("failed-messages")).toHaveCount(0, { timeout: 20_000 });
  });

  test("I8: a long document (20 pages) makes a sharp PDF in the browser, under the attachment limit", async ({ page }) => {
    await signIn(page);
    const rows = Array.from({ length: 20 }, (_, i) => `<div style="height:1100px;border-bottom:1px solid #000"><h2>Page ${i + 1}</h2><p>${"Statement line ".repeat(200)}</p></div>`).join("");
    const b64 = await page.evaluate(async (html) => {
      const path = "/messages/pdf.ts"; // the dev server's module (browser app path)
      const mod = (await import(/* @vite-ignore */ path)) as { makePdf(html: string): Promise<string> };
      return mod.makePdf(`<!doctype html><html><body style="margin:0;font-family:sans-serif">${html}</body></html>`);
    }, rows);
    const bytes = Buffer.from(b64, "base64");
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(b64.length).toBeLessThan(8 * 1024 * 1024);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(20);
    // Sharp on every page: each page is its own image, at least 1.4× the page width (not one tall image scaled down).
    const widths = pdf.context.enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))
      .map((o) => (o.dict.get(PDFName.of("Width")) as PDFNumber).asNumber());
    expect(widths).toHaveLength(20);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(1100);
  });
});

