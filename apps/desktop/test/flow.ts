import { expect, type Page } from "@playwright/test";

/** Saves a full-page screenshot to test-results/screens/<prefix><name>.png. */
export const shooter = (page: Page, prefix = "") => (name: string) =>
  page.screenshot({ path: `test-results/screens/${prefix}${name}.png`, fullPage: true });

export const OWNER = { name: "Rashid Khan", username: "rashid", password: "garage-pass-1" };

/**
 * One garage day, through the UI: first-run setup → company customer + vehicle → estimate
 * (labour + discounted part) → approve → job card → complete → invoice → issue → part payment.
 * Leaves the page on INV-00001 with AED 180.40 still due. Used by the browser and Electron tests.
 */
export async function garageDay(page: Page, shot: (name: string) => Promise<unknown>): Promise<void> {
  page.on("dialog", (d) => void d.accept()); // "Issue this tax invoice?" confirm
  await setUpGarage(page, shot);

  // Customer + vehicle.
  await page.getByRole("navigation").getByRole("link", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Type").selectOption("company");
  await page.getByLabel("Company name").fill("Emirates Logistics LLC");
  await page.getByLabel("Mobile / phone").fill("050 123 4567");
  await page.getByLabel("Customer TRN").fill("100987654300003");
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page.getByRole("heading", { name: "Emirates Logistics LLC" })).toBeVisible();
  await page.getByRole("button", { name: "Add vehicle" }).click();
  await page.getByLabel("Plate number").fill("dxb k 48213");
  await page.getByLabel("Odometer (km)").fill("84250");
  await page.getByLabel("Make").fill("Toyota");
  await page.getByLabel("Model").fill("Hiace");
  await page.getByLabel("Year").fill("2021");
  await page.getByRole("button", { name: "Save vehicle" }).click();
  await expect(page.getByRole("cell", { name: "DXB K 48213" })).toBeVisible();
  await shot("03-customer");

  // Estimate with labour + part.
  await page.getByRole("button", { name: "New estimate" }).click();
  await expect(page.getByRole("combobox", { name: "Vehicle" })).toHaveValue(/.+/);
  await page.getByPlaceholder("e.g. Replace front brake pads").fill("Front brake service — replace pads, clean calipers");
  await page.getByLabel("Quantity").first().fill("1.5");
  await page.getByLabel("Unit price").first().fill("180");
  await page.getByRole("button", { name: "Part", exact: true }).click();
  await page.getByPlaceholder("Search parts or type a description").fill("Brake pad set (front), OEM");
  await page.getByLabel("Quantity").nth(1).fill("1");
  await page.getByLabel("Unit price").nth(1).fill("420");
  await page.getByLabel("Discount percent").nth(1).fill("10");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("EST-00001")).toBeVisible();
  // 270 + 378 = 648 net, 32.40 VAT, 680.40 total
  await expect(page.getByText("AED 680.40")).toBeVisible();
  await shot("04-estimate");

  await page.getByLabel("Status").selectOption("approved");
  await expect(page.getByText("Marked as Approved")).toBeVisible();
  await page.getByRole("button", { name: "Convert to job card" }).click();
  await expect(page.getByText("JC-00001", { exact: true })).toBeVisible();
  await page.getByLabel("Status").selectOption("completed");
  await expect(page.getByText("Marked as Completed")).toBeVisible();
  await shot("05-jobcard");

  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByText("INV-00001", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByRole("button", { name: "Record payment" })).toBeVisible();
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.getByLabel("Amount (AED)").fill("500");
  await page.getByLabel("Method").selectOption("card");
  await page.getByLabel("Reference").fill("POS 7781");
  await page.getByRole("button", { name: /Record AED 500.00/ }).click();
  await expect(page.getByText("AED 180.40").first()).toBeVisible();
  await shot("06-invoice-part-paid");
}

/** First run: sets up "Al Quoz Auto Care" with Rashid as owner and lands on the dashboard. */
export async function setUpGarage(page: Page, shot: (name: string) => Promise<unknown> = async () => undefined): Promise<void> {
  await expect(page.getByRole("heading", { name: "Set up your garage" })).toBeVisible({ timeout: 30_000 });
  await shot("01-setup");
  await page.getByLabel("Garage name").fill("Al Quoz Auto Care");
  await page.getByLabel("VAT TRN").fill("100123456700003");
  await page.getByLabel("Phone").fill("+971 4 321 0000");
  await page.getByLabel("Address").fill("Warehouse 12, Al Quoz Industrial 3\nDubai, UAE");
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Username").fill(OWNER.username);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Confirm password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create garage" }).click();
  await expect(page.getByText(/Good (morning|afternoon|evening), Rashid/)).toBeVisible();
  await shot("02-dashboard-empty");

}

