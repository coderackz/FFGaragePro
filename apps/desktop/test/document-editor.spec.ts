import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { renderDocumentHtml } from "../src/renderer/print/templates";
import { OWNER, setUpGarage, shooter, waitSaved } from "./flow";

const API = "http://127.0.0.1:4780";
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

test("a job card without pressing Save: SL no, units, a labour description, a 30% discount with a remark, restored after a reload", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  const shot = shooter(page, "document-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  const api = async (method: "get" | "post", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());
  const customer = (await api("post", "/api/customers", { kind: "company", name: "Emirates Logistics LLC", phone: "0501234567" })).customer;
  await api("post", "/api/vehicles", { customerId: customer.id, plate: "DXB K 48213", make: "Toyota", model: "Hiace", year: 2021, odometer: 84250 });

  // A new job card: nothing is created until it has a title.
  await page.goto(`/#/documents/new/jobcard?customerId=${customer.id}`);
  await expect(page.getByTestId("save-state")).toHaveText("Not saved yet");
  await page.getByPlaceholder("e.g. Replace front brake pads").fill("Front brakes");
  await page.getByRole("button", { name: "Add description" }).click();
  await page.getByLabel("Line description").fill("Pads and discs\nBleed brakes");
  await expect(page.getByLabel("Unit", { exact: true }).first()).toHaveValue("Hr");
  await page.getByLabel("Quantity").first().fill("1.5");
  await page.getByLabel("Unit price").first().fill("180");
  await waitSaved(page);
  await expect(page.getByText("JC-00001", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]{36}$/);

  // A second line, numbered 2, by the piece of work.
  await page.getByRole("button", { name: "+ Other", exact: true }).click();
  await page.getByLabel("Line title").last().fill("Disposal");
  await page.getByLabel("Unit", { exact: true }).last().fill("Job");
  await page.getByLabel("Unit price").last().fill("20");
  await waitSaved(page);
  await expect(page.getByTestId("line-number")).toHaveText(["1", "2"]);

  // 30% off: above the 25% limit, so a tick and a remark.
  await page.getByTestId("add-discount").click();
  const form = page.getByTestId("discount-form");
  await form.getByLabel("Discount", { exact: true }).fill("30");
  await expect(form.getByText("I confirm this 30% discount is approved")).toBeVisible();
  await expect(form.getByRole("button", { name: "Apply discount" })).toBeDisabled();
  await form.getByRole("checkbox").check();
  await form.getByLabel("Discount remark").fill("Fleet customer, agreed");
  await form.getByRole("button", { name: "Apply discount" }).click();
  await expect(page.getByTestId("discount-row")).toContainText("Discount 30%");
  // 1.5 × 180 + 20 = 290 before the discount; 87 off; VAT on 203.
  await expect(page.getByTestId("doc-summary")).toContainText("SubtotalAED 290.00");
  await expect(page.getByTestId("discount-row")).toContainText("−AED 87.00");
  await expect(page.getByTestId("doc-summary")).toContainText("TotalAED 213.15");
  await expect(page.getByTestId("discount-approval")).toContainText("Approved by Rashid Khan");
  await expect(page.getByTestId("discount-approval")).toContainText("Fleet customer, agreed");

  // The vehicle card; no language box.
  await expect(page.getByTestId("vehicle-card")).toContainText("Plate No");
  await expect(page.getByTestId("vehicle-card")).toContainText("DXB K 48213");
  await expect(page.getByTestId("vehicle-card")).toContainText("VIN No");
  await expect(page.getByTestId("vehicle-card")).toContainText("Not recorded");
  await expect(page.getByTestId("vehicle-card")).toContainText("Odometer");
  await expect(page.getByText("Document language")).toHaveCount(0);
  await expect(page.getByTestId("progress")).toContainText("Open");
  await shot("1440");
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot("1280");
  await page.setViewportSize({ width: 1440, height: 900 });

  // The network drops mid-change: the change is kept on this PC and comes back after a reload.
  await page.route("**/api/documents/*", (route) => (route.request().method() === "PATCH" ? route.abort() : route.continue()));
  await page.getByPlaceholder("Customer complaint, findings, technician notes…").fill("Customer waiting in the lounge");
  await expect(page.getByTestId("save-state")).toHaveText("Not saved — retrying", { timeout: 10_000 });
  // Still offline while the window reloads (as after a power cut): nothing reaches the server.
  await page.reload();
  await expect(page.getByTestId("restored")).toBeVisible();
  await expect(page.getByPlaceholder("Customer complaint, findings, technician notes…")).toHaveValue("Customer waiting in the lounge");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await waitSaved(page);

  // The printout: units beside quantities, the description under its title, the discount above VAT.
  const list = await api("get", "/api/documents?type=jobcard");
  const doc = (await api("get", `/api/documents/${list.documents[0].id}`)).document;
  expect(doc.notes).toBe("Customer waiting in the lounge");
  const { garage, settings } = await api("get", "/api/settings");
  const jobHtml = renderDocumentHtml(doc, garage, settings);
  expect(jobHtml).toContain("1.5 Hr");
  expect(jobHtml).toContain("Pads and discs<br>Bleed brakes");
  const invoice = (await api("post", `/api/documents/${doc.id}/convert`, {})).document;
  const invHtml = renderDocumentHtml(invoice, garage, settings);
  expect(invHtml).toContain("Discount 30%");
  expect(invHtml).toContain("1 Job");
  expect(errors).toEqual([]);
});

