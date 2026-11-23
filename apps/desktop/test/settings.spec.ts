import { expect, test, type Page } from "@playwright/test";
import { OWNER, setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const TERMS = "Payment due within 30 days. Cheques payable to Al Quoz Auto Care LLC.";
const ADVISOR = { name: "Sara Advisor", username: "sara", password: "sara-pass-1" };

const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const tokenOf = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

/** Clicks Save and waits for that section's save to succeed (toasts from earlier saves may still be showing). */
async function save(page: Page) {
  const saved = page.waitForResponse((r) => /\/api\/settings(\/[a-z]+)?$/.test(new URL(r.url()).pathname) && ["PUT", "PATCH"].includes(r.request().method()));
  await page.getByRole("button", { name: "Save" }).click();
  expect((await saved).ok()).toBe(true);
}

async function signIn(page: Page, who: { username: string; password: string }) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe.serial("settings", () => {
  test("owner sets up the garage from Settings", async ({ page, request }) => {
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    const shot = shooter(page, "settings-");
    await page.goto("/");
    await setUpGarage(page);

    // Home: what's left to do.
    await nav(page, "Settings");
    await expect(page.getByTestId("tile-documents")).toContainText("Logo missing");
    await expect(page.getByTestId("getting-ready")).toContainText("Bank details");
    await shot("01-home");

    // Garage details: bank and IBAN.
    await page.getByTestId("tile-garage").click();
    await page.getByLabel("Bank").fill("Emirates NBD");
    await page.getByLabel("Account name").fill("Al Quoz Auto Care LLC");
    await page.getByLabel("IBAN").fill("ae07 0260 0010 1234 5678 901");
    await save(page);
    await page.getByRole("link", { name: "All settings" }).click();
    await expect(page.getByTestId("tile-garage")).toContainText("Complete");

    // Documents & printing: the preview shows the terms before they're saved.
    await page.getByTestId("tile-documents").click();
    await page.getByLabel("Logo file").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Invoice terms & footer").fill(TERMS);
    const preview = page.frameLocator('[data-testid="print-preview"]');
    await expect(preview.getByText(TERMS)).toBeVisible();
    await expect(preview.locator("img.logo")).toHaveCount(1);
    await shot("02-documents");
    await save(page);

    // Pricing: labour rate and the advisor's limit.
    await page.getByRole("link", { name: "All settings" }).click();
    await page.getByTestId("tile-pricing").click();
    await page.getByLabel("Labour rate").fill("180");
    await page.getByLabel("Largest discount for Service Advisor").fill("10");
    await save(page);

    // Numbering: invoices continue from 500.
    await page.getByRole("link", { name: "All settings" }).click();
    await page.getByTestId("tile-numbering").click();
    await page.getByLabel("Next invoices number").fill("500");
    await expect(page.getByTestId("next-invoice")).toHaveText("INV-00500");
    await save(page);

    // Everything essential is set: the Getting ready bar is gone.
    await page.getByRole("link", { name: "All settings" }).click();
    await expect(page.getByTestId("tile-pricing")).toContainText("AED 180.00 / hour");
    await expect(page.getByTestId("getting-ready")).toHaveCount(0);
    await shot("03-home-ready");

    // The activity log has the changes in plain words.
    await page.getByTestId("tile-activity").click();
    await expect(page.getByTestId("activity-log")).toContainText("Changed Pricing — Labour rate: not set → AED 180.00");
    await expect(page.getByTestId("activity-log")).toContainText("Changed Documents & printing — Logo: not set → new image");

    // Users live in Settings now.
    await page.goto("/#/users");
    await expect(page).toHaveURL(/#\/settings\/users$/);
    await expect(page.getByRole("heading", { name: "Users & roles" })).toBeVisible();

    // An invoice takes the next number from Settings, and its second print says COPY.
    const headers = { authorization: `Bearer ${await tokenOf(page)}` };
    await request.post(`${API}/api/users`, { headers, data: { ...ADVISOR, role: "advisor" } });
    const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { name: "Mohammed Al Marri" } })).json()).customer;
    const line = { kind: "labour", description: "Diagnostics", qty: 1, unitPriceFils: 18000, discountPct: 0 };
    const invoice = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "invoice", customerId: customer.id, lines: [line] } })).json()).document;
    expect(invoice.number).toBe("INV-00500");
    await request.post(`${API}/api/documents/${invoice.id}/issue`, { headers });
    expect((await (await request.post(`${API}/api/documents/${invoice.id}/prints`, { headers })).json()).count).toBe(1);
    expect((await (await request.post(`${API}/api/documents/${invoice.id}/prints`, { headers })).json()).count).toBe(2);

    // The advisor: no Settings; a 15% discount needs the Owner, who approves on the spot.
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(page, ADVISOR);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
    await page.goto(`/#/documents/new/estimate?customerId=${customer.id}`);
    await expect(page.getByLabel("Unit price").first()).toHaveValue(/180/);
    await page.getByPlaceholder("e.g. Replace front brake pads").fill("Full service");
    await page.getByLabel("Discount percent").first().fill("15");
    // Auto-save stops at the approval and asks for it in the header.
    await page.getByRole("button", { name: "Approve and save" }).click();
    const approval = page.getByRole("dialog", { name: "Owner approval" });
    await expect(approval).toContainText("A discount over 10% needs the Owner's approval");
    await approval.getByLabel("Owner's username").fill(OWNER.username);
    await approval.getByLabel("Owner's password").fill(OWNER.password);
    await shot("04-owner-approval");
    await approval.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("EST-00001")).toBeVisible();
  });

  test("screen locks when idle and unlocks with the password, work intact", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await signIn(page, OWNER);
    await nav(page, "Settings");
    await page.getByTestId("tile-security").click();
    await page.getByLabel("Lock after").selectOption("5");
    await save(page);

    await nav(page, "Customers");
    await page.getByRole("button", { name: "New customer" }).click();
    await page.getByLabel("Name").first().fill("Half-typed customer");
    await page.clock.fastForward("05:10");
    const lock = page.getByRole("dialog", { name: "Locked" });
    await expect(lock).toBeVisible();
    // Nothing behind the lock can be reached with Tab or typed into.
    expect(await page.evaluate(() => document.getElementById("root")?.inert)).toBe(true);
    await lock.getByLabel("Password").fill("wrong-password");
    await lock.getByRole("button", { name: "Unlock" }).click();
    await expect(lock).toContainText("That password isn't right");
    await lock.getByLabel("Password").fill(OWNER.password);
    await lock.getByRole("button", { name: "Unlock" }).click();
    await expect(lock).toHaveCount(0);
    expect(await page.evaluate(() => document.getElementById("root")?.inert)).toBe(false);
    await expect(page.getByLabel("Name").first()).toHaveValue("Half-typed customer");
  });
});