/**
 * Inventory, after garageDay: a stocked oil filter (opening stock 10 at AED 18) and a brake disc bought per job.
 * A job card takes one filter off the shelf and requests two discs from Fleet Fix; the owner receives them at
 * AED 150 each; the invoice shows parts cost AED 318.00 and the shelf shows 9 filters.
 */
export async function stockDay(page: Page, shot: (name: string) => Promise<unknown>): Promise<void> {
  const nav = (name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
  const dialog = page.getByRole("dialog");

  await nav("Parts");
  await page.getByRole("button", { name: "New part" }).click();
  await dialog.getByLabel("Part number").fill("OF-1001");
  await dialog.getByLabel("Name", { exact: true }).fill("Oil filter");
  await dialog.getByLabel("Brand").fill("Bosch");
  await dialog.getByLabel("Selling price (AED, before VAT)").fill("35");
  await dialog.getByLabel("Reorder when at or below").fill("4");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Oil filter" })).toBeVisible();
  await page.getByRole("button", { name: "Adjust stock" }).click();
  await expect(dialog.getByLabel("Reason")).toHaveValue("opening");
  await dialog.getByLabel("Quantity (each)").fill("10");
  await dialog.getByLabel("Cost each (AED)").fill("18");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("on-hand")).toHaveText("10");

  await nav("Parts");
  await page.getByRole("button", { name: "New part" }).click();
  await dialog.getByLabel("Part number").fill("BD-220");
  await dialog.getByLabel("Name", { exact: true }).fill("Brake disc");
  await dialog.getByLabel("Selling price (AED, before VAT)").fill("200");
  await dialog.getByLabel("Kept on the shelf?").selectOption("no");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Brake disc" })).toBeVisible();

  // Job card: labour, a filter from the shelf, two discs to order.
  await nav("Customers");
  await page.getByRole("cell", { name: "Emirates Logistics LLC" }).click();
  await page.getByRole("button", { name: "New job card" }).click();
  await expect(page.getByRole("combobox", { name: "Vehicle" })).toHaveValue(/.+/);
  await page.getByPlaceholder("e.g. Replace front brake pads").fill("Oil change and front discs");
  await page.getByLabel("Unit price").first().fill("100");
  await page.getByRole("button", { name: "Part", exact: true }).click();
  await page.getByLabel("Part", { exact: true }).last().fill("oil fil");
  await page.getByRole("option", { name: /OF-1001/ }).click();
  await page.getByRole("button", { name: "Part", exact: true }).click();
  await page.getByLabel("Part", { exact: true }).last().fill("brake disc");
  await page.getByRole("option", { name: /BD-220/ }).click();
  await page.getByLabel("Quantity").last().fill("2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("JC-00002", { exact: true })).toBeVisible();
  await expect(page.getByText("OF-1001 · 9 on shelf")).toBeVisible();
  await page.locator("tr", { hasText: "BD-220 · bought per job" }).getByRole("button", { name: "Request part" }).click();
  await expect(dialog.getByLabel("Supplier")).toHaveValue(/0f1ee7$/);
  await expect(dialog.getByLabel("Request quantity")).toHaveValue("2");
  await dialog.getByRole("button", { name: "Request" }).click();
  await expect(page.getByText("On order · PO-00001")).toBeVisible();
  await shot("10-jobcard-parts");

  // The owner prices, receives and the job's parts cost appears.
  await nav("Purchases");
  await page.getByRole("cell", { name: "PO-00001" }).click();
  await page.getByLabel("Unit cost").fill("150");
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByText("Marked as sent")).toBeVisible();
  await page.getByRole("button", { name: "Receive delivery" }).click();
  await expect(dialog.getByLabel("Received quantity")).toHaveValue("2");
  await expect(dialog.getByLabel("VAT")).toHaveValue("15.00");
  await dialog.getByRole("button", { name: "Record delivery" }).click();
  await expect(page.getByText("PO-00001 fully received")).toBeVisible();
  await shot("11-purchase-order");

  await page.getByRole("link", { name: "JC-00002" }).click();
  await expect(page.getByText("Received · PO-00001")).toBeVisible();
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByText("INV-00002", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByRole("button", { name: "Record payment" })).toBeVisible();
  // 18.00 for the filter + 2 × 150.00 for the discs; net 535.00 → margin 217.00
  await expect(page.getByTestId("job-cost")).toContainText("AED 318.00");
  await expect(page.getByTestId("job-cost")).toContainText("AED 217.00");
  await shot("12-invoice-parts-cost");

  await nav("Parts");
  await expect(page.getByRole("row", { name: /OF-1001/ })).toContainText("9");
  await shot("13-parts");
}
