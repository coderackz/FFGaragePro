import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

test("returns to the supplier, cores, warranty claims", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  const shot = shooter(page, "returns-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  const api = async (method: "get" | "post" | "patch", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());

  // VAT-registered: their deliveries start at 5% VAT (a supplier with no TRN starts at none).
  const supplier = (await api("post", "/api/suppliers", { name: "Al Futtaim Parts", trn: "100200300400003" })).supplier;
  const filter = (await api("post", "/api/parts", { partNo: "OF-1", name: "Oil filter", stocked: true, sellPriceFils: 3500 })).part;
  const alt = (await api("post", "/api/parts", { partNo: "ALT-1", name: "Alternator (exchange)", stocked: true, sellPriceFils: 60000, coreFils: 15000 })).part;
  const po = (await api("post", "/api/purchase-orders", { supplierId: supplier.id, lines: [
    { partId: filter.id, description: "Oil filter", qty: 10, unitCostFils: 2000 }, { partId: alt.id, description: "Alternator (exchange)", qty: 2, unitCostFils: 40000 },
  ] })).purchaseOrder;
  await api("patch", `/api/purchase-orders/${po.id}`, { status: "sent" });

  // The delivery: the alternators carry a AED 150 core deposit each (net 200 + 800 + 300).
  await page.goto(`/#/purchase-orders/${po.id}`);
  await page.getByRole("button", { name: "Receive delivery" }).click();
  await expect(page.getByLabel("Core deposit for Alternator (exchange)")).toHaveValue("150.00");
  await expect(page.getByText("Net AED 1,300.00")).toBeVisible();
  await page.getByLabel("Supplier invoice no.").fill("AF-901");
  await page.getByRole("button", { name: "Record delivery" }).click();
  await expect(page.getByText("Receive delivery —")).toHaveCount(0);

  // Two filters go back, credited at AED 22.00.
  await nav(page, "Returns & claims");
  await page.getByRole("button", { name: "Return parts" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Supplier").selectOption(supplier.id);
  await dlg.getByLabel("Part number").fill("OF-1");
  await expect(dlg.getByText("Oil filter · 10 on the shelf")).toBeVisible();
  await dlg.getByLabel("Return quantity").fill("2");
  await dlg.getByLabel("Credit each").fill("22");
  await dlg.getByLabel("Reason").fill("Wrong size supplied");
  await expect(dlg.getByText("Credit AED 46.20")).toBeVisible();
  await dlg.getByRole("button", { name: "Make debit note" }).click();
  await expect(page.getByRole("row", { name: /RTS-00001.*Al Futtaim Parts.*Parts returned.*AED 46\.20/ })).toBeVisible();
  await shot("01-returns");
  expect((await api("get", `/api/parts/${filter.id}`)).part.onHand).toBe(8);

  // Cores: one goes back, the other is written off.
  await page.getByRole("tab", { name: "Cores owed" }).click();
  await expect(page.getByRole("row", { name: /ALT-1/ })).toContainText("AED 300.00");
  await page.getByRole("button", { name: "Return cores" }).click();
  await page.getByRole("dialog").getByLabel("Return quantity").fill("1");
  await page.getByRole("dialog").getByRole("button", { name: "Make debit note" }).click();
  await expect(page.getByRole("row", { name: /ALT-1/ })).toContainText("AED 150.00");
  await page.getByRole("button", { name: "Write off" }).click();
  await page.getByRole("dialog").getByLabel("Write-off reason").fill("Customer kept the old unit");
  await page.getByRole("dialog").getByRole("button", { name: "Write off" }).click();
  await expect(page.getByText("No cores owed")).toBeVisible();
  // 1,365.00 billed (1,300 + VAT 65) less 46.20 and 157.50 in debit notes.
  expect((await api("get", `/api/suppliers/${supplier.id}`)).supplier.balanceFils).toBe(136500 - 4620 - 15750);

  // A battery fitted on a job fails: claimed by its serial, and replaced.
  const battery = (await api("post", "/api/parts", { partNo: "AMR-70", name: "Amaron 70Ah", stocked: true, sellPriceFils: 40000, tracking: "serial", warrantyMonths: 24 })).part;
  await api("post", `/api/parts/${battery.id}/adjustments`, { reason: "opening", qty: 1, unitCostFils: 25000, units: ["AM70-55821"] });
  const unit = (await api("get", `/api/parts/${battery.id}/units`)).units[0];
  const customer = (await api("post", "/api/customers", { kind: "individual", name: "Ali Hassan" })).customer;
  await api("post", "/api/documents", { type: "jobcard", customerId: customer.id, lines: [{ kind: "part", partId: battery.id, description: "Battery", qty: 1, unitPriceFils: 40000, discountPct: 0, unitIds: [unit.id] }] });
  await page.getByRole("tab", { name: "Warranty claims" }).click();
  await page.getByRole("button", { name: "New claim" }).click();
  await page.getByRole("dialog").getByLabel("Claim serial").fill("55821");
  await page.getByRole("dialog").getByRole("button", { name: /AM70-55821/ }).click();
  await page.getByRole("dialog").getByLabel("Claim supplier").selectOption(supplier.id);
  await page.getByRole("dialog").getByLabel("What failed").fill("Won't hold charge");
  await page.getByRole("dialog").getByRole("button", { name: "Open claim" }).click();
  await expect(page.getByRole("row", { name: /WC-00001.*AMR-70.*Serial AM70-55821/ })).toBeVisible();
  await shot("02-claim");
  await page.getByRole("button", { name: "Close claim" }).click();
  await page.getByRole("dialog").getByLabel("Replacement codes").fill("AM70-60002");
  await page.getByRole("dialog").getByRole("button", { name: "Close claim" }).click();
  await expect(page.getByText("No open claims")).toBeVisible();
  expect((await api("get", `/api/parts/${battery.id}/units`)).units.map((u: { code: string }) => u.code)).toEqual(["AM70-60002"]);
  expect(errors).toEqual([]);
});
