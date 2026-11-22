import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

test("CSV re-import sets shelf counts when ticked; an already-bought part takes the receipt's VAT", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  const shot = shooter(page, "minors-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  const api = async (method: "get" | "post" | "patch", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());

  // 10 filters on the shelf; the counted sheet says 7.
  const filter = (await api("post", "/api/parts", { partNo: "OF-1", name: "Oil filter", stocked: true, sellPriceFils: 3500 })).part;
  await api("post", `/api/parts/${filter.id}/adjustments`, { reason: "opening", qty: 10, unitCostFils: 2000 });
  await page.goto("/#/parts");
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByTestId("csv-file").setInputFiles({ name: "count.csv", mimeType: "text/csv", buffer: Buffer.from("part_no,name,qty\nOF-1,Oil filter,7\n") });
  await expect(page.getByText("Ready: 0 new parts, 1 to update.")).toBeVisible();
  await expect(page.getByText("Also set the shelf count of 1 existing part")).toBeVisible();
  await page.getByTestId("set-counts").check();
  await shot("01-import-counts");
  await page.getByRole("dialog").getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("Imported: 0 new, 1 updated, 1 shelf counts set")).toBeVisible();
  expect((await api("get", `/api/parts/${filter.id}`)).part.onHand).toBe(7);

  // Two discs bought for cash at a shop that charges no VAT.
  const disc = (await api("post", "/api/parts", { partNo: "BD-220", name: "Brake disc", stocked: false, sellPriceFils: 20000 })).part;
  const customer = (await api("post", "/api/customers", { name: "Ahmed", phone: "0501234567" })).customer;
  const jc = (await api("post", "/api/documents", { type: "jobcard", customerId: customer.id, lines: [
    { kind: "part", partId: disc.id, description: "Brake disc", qty: 2, unitPriceFils: 20000, discountPct: 0 },
  ] })).document;
  await page.goto(`/#/documents/${jc.id}`);
  await page.getByRole("button", { name: "Request part" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Already bought").check();
  await dlg.getByLabel("Cost each").fill("30");
  await expect(dlg.getByLabel("VAT on the receipt")).toHaveValue("3.00");
  await expect(dlg.getByText("Total AED 63.00")).toBeVisible();
  await dlg.getByLabel("VAT on the receipt").fill("0");
  await expect(dlg.getByText("Total AED 60.00")).toBeVisible();
  await shot("02-already-bought-vat");
  await dlg.getByRole("button", { name: "Record purchase" }).click();
  await expect(page.getByText("Recorded as bought")).toBeVisible();
  const line = (await api("get", `/api/documents/${jc.id}`)).document.lines[0];
  const po = (await api("get", `/api/purchase-orders/${line.purchaseOrderId}`)).purchaseOrder;
  expect(po.receipts[0]).toMatchObject({ netFils: 6000, vatFils: 0, grossFils: 6000 });
  expect(errors).toEqual([]);
});
