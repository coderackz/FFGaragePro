import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const monthsAgo = (n: number) => { const t = today(); return new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 - n, 1)).toISOString().slice(0, 10); };
const RENT = "00000000-0000-4000-8000-0000000a6010";
const BANK = "00000000-0000-4000-8000-0000000a1020";
const OTHER_INCOME = "00000000-0000-4000-8000-0000000a4020";

test("a VAT return from the books, filed and locked", async ({ page, request }) => {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  page.on("dialog", (d) => void d.accept());
  const shot = shooter(page, "vat-");
  // Two months in the books: both are due, and returns are filed oldest first.
  const start = monthsAgo(2);
  const prev = monthsAgo(1);
  const day = (n: number) => `${prev.slice(0, 8)}${String(n).padStart(2, "0")}`;
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  await request.put(`${API}/api/settings/books`, { headers, data: { startDate: start } });
  await request.put(`${API}/api/settings/tax`, { headers, data: { returnPeriod: "monthly", firstPeriodStart: start } });

  // The garage's emirate, in Settings → Garage.
  await nav(page, "Settings");
  await page.getByTestId("tile-garage").click();
  await page.getByLabel("Emirate").selectOption({ label: "Dubai" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // Last month: a rent bill with VAT, and a zero-rated sale entered as a tagged journal.
  const supplier = (await (await request.post(`${API}/api/suppliers`, { headers, data: { name: "Al Quoz Properties" } })).json()).supplier;
  await request.post(`${API}/api/bills`, { headers, data: { supplierId: supplier.id, supplierInvoiceNo: "AQP-1", billDate: day(10), lines: [{ accountId: RENT, description: "Workshop rent", netFils: 100000, vat: "standard" }] } });
  const draft = (await (await request.post(`${API}/api/books/drafts`, { headers, data: { date: day(12), narration: "Export repair (zero rated)", lines: [
    { accountId: BANK, debitFils: 50000 }, { accountId: OTHER_INCOME, creditFils: 50000, vatBox: "4" },
  ] } })).json()).draft;
  await request.post(`${API}/api/books/drafts/${draft.id}/post`, { headers });

  // A correction to last month's output VAT, in the journal editor with its VAT box.
  await nav(page, "Books");
  await page.getByRole("link", { name: /Journals/ }).click();
  await page.getByRole("button", { name: "New journal" }).click();
  await page.getByLabel("Date").fill(day(15));
  await page.getByLabel("Narration").fill("Output VAT correction");
  await page.getByLabel("Account, line 1").selectOption({ label: "2100 Output VAT" });
  await page.getByLabel("Debit, line 1").fill("10");
  await page.getByLabel("VAT box, line 1").selectOption({ label: "1 Adjustment (sales VAT)" });
  await page.getByLabel("Account, line 2").selectOption({ label: "1020 Bank" });
  await page.getByLabel("Credit, line 2").fill("10");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^JV-\d+/ })).toBeVisible();

  // The return opens on the oldest due period (the one that can be filed): nothing in it, file it.
  await nav(page, "Books");
  await page.getByRole("link", { name: /VAT return/ }).click();
  await expect(page.getByLabel("Period")).toHaveValue(start);
  await expect(page.getByTestId("period-status")).toHaveText("Due");
  await page.getByRole("button", { name: "Mark as filed" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "File return" }).click();
  await expect(page.getByTestId("period-status")).toHaveText("Filed");

  // Last month: due, with the bill and the journals.
  await page.getByLabel("Period").selectOption(prev);
  await expect(page.getByTestId("period-status")).toHaveText("Due");
  await expect(page.getByTestId("box-9-amount")).toHaveText("AED 1,000.00");
  await expect(page.getByTestId("box-9-vat")).toHaveText("AED 50.00");
  await expect(page.getByTestId("box-4-amount")).toHaveText("AED 500.00");
  await expect(page.getByTestId("box-1b-adjustment")).toHaveText("-AED 10.00");
  await expect(page.getByTestId("box-14")).toContainText("Refundable");
  await expect(page.getByTestId("box-14")).toContainText("AED 60.00");
  await page.getByTestId("box-9").click();
  await expect(page.getByTestId("box-rows").getByRole("link", { name: /^JV-/ })).toHaveCount(1);
  await shot("01-return");

  await page.getByRole("button", { name: "Mark as filed" }).click();
  await page.getByRole("dialog").getByLabel("FTA reference (optional)").fill("FTA-E2E");
  await page.getByRole("dialog").getByRole("button", { name: "File return" }).click();
  await expect(page.getByTestId("period-status")).toHaveText("Filed");
  await expect(page.getByText("FTA-E2E")).toBeVisible();
  await shot("02-filed");

  await nav(page, "Books");
  await page.getByRole("link", { name: /Journals/ }).click();
  await expect(page.getByRole("row", { name: /VAT return/ })).toBeVisible();
  await nav(page, "Books");
  await page.getByRole("link", { name: /Books health/ }).click();
  for (const key of ["trial_balance", "receivables", "payables", "inventory", "output_vat", "opening_clearing"]) {
    await expect(page.getByTestId(`check-${key}`)).toContainText("OK");
  }
});