/** The garage the first test set up: the owner signed in on a fresh window, with a customer of its own. */
async function signedIn(page: Page, request: APIRequestContext, name: string) {
  await page.goto("/");
  await page.getByLabel("Username").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  const headers = { authorization: `Bearer ${await token(page)}` };
  const api = async (method: "get" | "post" | "put", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());
  const customer = (await api("post", "/api/customers", { kind: "company", name, phone: "0501234567" })).customer;
  const docs = async (type: string) => ((await api("get", `/api/documents?type=${type}`)).documents as { id: string; customerName: string }[]).filter((d) => d.customerName === name);
  return { api, customer, docs };
}
const title = (page: Page) => page.getByLabel("Line title");

test("auto-save never rewrites what's being typed", async ({ page, request }) => {
  const g = await signedIn(page, request, "Typing LLC");
  const est = (await g.api("post", "/api/documents", { type: "estimate", customerId: g.customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] })).document;
  await page.goto(`/#/documents/${est.id}`);
  await title(page).first().fill("Replace ");
  await waitSaved(page);
  await page.waitForTimeout(500);
  await title(page).first().pressSequentially("pads");
  await expect(title(page).first()).toHaveValue("Replace pads");
  // A description's new line, and spaces at the end of the notes, stay too.
  await page.getByRole("button", { name: "Add description" }).click();
  await page.getByLabel("Line description").fill("Front\n");
  await page.getByPlaceholder("Shown on the printed document").fill("Call ");
  await waitSaved(page);
  await page.waitForTimeout(500);
  await expect(page.getByLabel("Line description")).toHaveValue("Front\n");
  await expect(page.getByPlaceholder("Shown on the printed document")).toHaveValue("Call ");
  // A line just added, not typed in yet, is still there after a save.
  await page.getByRole("button", { name: "+ Other", exact: true }).click();
  await waitSaved(page);
  await page.waitForTimeout(500);
  await expect(title(page)).toHaveCount(2);
});

test("a new document typed the moment before it's created keeps its text too", async ({ page, request }) => {
  const g = await signedIn(page, request, "New Typing LLC");
  await page.goto(`/#/documents/new/estimate?customerId=${g.customer.id}`);
  await title(page).first().fill("Replace ");
  await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]{36}$/);
  await waitSaved(page);
  await page.waitForTimeout(500);
  await title(page).first().pressSequentially("pads");
  await expect(title(page).first()).toHaveValue("Replace pads");
});

