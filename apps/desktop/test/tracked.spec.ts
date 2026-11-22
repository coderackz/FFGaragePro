import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

test("tyres by DOT, batteries by serial, and kits", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  page.on("dialog", (d) => void d.accept());
  const shot = shooter(page, "tracked-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  const api = async (method: "get" | "post", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());

  // A tyre tracked by DOT, made on the part form.
  await nav(page, "Parts");
  await page.getByRole("button", { name: "New part" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Part number").fill("MICH-LTX");
  await form.getByLabel("Name", { exact: true }).fill("Michelin LTX 265/65R17");
  await form.getByLabel("Track each unit").selectOption("dot");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Tyres by DOT")).toBeVisible();
  const tyre = (await api("get", "/api/parts?q=MICH-LTX")).parts[0];

  // Four arrive: each DOT is entered on the delivery.
  const supplier = (await api("post", "/api/suppliers", { name: "Tyre Co" })).supplier;
  const po = (await api("post", "/api/purchase-orders", { supplierId: supplier.id, lines: [{ partId: tyre.id, description: "Michelin LTX 265/65R17", qty: 4, unitCostFils: 30000 }] })).purchaseOrder;
  await api("post", `/api/purchase-orders/${po.id}/send`, {});
  await page.goto(`/#/purchase-orders/${po.id}`);
  await page.getByRole("button", { name: "Receive delivery" }).click();
  await page.getByLabel("Codes for Michelin LTX 265/65R17").fill("1025, 2524\n2624 2524");
  await expect(page.getByText("4 of 4 DOT codes")).toBeVisible();
  await page.getByLabel("Supplier invoice no.").fill("TC-881");
  await page.getByRole("button", { name: "Record delivery" }).click();
  await expect(page.getByText("Receive delivery —")).toHaveCount(0);
  await page.goto(`/#/parts/${tyre.id}`);
  await expect(page.getByRole("row").nth(1)).toContainText("2524");
  await shot("01-tyre");

  // A kit, made on the part form from two stocked parts.
  const filter = (await api("post", "/api/parts", { partNo: "OF-1", name: "Oil filter", stocked: true, sellPriceFils: 3500 })).part;
  await api("post", `/api/parts/${filter.id}/adjustments`, { reason: "opening", qty: 5, unitCostFils: 2000 });
  const oil = (await api("post", "/api/parts", { partNo: "5W30", name: "Engine oil 5W-30", unit: "litre", stocked: true, sellPriceFils: 3000 })).part;
  await api("post", `/api/parts/${oil.id}/adjustments`, { reason: "opening", qty: 20, unitCostFils: 800 });
  await nav(page, "Parts");
  await page.getByRole("button", { name: "New part" }).click();
  await form.getByLabel("Part number").fill("KIT-MIN");
  await form.getByLabel("Name", { exact: true }).fill("Minor service");
  await form.getByLabel("This is a kit").check();
  await form.getByRole("button", { name: "Add a part" }).click();
  await form.getByLabel("Kit part number").nth(0).fill("OF-1");
  await form.getByRole("button", { name: "Add a part" }).click();
  await form.getByLabel("Kit part number").nth(1).fill("5W30");
  await form.getByLabel("Kit part quantity").nth(1).fill("4.5");
  await expect(form.getByText("Engine oil 5W-30 · 20 litre")).toBeVisible();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("kits-available")).toHaveText("4");
  await shot("02-kit");

  // A job card: two tyres, the oldest picked; and the kit.
  const customer = (await api("post", "/api/customers", { kind: "individual", name: "Ali Hassan" })).customer;
  const vehicle = (await api("post", "/api/vehicles", { customerId: customer.id, plate: "DXB A 12345", make: "Toyota", model: "Land Cruiser", year: 2018 })).vehicle;
  const jc = (await api("post", "/api/documents", { type: "jobcard", customerId: customer.id, vehicleId: vehicle.id })).document;
  await page.goto(`/#/documents/${jc.id}`);
  await page.getByRole("button", { name: "+ Part", exact: true }).click();
  await page.getByLabel("Part", { exact: true }).last().fill("MICH");
  await page.getByRole("option", { name: /MICH-LTX/ }).click();
  await page.getByLabel("Quantity").last().fill("2");
  await page.getByRole("button", { name: "Pick the oldest 2" }).click();
  await expect(page.getByText("2 of 2 picked")).toBeVisible();
  await page.getByRole("button", { name: "+ Part", exact: true }).click();
  await page.getByLabel("Part", { exact: true }).last().fill("KIT-MIN");
  await page.getByRole("option", { name: /KIT-MIN/ }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await shot("03-jobcard");
  const saved = (await api("get", `/api/documents/${jc.id}`)).document;
  expect(saved.lines.find((l: { partId: string }) => l.partId === tyre.id).units.map((u: { code: string }) => u.code)).toEqual(["2524", "2524"]);
  expect((await api("get", `/api/parts/${oil.id}`)).part.onHand).toBe(15.5);
  expect((await api("get", `/api/parts/${filter.id}`)).part.onHand).toBe(4);

  // A battery with a serial and a 2-year warranty, fitted; found again by its serial.
  const battery = (await api("post", "/api/parts", { partNo: "AMR-70", name: "Amaron 70Ah", stocked: true, sellPriceFils: 40000, tracking: "serial", warrantyMonths: 24 })).part;
  await api("post", `/api/parts/${battery.id}/adjustments`, { reason: "opening", qty: 1, unitCostFils: 25000, units: ["AM70-55821"] });
  const unit = (await api("get", `/api/parts/${battery.id}/units`)).units[0];
  const jc2 = (await api("post", "/api/documents", { type: "jobcard", customerId: customer.id, vehicleId: vehicle.id, lines: [{ kind: "part", partId: battery.id, description: "Amaron 70Ah", qty: 1, unitPriceFils: 40000, discountPct: 0, unitIds: [unit.id] }] })).document;
  await nav(page, "Parts");
  await page.getByRole("button", { name: "Find a serial or DOT" }).click();
  await page.getByRole("dialog").getByPlaceholder("Serial number or DOT code").fill("55821");
  await expect(page.getByRole("dialog").getByRole("row", { name: new RegExp(`AM70-55821.*${jc2.number}.*Ali Hassan.*DXB A 12345`) })).toBeVisible();
  await shot("04-find");
  expect(errors).toEqual([]);
});
