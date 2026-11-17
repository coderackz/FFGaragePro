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
  // First run: set up the garage.
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
  await page.getByRole("button", { name: "Part" }).click();
  await page.getByPlaceholder("e.g. Brake pad set (front)").fill("Brake pad set (front), OEM");
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