test("leaving a new document saves it without pulling the person back to it", async ({ page, request }) => {
  const g = await signedIn(page, request, "Leaving LLC");
  await page.goto(`/#/documents/new/estimate?customerId=${g.customer.id}`);
  await title(page).first().fill("Full service");
  await page.getByRole("navigation").getByRole("link", { name: "Vehicles", exact: true }).click();
  await expect.poll(async () => (await g.docs("estimate")).length).toBe(1);
  await page.waitForTimeout(700);
  await expect(page).toHaveURL(/#\/vehicles$/);
});

test("a new document left while offline is created once when it's opened again", async ({ page, request }) => {
  const g = await signedIn(page, request, "Offline LLC");
  await page.route("**/api/documents", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await page.goto(`/#/documents/new/estimate?customerId=${g.customer.id}`);
  await title(page).first().fill("Full service");
  await expect(page.getByTestId("save-state")).toHaveText("Not saved — retrying", { timeout: 10_000 });
  await page.getByRole("navigation").getByRole("link", { name: "Vehicles", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Vehicles" })).toBeVisible();
  await page.goto(`/#/documents/new/estimate?customerId=${g.customer.id}`);
  await expect(page.getByTestId("restored")).toBeVisible();
  await expect(page.getByTestId("save-state")).toHaveText("Not saved — retrying", { timeout: 10_000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await waitSaved(page);
  await page.waitForTimeout(6000); // the left screen's retry would have run by now
  expect(await g.docs("estimate")).toHaveLength(1);
});

test("a save that finishes after moving to another document doesn't show the first one there", async ({ page, request }) => {
  const g = await signedIn(page, request, "Moving LLC");
  const est = (await g.api("post", "/api/documents", { type: "estimate", customerId: g.customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] })).document;
  const jc = (await g.api("post", `/api/documents/${est.id}/convert`, {})).document;
  await page.route(`**/api/documents/${jc.id}`, async (route) => {
    if (route.request().method() === "PATCH") await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.goto(`/#/documents/${jc.id}`);
  await expect(page.getByText(jc.number, { exact: true })).toBeVisible();
  await page.getByPlaceholder("Customer complaint, findings, technician notes…").fill("Noise at the front");
  await expect(page.getByTestId("save-state")).toHaveText("Saving…");
  await page.waitForTimeout(1300); // the save is on its way
  await page.getByRole("link", { name: `from ${est.number}` }).click();
  await expect(page.getByRole("heading", { name: est.number })).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(page.getByRole("heading", { name: est.number })).toBeVisible();
  expect((await g.api("get", `/api/documents/${jc.id}`)).document.notes).toBe("Noise at the front");
});

test("changes typed just before moving to another document are saved", async ({ page, request }) => {
  const g = await signedIn(page, request, "Quick LLC");
  const est = (await g.api("post", "/api/documents", { type: "estimate", customerId: g.customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] })).document;
  const jc = (await g.api("post", `/api/documents/${est.id}/convert`, {})).document;
  await page.goto(`/#/documents/${jc.id}`);
  await page.getByPlaceholder("Customer complaint, findings, technician notes…").fill("Noise at the front");
  await page.getByRole("link", { name: `from ${est.number}` }).click();
  await expect(page.getByRole("heading", { name: est.number })).toBeVisible();
  await expect.poll(async () => (await g.api("get", `/api/documents/${jc.id}`)).document.notes).toBe("Noise at the front");
});

test("removing a line leaves the next lines' descriptions as they were", async ({ page, request }) => {
  const g = await signedIn(page, request, "Lines LLC");
  await page.goto(`/#/documents/new/estimate?customerId=${g.customer.id}`);
  await title(page).first().fill("First");
  await page.getByRole("button", { name: "+ Labour", exact: true }).click();
  await title(page).nth(1).fill("Second");
  await page.getByRole("button", { name: "+ Labour", exact: true }).click();
  await title(page).nth(2).fill("Third");
  await waitSaved(page);
  await page.getByRole("button", { name: "Add description" }).nth(1).click();
  await expect(page.getByLabel("Line description")).toHaveCount(1);
  // Removed with the keyboard still in Second's box: the box stays Second's.
  await page.getByRole("button", { name: "Remove line" }).first().evaluate((b: HTMLElement) => b.click());
  await expect(title(page)).toHaveCount(2);
  const second = page.locator("tr", { has: page.locator('input[value="Second"]') });
  await expect(second.getByLabel("Line description")).toBeVisible();
  await expect(page.getByLabel("Line description")).toHaveCount(1);
});

test("the summary adds up while a price is being changed, with prices before or including VAT", async ({ page, request }) => {
  const g = await signedIn(page, request, "Sums LLC");
  const sums = async () => {
    const text = await page.getByTestId("doc-summary").innerText();
    const n = (re: RegExp) => Math.round(Number(re.exec(text)![1]!.replace(/,/g, "")) * 100);
    return { sub: n(/Subtotal\s+AED ([\d,.]+)/), off: n(/Discount[^−]*−AED ([\d,.]+)/), vat: n(/VAT 5%\s+AED ([\d,.]+)/), total: n(/Total\s+AED ([\d,.]+)/) };
  };
  for (const pricesIncludeVat of [false, true]) {
    await g.api("put", "/api/settings/tax", { ...(await g.api("get", "/api/settings")).settings.tax, pricesIncludeVat });
    const est = (await g.api("post", "/api/documents", { type: "estimate", customerId: g.customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10500, discountPct: 0 }] })).document;
    expect(est.pricesIncludeVat).toBe(pricesIncludeVat);
    await g.api("put", `/api/documents/${est.id}/discount`, { kind: "percent", value: 10 });
    await page.goto(`/#/documents/${est.id}`);
    await expect(page.getByTestId("discount-row")).toBeVisible();
    let s = await sums();
    expect(s.sub - s.off + s.vat).toBe(s.total);
    await page.route(`**/api/documents/${est.id}`, (route) => (route.request().method() === "PATCH" ? route.abort() : route.continue()));
    await page.getByLabel("Unit price").first().fill("300");
    await expect(page.getByTestId("save-state")).not.toHaveText("Saved");
    s = await sums();
    expect(s.sub - s.off + s.vat).toBe(s.total);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await waitSaved(page);
  }
});
