import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { OWNER, setUpGarage, shooter, waitSaved } from "./flow";

const API = "http://127.0.0.1:4780";
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const day = (offset = 0) => new Date(Date.now() + 4 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const shown = (ymd: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
const SARA = { username: "sara", password: "sara-pass-1" };

async function signIn(page: Page, who: { username: string; password: string } = OWNER) {
  await page.goto("/");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
}
async function apiAs(page: Page, request: APIRequestContext) {
  const headers = { authorization: `Bearer ${await token(page)}` };
  return async (method: "get" | "post" | "put" | "patch", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());
}
const job = (lines: unknown[], customerId: string) => ({ type: "jobcard", customerId, lines });
const USED = { kind: "part", description: "Alternator", qty: 1, unitPriceFils: 30000, discountPct: 0, condition: "used" };

/** Fills "Buy used part" and saves it. */
async function buyIn(page: Page, opts: { seller: string; price: string; on?: string; days: string }) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Seller", { exact: true }).fill(opts.seller);
  await dialog.getByLabel("Price each").fill(opts.price);
  if (opts.on) await dialog.getByLabel("Bought on").fill(opts.on);
  const save = dialog.getByRole("button", { name: "Save purchase" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("radio", { name: opts.days, exact: true }).check();
  await save.click();
  await expect(dialog).toHaveCount(0);
}

test.describe.serial("used parts", () => {
  let dialogs: string[] = [];
  let accept = true;
  test.beforeEach(({ page }) => {
    dialogs = [];
    accept = true;
    page.on("dialog", (d) => { dialogs.push(d.message()); void (accept ? d.accept() : d.dismiss()); });
  });

  test("an advisor ticks Used; it waits in Used parts to buy, without costs or a Buy button", async ({ page, request }) => {
    await page.goto("/");
    await setUpGarage(page);
    const api = await apiAs(page, request);
    const { customer } = await api("post", "/api/customers", { name: "Ahmed", phone: "0501112222" });
    await api("post", "/api/users", { name: "Sara", role: "advisor", ...SARA });
    const { document: est } = await api("post", "/api/documents", { type: "estimate", customerId: customer.id, lines: [{ ...USED, condition: "new" }] });
    await page.evaluate(() => sessionStorage.clear());
    await signIn(page, SARA);
    await page.goto(`/#/documents/${est.id}`);
    await page.getByLabel("Used", { exact: true }).check();
    await waitSaved(page);
    await expect(page.getByText("Supplied by Fleet Fix")).toHaveCount(0);
    await page.getByRole("button", { name: "Convert to job card" }).click();
    await expect(page.getByText("JC-00001", { exact: true })).toBeVisible();
    expect(dialogs).toEqual([]); // an estimate's used part isn't bought yet, of course
    await expect(page.getByLabel("Used", { exact: true })).toBeChecked();
    await expect(page.getByText("Not bought yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Request part" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Buy used part" })).toHaveCount(0);
    await page.goto("/#/purchase-orders");
    const card = page.getByTestId("used-to-buy");
    await expect(card.getByText("Used parts to buy (1)")).toBeVisible();
    await expect(card.getByText("Alternator")).toBeVisible();
    await expect(card.getByRole("button", { name: "Buy used part" })).toHaveCount(0);
    await expect(card.getByText("AED")).toHaveCount(0);
  });

  test("the owner buys it from the list: seller, no VAT bill, warranty chosen; the job has its cost and warranty", async ({ page, request }) => {
    await signIn(page);
    const api = await apiAs(page, request);
    const shot = shooter(page, "used-");
    await page.goto("/#/purchase-orders");
    await page.getByTestId("used-to-buy").getByRole("button", { name: "Buy used part" }).click();
    await expect(page.getByRole("dialog").getByLabel("Bought on")).toHaveValue(day());
    await shot("buy");
    await buyIn(page, { seller: "Al Sajaa Used Parts", price: "150", days: "7 days" });
    await expect(page.getByTestId("used-to-buy")).toHaveCount(0);
    const row = page.getByRole("row", { name: /PO-00001/ });
    await expect(row.getByText("Used part", { exact: true })).toBeVisible();
    await shot("orders");
    await row.click();
    await expect(page.getByText("Used part", { exact: true })).toBeVisible();
    const { items, documents } = { ...(await api("get", "/api/used-parts-to-buy")), ...(await api("get", "/api/documents?type=jobcard")) };
    expect(items).toEqual([]);
    await page.goto(`/#/documents/${documents[0].id}`);
    await expect(page.getByText(`Warranty until ${shown(day(7))}`)).toBeVisible();
    await expect(page.getByText("Cost AED 150.00")).toBeVisible();
    await expect(page.getByLabel("Used", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Line type")).toBeDisabled();
    expect((await api("get", "/api/parts")).parts).toEqual([]);
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await shot(`jobcard-${width}`);
    }
  });

  test("taken off, its cost stays on the job; put back, it's charged again", async ({ page, request }) => {
    await signIn(page);
    const api = await apiAs(page, request);
    const id = (await api("get", "/api/documents?type=jobcard")).documents[0].id;
    await page.goto(`/#/documents/${id}`);
    accept = false;
    await page.getByRole("button", { name: "Remove line" }).click();
    expect(dialogs).toEqual(["This part was bought for this job. Its cost stays on the job."]);
    await expect(page.getByText("Cost AED 150.00")).toBeVisible();
    accept = true;
    await page.getByRole("button", { name: "Remove line" }).click();
    const card = page.getByTestId("uncharged");
    await expect(card.getByText("Bought for this job, not charged")).toBeVisible();
    await expect(card.getByText("AED 150.00")).toBeVisible();
    await expect(page.getByTestId("job-cost").getByText("AED 150.00").first()).toBeVisible();
    await shooter(page, "used-")("not-charged");
    await card.getByRole("button", { name: "Put back on the job" }).click();
    await waitSaved(page);
    await expect(card).toHaveCount(0);
    await page.getByLabel("Unit price").fill("300");
    await waitSaved(page);
    await expect(page.getByText(`Warranty until ${shown(day(7))}`)).toBeVisible();
  });

  test("converting asks about a used part not bought; the invoice prints the warranty", async ({ page, request }) => {
    await signIn(page);
    const api = await apiAs(page, request);
    const { document: first } = await api("get", `/api/documents/${(await api("get", "/api/documents?type=jobcard")).documents[0].id}`);
    const { document: other } = await api("post", "/api/documents", job([{ ...USED, description: "Starter" }], first.customer.id));
    await page.goto(`/#/documents/${other.id}`);
    accept = false;
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect.poll(() => dialogs).toEqual(["Starter is marked used but its purchase isn't recorded. Convert anyway?"]);
    await expect(page.getByText(other.number, { exact: true })).toBeVisible();
    dialogs = [];
    accept = true;
    await page.goto(`/#/documents/${first.id}`);
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.getByText("INV-00001", { exact: true })).toBeVisible();
    expect(dialogs).toEqual([]);
    await page.getByRole("button", { name: "Issue invoice" }).click();
    await expect(page.getByText("INV-00001 issued")).toBeVisible();
    expect(dialogs).toHaveLength(1); // the usual "Issue this tax invoice?"
    await expect(page.getByText(`Warranty until ${shown(day(7))}`)).toBeVisible();
    expect((await api("get", "/api/parts")).parts).toEqual([]);
  });

  test("an ended warranty is said before the invoice is issued", async ({ page, request }) => {
    await signIn(page);
    const api = await apiAs(page, request);
    const customerId = (await api("get", "/api/customers")).customers[0].id;
    const { document: jc } = await api("post", "/api/documents", job([USED], customerId));
    await page.goto(`/#/documents/${jc.id}`);
    await page.getByRole("button", { name: "Buy used part" }).click();
    await buyIn(page, { seller: "Al Sajaa Used Parts", price: "90", on: day(-10), days: "3 days" });
    await expect(page.getByText(`Warranty ended ${shown(day(-7))}`)).toBeVisible();
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.getByText("INV-00002", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Issue invoice" }).click();
    await expect(page.getByText("INV-00002 issued")).toBeVisible();
    expect(dialogs[0]).toBe(`Warranty on Alternator ended on ${shown(day(-7))}. The invoice will print no warranty remaining.`);
    // The same seller, not a second one.
    expect((await api("get", "/api/suppliers")).suppliers.filter((s: { name: string }) => s.name === "Al Sajaa Used Parts")).toHaveLength(1);
  });

  test("a VAT bill needs the seller's TRN and invoice number", async ({ page, request }) => {
    await signIn(page);
    const api = await apiAs(page, request);
    const customerId = (await api("get", "/api/customers")).customers[0].id;
    const { document: jc } = await api("post", "/api/documents", job([USED], customerId));
    await page.goto(`/#/documents/${jc.id}`);
    await page.getByRole("button", { name: "Buy used part" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Seller", { exact: true }).fill("Registered Yard");
    await dialog.getByLabel("Price each").fill("200");
    await dialog.getByRole("radio", { name: "No warranty", exact: true }).check();
    await dialog.getByRole("radio", { name: "Yes", exact: true }).check();
    await expect(dialog.getByRole("button", { name: "Save purchase" })).toBeDisabled();
    await dialog.getByLabel("Seller's TRN").fill("100123456700003");
    await dialog.getByLabel("Invoice no.").fill("R-9");
    await expect(dialog.getByLabel("VAT (AED)")).toHaveValue("10.00");
    await dialog.getByRole("button", { name: "Save purchase" }).click();
    await expect(page.getByText("No warranty", { exact: true })).toBeVisible();
  });

  test("a delivery from a supplier without a TRN starts at no VAT, and says so", async ({ page, request }) => {
    await signIn(page);
    const api = await apiAs(page, request);
    const { supplier } = await api("post", "/api/suppliers", { name: "Corner shop" });
    const { purchaseOrder } = await api("post", "/api/purchase-orders", { supplierId: supplier.id, notes: null, lines: [{ partId: null, description: "Rags", qty: 1, unitCostFils: 10000 }] });
    await page.goto(`/#/purchase-orders/${purchaseOrder.id}`);
    await page.getByRole("button", { name: "Receive delivery" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("VAT", { exact: true })).toHaveValue("0.00");
    await expect(dialog.getByText("No TRN saved for this supplier")).toBeVisible();
    await dialog.getByLabel("VAT", { exact: true }).fill("5");
    await expect(dialog.getByText("VAT claimed from a supplier with no TRN")).toBeVisible();
  });
});
