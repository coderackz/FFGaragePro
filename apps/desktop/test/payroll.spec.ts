import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const lastMonth = () => { const t = today(); return new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10); };

test("a month's payroll: employees, approval, WPS, bonus, payslips", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  page.on("dialog", (d) => void d.accept());
  const shot = shooter(page, "payroll-");
  const start = lastMonth();
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  await request.put(`${API}/api/settings/books`, { headers, data: { startDate: start } });

  // Settings → Payroll: the WPS details and how pay is worked out.
  await nav(page, "Settings");
  await page.getByTestId("tile-payroll").click();
  await page.getByLabel("MOHRE establishment ID").fill("1234567890123");
  await page.getByLabel("Employer's bank routing code").fill("803320101");
  await page.getByLabel("Gratuity day rate").selectOption({ label: "Basic ÷ 30" });
  await page.getByLabel("Gratuity cap").selectOption({ label: "Two years of basic" });
  await page.getByLabel("Leave not taken paid on").selectOption({ label: "Basic" });
  await page.getByLabel("Salary day rate (part months, unpaid leave)").selectOption({ label: "Gross ÷ 30" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // Two employees: one added here (visa expiring in 10 days), one by API.
  await nav(page, "Employees");
  await page.getByRole("button", { name: "New employee" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name", { exact: true }).fill("Ravi Kumar");
  await form.getByLabel("Job").fill("Mechanic");
  await form.getByLabel("Joined").fill("2024-01-01");
  await form.getByLabel("Basic").fill("3000");
  await form.getByLabel("Housing").fill("1000");
  await form.getByLabel("Transport").fill("500");
  await form.getByLabel("IBAN").fill("AE07 0331 2345 6789 0123 456");
  await form.getByLabel("Bank routing code").fill("803320101");
  await form.getByLabel("MOHRE person ID").fill("10012345678901");
  await form.getByLabel("Visa number").fill("201/2024/1");
  await form.getByLabel("Visa expires").fill(addDays(today(), 10));
  await form.getByRole("button", { name: "Save employee" }).click();
  await expect(page.getByRole("heading", { name: "Ravi Kumar" })).toBeVisible();
  await request.post(`${API}/api/employees`, { headers, data: {
    name: "Sami Haddad", job: "Electrician", joinDate: "2025-03-01", basicFils: 250000, payMethod: "bank", iban: "AE070331234567890123457", routingCode: "803320101", personId: "10012345678902",
  } });

  // An advance to Ravi last month, taken back at 100.00 a month.
  await page.getByRole("button", { name: "Pay an advance" }).click();
  const adv = page.getByRole("dialog");
  await adv.getByLabel("Amount").fill("300");
  await adv.getByLabel("Taken back each month").fill("100");
  await adv.getByLabel("Paid on").fill(addDays(start, 4));
  await adv.getByLabel("Paid from").selectOption({ label: "1000 Cash on hand" });
  await adv.getByRole("button", { name: "Pay advance" }).click();
  await expect(page.getByTestId("advance-owed")).toHaveText("AED 300.00");

  // The dashboard reminds about the visa.
  await nav(page, "Dashboard");
  await expect(page.getByTestId("expiring-documents")).toContainText("Ravi Kumar: Visa");

  // Last month's payroll.
  await nav(page, "Payroll");
  await page.getByLabel("Month").fill(start.slice(0, 7));
  await page.getByRole("button", { name: "Run payroll" }).click();
  await expect(page.getByRole("row", { name: /Ravi Kumar/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Sami Haddad/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Ravi Kumar/ }).getByTestId("advance")).toHaveText("AED 100.00");
  await page.getByLabel("Bonus, Ravi Kumar").fill("250");
  await page.getByLabel("Bonus, Ravi Kumar").blur();
  await expect(page.getByTestId("total-bonus")).toHaveText("AED 250.00");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("run-status")).toContainText("Approved");
  await shot("01-run");

  // The WPS file, then paying.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download WPS file" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^1234567890123\d{12}\.SIF$/);
  expect(readFileSync((await file.path())!, "utf8").split("\r\n")[0]).toMatch(/^EDR,/);
  await page.getByRole("button", { name: "Mark WPS paid" }).click();
  await page.getByRole("dialog").getByLabel("Paid from").selectOption({ label: "1020 Bank" });
  await page.getByRole("dialog").getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByTestId("run-status")).toContainText("WPS paid");
  await page.getByRole("button", { name: "Print bonus voucher" }).click();
  await page.getByRole("button", { name: "Mark bonus paid" }).click();
  await page.getByRole("dialog").getByLabel("Cash box").selectOption({ label: "1000 Cash on hand" });
  await page.getByRole("dialog").getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByTestId("run-status")).toContainText("Bonus paid");
  await page.getByRole("button", { name: "Print payslips" }).click();
  await shot("02-paid");

  // The books agree.
  await nav(page, "Books");
  await page.getByRole("link", { name: /Books health/ }).click();
  for (const key of ["trial_balance", "receivables", "payables", "inventory", "output_vat", "opening_clearing"]) {
    await expect(page.getByTestId(`check-${key}`)).toContainText("OK");
  }
  expect(errors).toEqual([]);
});
