import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { setUpGarage, shooter, waitSaved } from "./flow";

const API = "http://127.0.0.1:4780";
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
async function apiAs(page: Page, request: APIRequestContext) {
  const headers = { authorization: `Bearer ${await token(page)}` };
  return async (method: "get" | "post" | "put", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());
}
const line = (kind: string, description: string) => ({ kind, description, qty: 1, unitPriceFils: 0, discountPct: 0 });

test.describe.serial("estimates from job cards", () => {
  let dialogs: string[] = [];
  let jobId = "";
  test.beforeEach(({ page }) => {
    dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
  });

  test("a job card's estimate: priced, approved by phone with a line declined, and the job card follows", async ({ page, request }) => {
    await page.goto("/");
    await setUpGarage(page);
    const api = await apiAs(page, request);
    const { customer } = await api("post", "/api/customers", { name: "Ahmed", phone: "0501112222" });
    const { document } = await api("post", "/api/documents", { type: "jobcard", customerId: customer.id, lines: [line("labour", "Inspection"), line("part", "Front brake pads"), line("labour", "AC re-gas")] });
    jobId = document.id;
    await page.goto(`/#/documents/${jobId}`);
    await page.getByRole("button", { name: "Create estimate" }).click();
    await expect(page.getByText("EST-00001", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "for JC-00001" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Convert to job card/ })).toHaveCount(0);
    const prices = page.getByLabel("Unit price");
    await prices.nth(0).fill("50");
    await prices.nth(1).fill("300");
    await prices.nth(2).fill("200");
    await waitSaved(page);
    await page.getByRole("button", { name: "Record approval" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Approved by")).toHaveValue("Ahmed");
    await dialog.getByLabel("Approved: AC re-gas").uncheck();
    await dialog.getByLabel("Note").fill("Called at 10:40, brakes only");
    await shooter(page, "estimates-")("approve");
    await dialog.getByRole("button", { name: "Record approval" }).click();
    await expect(page.getByTestId("approval")).toContainText("Phone call · Ahmed");
    await expect(page.getByText("Declined by the client")).toBeVisible();
    await expect(page.getByText("AED 367.50", { exact: true })).toBeVisible(); // 350.00 + VAT: the declined AC re-gas counts nothing
    await expect(page.getByRole("button", { name: "Record approval" })).toHaveCount(0);
    await shooter(page, "estimates-")("approved");

    await page.getByRole("link", { name: "for JC-00001" }).click();
    await expect(page.getByTestId("job-estimate")).toContainText("EST-00001");
    const job = (await api("get", `/api/documents/${jobId}`)).document;
    expect(job.lines.map((l: { description: string; unitPriceFils: number }) => [l.description, l.unitPriceFils])).toEqual([["Inspection", 5000], ["Front brake pads", 30000]]);
  });

  test("extra work: the job card re-estimates to EST-00001-1, keeping the version the client approved", async ({ page, request }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill("rashid");
    await page.getByLabel("Password").fill("garage-pass-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation")).toBeVisible();
    const api = await apiAs(page, request);
    const job = (await api("get", `/api/documents/${jobId}`)).document;
    await api("put", `/api/documents/${jobId}/lines`, { lines: [...job.lines.map((l: Record<string, unknown>) => ({ kind: l.kind, description: l.description, qty: l.qty, unitPriceFils: l.unitPriceFils, discountPct: 0 })), line("part", "Brake discs")] });
    await page.goto(`/#/documents/${jobId}`);
    await page.getByRole("button", { name: "Re-estimate" }).click();
    await expect(page.getByText("EST-00001-1", { exact: true })).toBeVisible();
    await expect(page.getByTestId("versions")).toContainText("EST-00001");
    await expect(page.getByTestId("versions")).toContainText("approved phone call");
    await expect(page.getByRole("button", { name: "Record approval" })).toBeVisible();
    const est = (await api("get", `/api/documents/${job.estimate.id}`)).document;
    expect(est.lines.map((l: { description: string }) => l.description)).toEqual(["Inspection", "Front brake pads", "Brake discs"]);
    await shooter(page, "estimates-")("re-estimate");
  });
});
