import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

test("reorder: suggested orders into draft POs, min/max levels, stock reports", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  const shot = shooter(page, "planning-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  const api = async (method: "get" | "post", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());

  const supplier = (await api("post", "/api/suppliers", { name: "Filters Co" })).supplier;
  const oil = (await api("post", "/api/parts", { partNo: "OF-1", name: "Oil filter", stocked: true, sellPriceFils: 3500 })).part;
  await api("post", `/api/parts/${oil.id}/adjustments`, { reason: "opening", qty: 100, unitCostFils: 2000 });
  const air = (await api("post", "/api/parts", { partNo: "AF-1", name: "Air filter", stocked: true, sellPriceFils: 4500, reorderLevel: 10, maxLevel: 20, preferredSupplierId: supplier.id })).part;
  await api("post", `/api/parts/${air.id}/adjustments`, { reason: "opening", qty: 3, unitCostFils: 1500 });
  const customer = (await api("post", "/api/customers", { kind: "individual", name: "Ali Hassan" })).customer;
  const inv = (await api("post", "/api/documents", { type: "invoice", customerId: customer.id, lines: [{ kind: "part", partId: oil.id, description: "Oil filter", qty: 45, unitPriceFils: 3500, discountPct: 0 }] })).document;
  await api("post", `/api/documents/${inv.id}/issue`);

  // Suggested orders: the air filter, topped up to 20 from 3.
  await nav(page, "Reorder");
  await expect(page.getByRole("row", { name: /AF-1/ })).toBeVisible();
  await expect(page.getByLabel("Quantity of AF-1")).toHaveValue("17");
  await shot("01-suggested");
  await page.getByRole("button", { name: "Make draft purchase orders" }).click();
  await expect(page.getByText("Drafts made")).toBeVisible();
  await expect(page.getByRole("link", { name: /PO-00001 · Filters Co/ })).toBeVisible();
  await expect(page.getByText("Nothing to order")).toBeVisible();

  // Min / max: the oil filter's suggestion (45 used in 90 days, 7 days' lead time) accepted.
  await page.getByRole("tab", { name: "Min / max levels" }).click();
  await expect(page.getByRole("row", { name: /OF-1/ })).toContainText("11 / 26");
  await page.getByRole("row", { name: /OF-1/ }).getByRole("button", { name: "Use suggested" }).click();
  await page.getByRole("button", { name: "Save levels" }).click();
  await expect(page.getByLabel("Reorder at for OF-1")).toHaveValue("11");
  expect((await api("get", `/api/parts/${oil.id}`)).part).toMatchObject({ reorderLevel: 11, maxLevel: 26 });
  await shot("02-levels");

  // Stock reports.
  await nav(page, "Stock reports");
  await expect(page.getByRole("row", { name: /OF-1/ })).toContainText("A");
  await page.getByRole("tab", { name: "Dead stock" }).click();
  // The air filter came in today: not dead stock yet, although it's never been used.
  await expect(page.getByText("No dead stock")).toBeVisible();
  await page.getByRole("tab", { name: "Valuation" }).click();
  await expect(page.getByTestId("report-total")).toHaveText("AED 1,145.00");
  await shot("03-valuation");
  expect(errors).toEqual([]);
});
