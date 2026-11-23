import { expect, test, type Page } from "@playwright/test";
import { renderDocumentHtml } from "../src/renderer/print/templates";
import { setUpGarage, shooter, waitSaved } from "./flow";

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
