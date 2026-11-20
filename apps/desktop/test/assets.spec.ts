import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const monthsAgo = (n: number) => { const t = today(); return new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 - n, 1)).toISOString().slice(0, 10); };
const TOOLS = "00000000-0000-4000-8000-0000000a1500";

test("a fixed asset: bought, depreciated monthly, sold", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  page.on("dialog", (d) => void d.accept());
  const shot = shooter(page, "assets-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  await request.put(`${API}/api/settings/books`, { headers, data: { startDate: monthsAgo(4) } });
  // The lift is bought on a supplier bill in the books' second month: its cost goes to 1500.
  const bought = `${monthsAgo(3).slice(0, 8)}10`;
  const supplier = (await (await request.post(`${API}/api/suppliers`, { headers, data: { name: "Garage Equipment Co" } })).json()).supplier;
  await request.post(`${API}/api/bills`, { headers, data: { supplierId: supplier.id, supplierInvoiceNo: "GE-77", billDate: bought, lines: [{ accountId: TOOLS, description: "Hydraulic lift", netFils: 1200000, vat: "none" }] } });

  // Into the register.
  await nav(page, "Books");
  await page.getByRole("link", { name: /Fixed assets/ }).click();
  await page.getByRole("button", { name: "New asset" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill("Hydraulic lift");
  await form.getByLabel("Category").selectOption("equipment");
  await form.getByLabel("Account").selectOption({ label: "1500 Tools and equipment" });
  await form.getByLabel("Cost").fill("12000");
  await form.getByLabel("In use from").fill(bought);
  await form.getByLabel("Life (months)").fill("36");
  await form.getByRole("button", { name: "Save asset" }).click();
  // Three months have ended since it went into use: three charges of 333.33.
  await page.reload();
  await expect(page.getByRole("row", { name: /Hydraulic lift/ })).toContainText("AED 11,000.01");
  await shot("01-register");

  await page.getByRole("row", { name: /Hydraulic lift/ }).click();
  await expect(page.getByTestId("schedule-row").filter({ hasText: "Posted" })).toHaveCount(3);
  await page.getByRole("button", { name: "Sell or write off" }).click();
  const sell = page.getByRole("dialog");
  await sell.getByLabel("Proceeds").fill("11500");
  await sell.getByLabel("Into").selectOption({ label: "1020 Bank" });
  await sell.getByRole("button", { name: "Record sale" }).click();
  // Depreciation runs through the sale month: a fourth charge, so the gain is 11,500.00 − 10,666.68.
  await expect(page.getByTestId("disposal-gain")).toHaveText("Gain AED 833.32");
  await shot("02-sold");

  await nav(page, "Books");
  await page.getByRole("link", { name: /Books health/ }).click();
  for (const key of ["trial_balance", "receivables", "payables", "inventory", "output_vat", "opening_clearing", "fixed_assets"]) {
    await expect(page.getByTestId(`check-${key}`)).toContainText("OK");
  }
  expect(errors).toEqual([]);
});
