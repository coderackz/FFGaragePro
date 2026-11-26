import { expect, test, type Page } from "@playwright/test";
import { setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));
const FAKE_WA_TOKEN = "EAAGfake000000000000000000good";

test("integrations: WhatsApp Business API and Zoho Books (fake providers)", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGEERROR", e.message); });
  page.on("dialog", (d) => void d.accept());
  const shot = shooter(page, "integrations-");
  await page.goto("/");
  await setUpGarage(page);
  const headers = { authorization: `Bearer ${await token(page)}` };

  // WhatsApp Business API: connect, then a test message.
  await nav(page, "Integrations");
  const wa = page.getByTestId("card-whatsapp");
  await wa.getByLabel("Phone number ID").fill("1099");
  await wa.getByLabel("WhatsApp business account ID").fill("2088");
  await wa.getByLabel("Permanent access token").fill(FAKE_WA_TOKEN);
  await wa.getByLabel("App secret").fill("app-secret");
  await wa.getByRole("button", { name: "Connect WhatsApp" }).click();
  await expect(wa).toContainText("+971 4 000 0000");
  await expect(wa.getByLabel(/^Webhook URL/)).toHaveValue(/\/api\/integrations\/whatsapp\/webhook$/);
  await expect(wa.getByLabel("Verify token")).toHaveValue(/^[0-9a-f]{24}$/);
  await wa.getByLabel("Send a test to").fill("050 123 4567");
  await wa.getByLabel("Approved template").fill("hello_world");
  await wa.getByRole("button", { name: "Send test" }).click();
  await expect(page.getByText("Test sent")).toBeVisible();
  await shot("01-whatsapp");

  // A template mapped to an approved Meta template: the Send dialog sends through the API.
  await request.post(`${API}/api/message-templates`, { headers, data: {
    name: "Ready (API)", channel: "whatsapp", textEn: "Dear {customer}, {plate} is ready.",
    waTemplateName: "vehicle_ready", waLanguage: "en", waParams: ["customer", "plate"],
  } });
  const customer = (await (await request.post(`${API}/api/customers`, { headers, data: { kind: "individual", name: "Mona Saeed", phone: "050 765 4321" } })).json()).customer;
  const vehicle = (await (await request.post(`${API}/api/vehicles`, { headers, data: { customerId: customer.id, plate: "DXB K 4521" } })).json()).vehicle;
  const jc = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "jobcard", customerId: customer.id, vehicleId: vehicle.id } })).json()).document;
  await page.goto(`/#/documents/${jc.id}`);
  await page.getByLabel("Status").selectOption("completed");
  await page.getByRole("button", { name: "Send message" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Template").selectOption({ label: "Ready (API)" });
  await dialog.getByRole("button", { name: "Send on WhatsApp" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("message-log")).toContainText("Sent", { timeout: 15_000 });

  // Zoho Books: connect through the (fake) consent page, map, push an invoice.
  await nav(page, "Integrations");
  const zoho = page.getByTestId("card-zoho");
  await zoho.getByLabel("Client ID").fill("1000.ZC");
  await zoho.getByLabel("Client secret").fill("zoho-secret");
  await zoho.getByRole("button", { name: "Connect Zoho Books" }).click();
  await page.waitForURL(/#\/settings\/integrations\?connected=zoho/);
  const zohoBack = page.getByTestId("card-zoho");
  await expect(zohoBack).toContainText("Al Quoz Auto Care LLC");
  await zohoBack.getByLabel("VAT 5% tax").selectOption({ label: "VAT 5%" });
  await zohoBack.getByLabel("Labour item").selectOption({ label: "Labour" });
  await zohoBack.getByLabel("Parts item").selectOption({ label: "Parts" });
  await zohoBack.getByLabel("Other item").selectOption({ label: "Other" });
  await zohoBack.getByRole("button", { name: "Save" }).click();
  await expect(zohoBack).toContainText("Ready");
  const inv = (await (await request.post(`${API}/api/documents`, { headers, data: { type: "invoice", customerId: customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] } })).json()).document;
  await request.post(`${API}/api/documents/${inv.id}/issue`, { headers, data: {} });
  await zohoBack.getByRole("button", { name: "Send now" }).click();
  await expect(zohoBack).toContainText(/1 sent/);
  await shot("02-zoho");
  await zohoBack.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("card-zoho").getByRole("button", { name: "Connect Zoho Books" })).toBeVisible();
  expect(errors).toEqual([]);
});
