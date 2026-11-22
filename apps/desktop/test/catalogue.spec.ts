import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

test("the parts catalogue: numbers, fitment, category, packs, replaced by", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  page.on("dialog", (d) => void d.accept());
  const shot = shooter(page, "catalogue-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };

  // A part with its catalogue.
  await nav(page, "Parts");
  await page.getByRole("button", { name: "New part" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Part number").fill("TY-OF1");
  await form.getByLabel("Name", { exact: true }).fill("Oil filter");
  await form.getByLabel("Category").selectOption({ label: "Filters" });
  await form.getByLabel("Filter type").selectOption("Oil");
  await form.getByRole("button", { name: "Add number" }).click();
  await form.getByLabel("Other number 1").fill("04152-YZZA1");
  await form.getByRole("button", { name: "Add vehicle" }).click();
  await form.getByLabel("Make 1").fill("Toyota");
  await form.getByLabel("Model 1").fill("Land Cruiser");
  await form.getByLabel("From 1").fill("2016");
  await form.getByLabel("To 1").fill("2021");
  await form.getByRole("button", { name: "Add pack" }).click();
  await form.getByLabel("Pack name 1").fill("Box of 10");
  await form.getByLabel("Holds 1").fill("10");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("catalogue")).toContainText("04152-YZZA1");
  await expect(page.getByTestId("catalogue")).toContainText("Toyota Land Cruiser 2016–2021");
  await expect(page.getByTestId("catalogue")).toContainText("Box of 10");
  await expect(page.getByTestId("catalogue")).toContainText("Filter type: Oil");
  await shot("01-part");

  // Replaced by a newer part.
  await request.post(`${API}/api/parts`, { headers, data: { partNo: "TY-OF2", name: "Oil filter (new type)", stocked: true, sellPriceFils: 3500 } });
  await page.getByRole("button", { name: "Replaced by…" }).click();
  await page.getByRole("dialog").getByLabel("Replacement part").fill("TY-OF2");
  await page.getByRole("dialog").getByRole("option", { name: /TY-OF2/ }).click();
  await expect(page.getByTestId("catalogue")).toContainText("Replaced by TY-OF2");

  // On a job card for a Land Cruiser: the fitting part offered first; found by its OEM number.
  await request.post(`${API}/api/parts/${(await (await request.get(`${API}/api/parts?q=TY-OF1`, { headers })).json()).parts[0].id}/supersede`, { headers, data: { byPartId: null } });
  const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { kind: "individual", name: "Ali Hassan" } })).json()).customer;
  const vehicle = (await (await request.post(`${API}/api/vehicles`, { headers, data: { customerId: customer.id, plate: "DXB A 12345", make: "Toyota", model: "Land Cruiser", year: 2018 } })).json()).vehicle;
  const jc = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "jobcard", customerId: customer.id, vehicleId: vehicle.id } })).json()).document;
  await page.goto(`/#/documents/${jc.id}`);
  await page.getByRole("button", { name: "+ Part", exact: true }).click();
  await page.getByLabel("Part", { exact: true }).last().click();
  await expect(page.getByRole("option", { name: /TY-OF1.*Fits/ })).toBeVisible();
  await page.getByLabel("Part", { exact: true }).last().fill("04152yzza1");
  await expect(page.getByRole("option", { name: /OEM 04152-YZZA1/ })).toBeVisible();
  await page.getByRole("option", { name: /TY-OF1/ }).click();
  await shot("02-picker");

  // Parts list: filter by category.
  await nav(page, "Parts");
  await page.getByLabel("Category").selectOption({ label: "Filters" });
  await expect(page.getByRole("row", { name: /TY-OF1/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /TY-OF2/ })).toHaveCount(0);

  // A purchase order bought in boxes.
  const supplier = (await (await request.post(`${API}/api/suppliers`, { headers, data: { name: "Filters Co" } })).json()).supplier;
  await page.goto("/#/purchase-orders/new");
  await page.getByLabel("Supplier").selectOption(supplier.id);
  await page.getByLabel("Part", { exact: true }).fill("TY-OF1");
  await page.getByRole("option", { name: /TY-OF1/ }).click();
  await page.getByLabel("Buy in").selectOption({ label: "Box of 10" });
  await page.getByLabel("Packs").fill("2");
  // AED 99.99 a box: the order is 2 × 99.99 = 199.98 (per unit it would round to 10.00 × 20 = 200.00).
  await page.getByLabel("Cost per pack").fill("99.99");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("po-net")).toHaveText("AED 199.98");
  await expect(page.getByLabel("Order quantity")).toHaveValue("20");
  // The saved order keeps the pack: reopen it from the server.
  await expect(page).toHaveURL(/purchase-orders\/(?!new)/);
  await page.reload();
  await expect(page.getByLabel("Buy in")).toHaveValue("Box of 10");
  await expect(page.getByLabel("Packs")).toHaveValue("2");
  await expect(page.getByLabel("Cost per pack")).toHaveValue("99.99");
  await expect(page.getByTestId("po-net")).toHaveText("AED 199.98");
  await shot("03-po");
  expect(errors).toEqual([]);
});
