import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { OWNER, setUpGarage, shooter, waitSaved } from "./flow";

const API = "http://127.0.0.1:4780";
const SARA = { username: "sara", password: "sara-pass-1" };
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

async function signIn(page: Page, who: { username: string; password: string } = OWNER) {
  await page.goto("/");
  await page.evaluate(() => sessionStorage.clear());
  await page.goto("/");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
}
async function apiAs(page: Page, request: APIRequestContext) {
  const headers = { authorization: `Bearer ${await token(page)}` };
  return async (method: "get" | "post" | "put" | "patch", path: string, data?: unknown) => {
    const res = await request[method](`${API}${path}`, { headers, data });
    return { status: res.status(), body: await res.json() };
  };
}
const part = (description: string, qty = 1) => ({ kind: "part", description, qty, unitPriceFils: 30000, discountPct: 0 });

test.describe.serial("parts requests", () => {
  let dialogs: string[] = [];
  let jobId = "";
  test.beforeEach(({ page }) => {
    dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
    // WhatsApp opens in a new window: kept here, never sent anywhere.
    void page.addInitScript(() => { (window as unknown as { opened: string[] }).opened = []; window.open = ((url: string) => { (window as unknown as { opened: string[] }).opened.push(String(url)); return null; }) as typeof window.open; });
  });

  test("an advisor requests the job card's parts in one go; a shelf part is offered; no vendor anywhere", async ({ page, request }) => {
    await page.goto("/");
    await setUpGarage(page);
    const api = await apiAs(page, request);
    await api("post", "/api/users", { name: "Sara", role: "advisor", ...SARA });
    const { body: { customer } } = await api("post", "/api/customers", { name: "Ahmed", phone: "0501112222" });
    const { body: { vehicle } } = await api("post", "/api/vehicles", { customerId: customer.id, plate: "D 12345", make: "Toyota", model: "Land Cruiser", year: 2019, engine: "4.0L", vin: "JTMHV05J904123456" });
    const { body: { part: filter } } = await api("post", "/api/parts", { partNo: "OF-1001", name: "Oil filter", sellPriceFils: 3500, stocked: true });
    await api("post", `/api/parts/${filter.id}/adjustments`, { reason: "opening", qty: 5, unitCostFils: 1500 });
    await api("post", "/api/suppliers", { name: "Gulf Parts", phone: "0501234567", email: "orders@gulfparts.example" });
    const { body: { document } } = await api("post", "/api/documents", { type: "jobcard", customerId: customer.id, vehicleId: vehicle.id, lines: [part("Front brake pads"), part("Rear shock absorbers", 2), part("Oil filter")] });
    jobId = document.id;

    await signIn(page, SARA);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Purchases" })).toHaveCount(0);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Suppliers" })).toHaveCount(0);
    await page.goto(`/#/documents/${jobId}`);
    const hint = page.getByTestId("shelf-hint");
    await expect(hint).toContainText("On the shelf: Oil filter (OF-1001) · 5");
    await hint.getByRole("button", { name: "Use it" }).click();
    await waitSaved(page);
    await page.getByRole("button", { name: "Request parts (2)" }).click();
    await expect(page.getByText("Requested · PO-00001")).toHaveCount(2);
    await expect(page.getByText("Gulf Parts")).toHaveCount(0);
    await shooter(page, "requests-")("advisor");
    const sara = await apiAs(page, request);
    expect((await sara("get", "/api/suppliers")).status).toBe(403);
    expect((await sara("get", "/api/purchase-orders")).status).toBe(403);
  });

  test("the owner asks two vendors, compares their prices and orders each part from the cheaper", async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId("requests-waiting")).toContainText("Parts requests: 1");
    await page.goto("/#/purchase-orders");
    const card = page.getByTestId("parts-requests");
    await expect(card).toContainText("Not sent to vendors");
    await card.getByText("PO-00001").click();
    await expect(page.getByTestId("request-vehicle")).toContainText("JTMHV05J904123456");
    await page.getByRole("button", { name: "Ask vendors for prices" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: /Gulf Parts/ }).check();
    await dialog.getByLabel("New vendor name").fill("Sajaa Spares");
    await dialog.getByLabel("New vendor mobile").fill("0503334444");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByText("Attach Mulkiya photo")).toBeVisible();
    await dialog.getByRole("button", { name: "Send Gulf Parts by email" }).click();
    await expect(dialog.getByText("Sent by email")).toBeVisible();
    await dialog.getByRole("button", { name: "Send Sajaa Spares by WhatsApp" }).click();
    await expect(dialog.getByText("Sent by WhatsApp")).toBeVisible();
    const opened = await page.evaluate(() => (window as unknown as { opened: string[] }).opened);
    expect(opened[0]).toContain("wa.me/971503334444");
    expect(decodeURIComponent(opened[0]!)).toContain("VIN JTMHV05J904123456");
    expect(decodeURIComponent(opened[0]!)).not.toContain("Ahmed");
    expect(decodeURIComponent(opened[0]!)).not.toContain("D 12345");
    await dialog.getByRole("button", { name: "Done" }).click();

    await page.getByLabel("Gulf Parts price for Front brake pads").fill("180");
    await page.getByLabel("Sajaa Spares price for Front brake pads").fill("165");
    await page.getByLabel("Gulf Parts price for Rear shock absorbers").fill("420");
    await expect(page.getByLabel("Order Front brake pads from Sajaa Spares")).toBeChecked();
    await expect(page.getByLabel("Order Rear shock absorbers from Gulf Parts")).toBeChecked();
    await expect(page.getByTestId("order-summary")).toContainText("Sajaa Spares: AED 165.00");
    await page.getByLabel("Order Front brake pads from Gulf Parts").check();
    await expect(page.getByTestId("order-summary")).toContainText("Gulf Parts: AED 1,020.00");
    await page.getByLabel("Order Front brake pads from Sajaa Spares").check();
    await expect(page.getByTestId("order-summary")).toContainText("Gulf Parts: AED 840.00");
    await shooter(page, "requests-")("prices");
    await page.getByRole("button", { name: "Order", exact: true }).click();
    await expect.poll(() => dialogs[0]).toBe("Order 1 part from Sajaa Spares (AED 165.00) and 1 part from Gulf Parts (AED 840.00)?");
    await expect(page.getByRole("dialog").getByText("Send PO-00001 to Sajaa Spares")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "WhatsApp" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("vendor-messages")).toContainText("Order sent: Sajaa Spares");
    await page.goto("/#/purchase-orders");
    await expect(page.getByTestId("parts-requests")).toHaveCount(0);
    await expect(page.getByRole("row", { name: /PO-00002/ })).toContainText("Gulf Parts");
  });

  test("delivered, the advisor's job card says Received, still without a vendor", async ({ page, request }) => {
    await signIn(page);
    const api = await apiAs(page, request);
    const list = (await api("get", "/api/purchase-orders")).body.purchaseOrders;
    const po1 = (await api("get", `/api/purchase-orders/${list.find((p: { number: string }) => p.number === "PO-00001").id}`)).body.purchaseOrder;
    expect((await api("post", `/api/purchase-orders/${po1.id}/receive`, { vatFils: 0, lines: [{ poLineId: po1.lines[0].id, qty: 1, unitCostFils: 16500 }] })).status).toBe(200);
    await signIn(page, SARA);
    await page.goto(`/#/documents/${jobId}`);
    await expect(page.getByText("Received · PO-00001")).toBeVisible();
    await expect(page.getByText("On order · PO-00002")).toBeVisible();
    await expect(page.getByText("Sajaa")).toHaveCount(0);
  });
});
