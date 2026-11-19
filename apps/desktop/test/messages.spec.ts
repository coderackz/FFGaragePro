import { expect, test, type Page } from "@playwright/test";
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
});
