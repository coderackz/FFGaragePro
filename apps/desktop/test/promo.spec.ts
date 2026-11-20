import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

test("a promo code: made, applied to an invoice, issued, reported", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  page.on("dialog", (d) => void d.accept());
  const shot = shooter(page, "promo-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  await request.put(`${API}/api/settings/books`, { headers, data: { startDate: today() } });

  // Settings → Promo codes: SERVICE10, 10% off labour.
  await nav(page, "Settings");
  await page.getByTestId("tile-promo-codes").click();
  await page.getByRole("button", { name: "New code" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Code", { exact: true }).fill("service10");
  await form.getByLabel("Discount type").selectOption("percent");
  await form.getByLabel("Discount", { exact: true }).fill("10");
  await form.getByLabel("Applies to").selectOption("labour");
  await form.getByRole("button", { name: "Save code" }).click();
  await expect(page.getByRole("row", { name: /SERVICE10/ })).toBeVisible();
  await shot("01-codes");

  // An invoice with labour 100.00 and a part 50.00.
  const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { kind: "company", name: "Gulf Fleet LLC" } })).json()).customer;
  const inv = (await (await request.post(`${API}/api/documents`, {
    headers,
    data: { type: "invoice", customerId: customer.id, lines: [
      { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 },
      { kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 5000, discountPct: 0 },
    ] },
  })).json()).document;
  await page.goto(`/#/documents/${inv.id}`);
  await page.getByLabel("Promo code").fill("service10");
  await page.getByRole("button", { name: "Apply" }).click();
  const summary = page.getByTestId("doc-summary");
  await expect(summary).toContainText("Promo SERVICE10");
  await expect(summary).toContainText("−AED 10.00");
  await expect(summary).toContainText("AED 147.00");
  await shot("02-applied");
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByText(/issued/).first()).toBeVisible();
  await expect(summary).toContainText("AED 147.00");

  // Reports → Promo codes: one use, AED 10.00.
  await nav(page, "Promo codes");
  const row = page.getByRole("row", { name: /SERVICE10/ });
  await expect(row).toContainText("1");
  await expect(row).toContainText("AED 10.00");
  await shot("03-report");

  // The books still balance.
  const health = await (await request.get(`${API}/api/books/health`, { headers })).json();
  expect(health.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
  expect(errors).toEqual([]);
});
