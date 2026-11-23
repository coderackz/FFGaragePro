import { expect, test, type Page } from "@playwright/test";
import { OWNER, setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const LINE = (fils: number) => ({ kind: "labour", description: "Fleet service", qty: 1, unitPriceFils: fils, discountPct: 0 });

test.describe.serial("credit customers", () => {
  let customerId = "";

  test("credit customer: three invoices, one transfer, statement at zero", async ({ page, request }) => {
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    page.on("dialog", (d) => void d.accept()); // "Issue this tax invoice?"
    const shot = shooter(page, "credit-");
    await page.goto("/");
    await setUpGarage(page);

    // A company on credit: 30 days, limit AED 1,000.
    await nav(page, "Customers");
    await page.getByRole("button", { name: "New customer" }).click();
    await page.getByLabel("Type").selectOption("company");
    await page.getByLabel("Company name").fill("Emirates Logistics LLC");
    await page.getByLabel("Allow credit (pays later, by its payment terms)").check();
    await page.getByLabel("Credit limit", { exact: true }).fill("1000");
    await page.getByLabel("Payment terms", { exact: true }).fill("30");
    await page.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByRole("heading", { name: "Emirates Logistics LLC" })).toBeVisible();
    customerId = page.url().split("/customers/")[1]!;

    // Two invoices issued already; the third goes over the limit and warns.
    const headers = { authorization: `Bearer ${await token(page)}` };
    for (const net of [40000, 40000]) {
      const d = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "invoice", customerId, lines: [LINE(net)] } })).json()).document;
      await request.post(`${API}/api/documents/${d.id}/issue`, { headers, data: {} });
    }
    const third = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "invoice", customerId, lines: [LINE(30000)] } })).json()).document;
    await page.goto(`/#/documents/${third.id}`);
    await page.getByRole("button", { name: "Issue invoice" }).click();
    await expect(page.getByText("Over the credit limit by AED 155.00")).toBeVisible();
    await shot("01-over-limit-warning");

    // One transfer pays all three, oldest first.
    await page.goto(`/#/customers/${customerId}`);
    await expect(page.getByTestId("account")).toContainText("AED 1,155.00");
    await page.getByRole("button", { name: "Receive payment" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Amount")).toHaveValue("1155.00");
    await dialog.getByLabel("Reference").fill("TT 4471");
    await shot("02-receive-payment");
    await dialog.getByRole("button", { name: "Save AED 1,155.00" }).click();
    await expect(page.getByText("RCT-00001 saved")).toBeVisible();
    await expect(page.getByTestId("account")).toContainText("AED 0.00");

    // The month's statement ends at zero; nobody owes anything.
    const month = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 7);
    const s = (await (await request.get(`${API}/api/customers/${customerId}/statement?from=${month}-01&to=${month}-28`, { headers })).json()).statement;
    expect(s.closingFils).toBe(0);
    await nav(page, "Aging");
    await expect(page.getByText("Nobody owes anything")).toBeVisible();
  });

  test("credit note on a paid invoice becomes customer credit, then a refund", async ({ page }) => {
    const shot = shooter(page, "credit-");
    await page.goto("/");
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await nav(page, "Invoices");
    await page.getByRole("cell", { name: "INV-00001" }).click();
    await page.getByRole("button", { name: "Credit note" }).click();
    await page.getByLabel("Reason").fill("Duplicate labour charge");
    await page.getByRole("button", { name: "Issue credit note" }).click();
    await expect(page.getByRole("heading", { name: /CN-00001/ })).toBeVisible();
    await expect(page.getByTestId("credit-reason")).toHaveText("Duplicate labour charge");
    await shot("03-credit-note");

    await page.goto(`/#/customers/${customerId}`);
    await expect(page.getByTestId("account")).toContainText("Unused payments (credit)");
    await expect(page.getByTestId("account")).toContainText("AED 420.00");
    await page.getByRole("button", { name: "Refund" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Refund AED 420.00" }).click();
    await expect(page.getByText(/Refund RCT-00002 saved/)).toBeVisible();
    await expect(page.getByTestId("account")).not.toContainText("Unused payments");
    await shot("04-after-refund");

    // A payment put against the wrong invoice is taken back off; it becomes credit again.
    page.on("dialog", (d) => void d.accept());
    await nav(page, "Invoices");
    await page.getByRole("cell", { name: "INV-00002", exact: true }).click();
    await page.getByRole("button", { name: "Undo RCT-00001" }).click();
    await expect(page.getByText("Payment taken back off")).toBeVisible();
    await page.goto(`/#/customers/${customerId}`);
    await expect(page.getByTestId("account")).toContainText("Unused payments (credit)");
  });

  test("bilingual invoice renders Arabic", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    const shot = shooter(page, "arabic-");
    await page.goto("/");
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // The garage's Arabic name.
    await nav(page, "Settings");
    await page.getByTestId("tile-garage").click();
    await page.getByLabel("Arabic name").fill("العناية بالسيارات");
    const saved = page.waitForResponse((r) => r.url().includes("/api/settings/garage") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "Save" }).click();
    expect((await saved).ok()).toBe(true);

    // The preview in Documents & printing switches to English + Arabic and draws it with the Arabic font.
    await page.getByRole("link", { name: "All settings" }).click();
    await page.getByTestId("tile-documents").click();
    await page.getByRole("button", { name: "English + Arabic" }).click();
    const preview = page.frameLocator('[data-testid="print-preview"]');
    await expect(preview.getByText("الإجمالي شامل الضريبة", { exact: false })).toBeVisible();
    await expect(preview.locator(".ar-block .name")).toHaveText("العناية بالسيارات");
    const fontReady = await preview.locator("body").evaluate(async (body) => {
      const doc = body.ownerDocument;
      await doc.fonts.ready;
      await doc.fonts.load('16px "Noto Naskh Arabic"', "عربي");
      return doc.fonts.check('16px "Noto Naskh Arabic"', "عربي");
    });
    expect(fontReady).toBe(true);
    await shot("01-preview");

    // A customer who wants English + Arabic documents; their invoice says so.
    await nav(page, "Customers");
    await page.getByRole("button", { name: "New customer" }).click();
    await page.getByLabel("Full name").fill("Mohammed Al Marri");
    await page.getByLabel("Arabic name").fill("محمد المري");
    await page.getByLabel("Document language").selectOption("en_ar");
    await page.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByRole("heading", { name: "Mohammed Al Marri" })).toBeVisible();
    const id = page.url().split("/customers/")[1]!;
    const headers = { authorization: `Bearer ${await token(page)}` };
    const doc = (await (await page.request.post(`${API}/api/documents`, { headers, data: { type: "invoice", customerId: id, lines: [LINE(10000)] } })).json()).document;
    // The document takes the customer's language (there's no language box on the document screen).
    expect(doc.language).toBe("en_ar");
    await page.goto(`/#/documents/${doc.id}`);
    await page.getByRole("button", { name: "Issue invoice" }).click();
    await expect(page.getByText(/issued$/)).toBeVisible();
    await shot("02-invoice");
  });
});
