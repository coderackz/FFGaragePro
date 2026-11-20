import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (ymd: string) => `${ymd.slice(8)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("from a supplier bill to a reconciled bank", async ({ page, request }) => {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  page.on("dialog", (d) => void d.accept());
  const shot = shooter(page, "payables-");
  await page.goto("/");
  await setUpGarage(page);
  await nav(page, "Settings");
  await page.getByTestId("tile-books").click();
  await page.getByLabel("Books start date").fill(addDays(today(), -30));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  const headers = { authorization: `Bearer ${await token(page)}` };
  const supplier = (await (await request.post(`${API}/api/suppliers`, { headers, data: { name: "Al Quoz Properties", termsDays: 30 } })).json()).supplier;

  // A rent bill.
  await nav(page, "Bills");
  await page.getByRole("button", { name: "New bill" }).click();
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Al Quoz Properties" });
  await page.getByLabel("Supplier's invoice number").fill("AQP-2611");
  await page.getByLabel("Account, line 1").selectOption({ label: "6010 Rent" });
  await page.getByLabel("Description, line 1").fill("Workshop rent, November");
  await page.getByLabel("Net, line 1").fill("1000");
  await expect(page.getByTestId("bill-total")).toHaveText("AED 1,050.00");
  await page.getByRole("button", { name: "Save bill" }).click();
  await expect(page.getByText("Bill saved")).toBeVisible();

  // The same bill entered twice by mistake: cancelled from the Bills page.
  await page.getByRole("button", { name: "New bill" }).click();
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Al Quoz Properties" });
  await page.getByLabel("Supplier's invoice number").fill("AQP-2611-DUP");
  await page.getByLabel("Account, line 1").selectOption({ label: "6010 Rent" });
  await page.getByLabel("Description, line 1").fill("Workshop rent, November");
  await page.getByLabel("Net, line 1").fill("1000");
  await page.getByRole("button", { name: "Save bill" }).click();
  await page.getByRole("row", { name: /AQP-2611-DUP/ }).getByRole("button", { name: "Cancel bill" }).click();
  await page.getByRole("dialog").getByLabel("Why").fill("Entered twice");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel bill" }).click();
  await expect(page.getByRole("row", { name: /AQP-2611-DUP/ })).toContainText("Cancelled");

  // Pay it by bank transfer.
  await page.goto(`/#/suppliers/${supplier.id}`);
  await expect(page.getByTestId("supplier-balance")).toHaveText("AED 1,050.00");
  await page.getByRole("button", { name: "Pay supplier" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Pay AED 1,050.00$/ }).click();
  await expect(page.getByTestId("supplier-balance")).toHaveText("AED 0.00");
  await shot("01-supplier");

  // A fuel expense from cash, with a photo of the receipt.
  await nav(page, "Expenses");
  await page.getByRole("button", { name: "New expense" }).click();
  await page.getByLabel("Account").selectOption({ label: "6040 Fuel" });
  await page.getByLabel("Description").fill("Diesel for the recovery truck");
  await page.getByLabel("Net").fill("50");
  await page.getByLabel("Paid from").selectOption({ label: "1000 Cash on hand" });
  await page.getByLabel("Receipt photo").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Save expense" }).click();
  await expect(page.getByRole("row", { name: /EX-00001/ })).toContainText("52.50");

  // Money moved from cash to the bank twice, and a customer's cheque paid in two days ago.
  const CASH = "00000000-0000-4000-8000-0000000a1000";
  const BANK = "00000000-0000-4000-8000-0000000a1020";
  for (const n of [-10, -9]) await request.post(`${API}/api/transfers`, { headers, data: { date: addDays(today(), n), fromAccountId: CASH, toAccountId: BANK, amountFils: 20000 } });
  const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { name: "Gulf Fleet" } })).json()).customer;
  await request.post(`${API}/api/receipts`, { headers, data: { customerId: customer.id, amountFils: 30000, method: "cheque", chequeDate: addDays(today(), -3) } });
  await nav(page, "Bank & cash");
  await page.getByRole("row", { name: /Gulf Fleet/ }).getByRole("button", { name: "Pay in" }).click();
  await page.getByRole("dialog").getByLabel("Date paid in").fill(addDays(today(), -2));
  await page.getByRole("dialog").getByRole("button", { name: /^Pay in/ }).click();
  await expect(page.getByText("None waiting").first()).toBeVisible();

  // The bank statement: map the columns once, give its starting balance, import, match, add the charge.
  await page.getByRole("row", { name: /1020 Bank/ }).getByRole("button", { name: "Reconcile" }).click();
  const csv = [
    "Date,Details,Debit,Credit,Ref",
    `${dmy(addDays(today(), -2))},Cheque deposit,,300.00,`,
    `${dmy(today())},Transfer to Al Quoz Properties,"1,050.00",,TR88`,
    `${dmy(today())},Account fee,15.75,,`,
    `${dmy(today())},Cash deposit,,200.00,`,
  ].join("\n");
  await page.getByLabel("Bank statement (CSV)").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByLabel("Date column").selectOption("Date");
  await page.getByLabel("Details column").selectOption("Details");
  await page.getByLabel("Money out column").selectOption("Debit");
  await page.getByLabel("Money in column").selectOption("Credit");
  await page.getByLabel("Date format").selectOption("dd/mm/yyyy");
  // One of the two cash transfers was on the bank already before this statement.
  await page.getByLabel("Balance before the first line").fill("200");
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("4 lines imported")).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept match" });
  await expect(accept).toHaveCount(2);
  await accept.first().click();
  await expect(accept).toHaveCount(1);
  await accept.first().click();
  await expect(accept).toHaveCount(0);
  await page.getByRole("button", { name: "Add as bank charge" }).click();
  // Two transfers of 200 days before: no suggestion, so it's matched by hand.
  const cashRow = page.getByRole("row", { name: /Cash deposit/ });
  await cashRow.getByLabel("Match to").selectOption({ index: 1 });
  await cashRow.getByRole("button", { name: "Match", exact: true }).click();
  await expect(page.getByTestId("reconciled")).toHaveText("Reconciled");
  await shot("02-reconciled");

  // The books agree.
  await nav(page, "Books");
  await page.getByRole("link", { name: /Books health/ }).click();
  for (const key of ["trial_balance", "receivables", "payables", "inventory", "output_vat", "opening_clearing"]) {
    await expect(page.getByTestId(`check-${key}`)).toContainText("OK");
  }
});
