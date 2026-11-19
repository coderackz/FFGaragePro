import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { OWNER, setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

test.describe.serial("books", () => {
  test("books from first sale to reports", async ({ page, request }) => {
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    page.on("dialog", (d) => void d.accept());
    const shot = shooter(page, "books-");
    await page.goto("/");
    await setUpGarage(page);

    // Start the books today.
    await nav(page, "Settings");
    await page.getByTestId("tile-books").click();
    await page.getByLabel("Books start date").fill(today());
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    // A sale paid in cash.
    const headers = { authorization: `Bearer ${await token(page)}` };
    const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { name: "Walk-in" } })).json()).customer;
    const inv = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "invoice", customerId: customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] } })).json()).document;
    await request.post(`${API}/api/documents/${inv.id}/issue`, { headers, data: {} });
    await request.post(`${API}/api/receipts`, { headers, data: { customerId: customer.id, amountFils: 10500, method: "cash" } });

    // Trial balance.
    await nav(page, "Books");
    await page.getByRole("link", { name: /Trial balance/ }).click();
    const tb = page.getByTestId("report");
    await expect(tb.getByRole("row", { name: /1000 Cash on hand/ })).toContainText("105.00");
    await expect(tb.getByRole("row", { name: /4000 Labour sales/ })).toContainText("100.00");
    await expect(tb.getByRole("row", { name: /2100 Output VAT/ })).toContainText("5.00");
    await expect(page.getByTestId("totals")).toContainText("105.00");
    await shot("01-trial-balance");

    // Excel export: a real .xlsx (a zip, starting "PK").
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Excel" }).click();
    const file = await (await download).path();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
    expect(readFileSync(file!).subarray(0, 2).toString()).toBe("PK");

    // Profit and loss.
    const profit = async () => {
      await nav(page, "Books");
      await page.getByRole("link", { name: /Profit and loss/ }).click();
      return page.getByTestId("net-profit");
    };
    await expect(await profit()).toHaveText("AED 100.00");

    // A rent journal from cash: profit 70.
    await nav(page, "Books");
    await page.getByRole("link", { name: /Journals/ }).click();
    await page.getByRole("button", { name: "New journal" }).click();
    await page.getByLabel("Narration").fill("Rent for the bay");
    await page.getByLabel("Account, line 1").selectOption({ label: "6010 Rent" });
    await page.getByLabel("Debit, line 1").fill("30");
    await page.getByLabel("Account, line 2").selectOption({ label: "1000 Cash on hand" });
    await page.getByLabel("Credit, line 2").fill("30");
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.getByRole("heading", { name: /^JV-\d+/ })).toBeVisible();
    await expect(await profit()).toHaveText("AED 70.00");

    // Reverse it: back to 100.
    await nav(page, "Books");
    await page.getByRole("link", { name: /Journals/ }).click();
    await page.getByRole("row", { name: /Rent for the bay/ }).first().click();
    await page.getByRole("button", { name: "Reverse" }).click();
    await expect(page.getByText(/Reversal of JV-/).first()).toBeVisible();
    await expect(await profit()).toHaveText("AED 100.00");

    // Books health: everything agrees.
    await nav(page, "Books");
    await page.getByRole("link", { name: /Books health/ }).click();
    for (const key of ["trial_balance", "receivables", "inventory", "output_vat", "opening_clearing"]) {
      await expect(page.getByTestId(`check-${key}`)).toContainText("OK");
    }
    await shot("02-health");
  });

  test("advisor sees no Books", async ({ page, request }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Customers", exact: true })).toBeVisible();
    const headers = { authorization: `Bearer ${await token(page)}` };
    await request.post(`${API}/api/users`, { headers, data: { name: "Sami Advisor", username: "sami", password: "advisor-pass-1", role: "advisor" } });
    await page.evaluate(() => sessionStorage.clear());
    await page.goto("/");
    await page.getByLabel("Username").fill("sami");
    await page.getByLabel("Password").fill("advisor-pass-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Customers", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Books", exact: true })).toHaveCount(0);
    const advisor = { authorization: `Bearer ${await token(page)}` };
    expect((await request.get(`${API}/api/books/trial-balance`, { headers: advisor })).status()).toBe(403);
  });
});
