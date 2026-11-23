import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { OWNER, setUpGarage } from "./flow";

const API = "http://127.0.0.1:4780";
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

async function signIn(page: Page, who: { username: string; password: string } = OWNER) {
  await page.goto("/");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
}

/** The owner signed in, and the API as the owner. */
async function owner(page: Page, request: APIRequestContext) {
  await signIn(page);
  const headers = { authorization: `Bearer ${await token(page)}` };
  return async (method: "get" | "post" | "put" | "patch", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());
}

test.describe.serial("form fields", () => {
  test("setup: a password can be shown and hidden, and says when the two match", async ({ page }) => {
    await page.goto("/");
    const password = page.getByLabel("Password", { exact: true });
    const confirm = page.getByLabel("Confirm password");
    await expect(password).toHaveAttribute("type", "password");
    await password.fill("garage-pass-1");
    const box = page.getByTestId("password-field").filter({ has: password });
    await box.getByRole("button", { name: "Show" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(password).toHaveValue("garage-pass-1");
    await expect(confirm).toHaveAttribute("type", "password");
    await box.getByRole("button", { name: "Hide" }).click();
    await expect(password).toHaveAttribute("type", "password");
    await confirm.fill("garage-pass-2");
    await confirm.blur();
    await expect(page.getByText("The passwords don't match")).toBeVisible();
    await confirm.fill("garage-pass-1");
    await expect(page.getByText("Passwords match")).toBeVisible();
    await page.reload();
    await setUpGarage(page);
  });

  test("a new user's password is typed twice; a reset too", async ({ page, request }) => {
    const api = await owner(page, request);
    await page.goto("/#/settings/users");
    await page.getByRole("button", { name: "Add user" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Sara Ali");
    await dialog.getByLabel("Username").fill("sara");
    await dialog.getByLabel("Password", { exact: true }).fill("sara-pass-1");
    await dialog.getByLabel("Confirm password").fill("sara-pass-2");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("The passwords don't match")).toBeVisible();
    expect((await api("get", "/api/users")).users).toHaveLength(1);
    await dialog.getByLabel("Confirm password").fill("sara-pass-1");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("User added")).toBeVisible();
    await page.getByText("Sara Ali").click();
    await expect(dialog.getByLabel("Confirm password")).toHaveCount(0);
    await dialog.getByLabel("New password").fill("sara-pass-9");
    await dialog.getByLabel("Confirm password").fill("sara-pass-9");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("User updated")).toBeVisible();
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await signIn(page, { username: "sara", password: "sara-pass-9" });
  });

  const newCustomer = async (page: Page, name: string) => {
    await page.goto("/#/customers");
    await page.getByRole("button", { name: "New customer" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Full name").fill(name);
    return form;
  };

  test("a whole phone typed in the box is sorted; a wrong one isn't saved", async ({ page, request }) => {
    const api = await owner(page, request);
    const form = await newCustomer(page, "Phone One");
    const phone = form.getByLabel("Mobile / phone");
    await phone.fill("+971501234567");
    await phone.blur();
    await expect(form.getByLabel("Country code")).toHaveValue("AE");
    await expect(phone).toHaveValue("50 123 4567");
    await form.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByText("Customer added")).toBeVisible();
    expect((await api("get", "/api/customers?q=Phone%20One")).customers[0].phone).toBe("+971 50 123 4567");

    const other = await newCustomer(page, "Phone Two");
    await other.getByLabel("Mobile / phone").fill("050 123 456");
    await other.getByLabel("Mobile / phone").blur();
    await expect(other.getByText("A UAE mobile has 10 digits, like 050 123 4567")).toBeVisible();
    await other.getByRole("button", { name: "Save customer" }).click();
    await expect(other).toBeVisible();
    await other.getByLabel("Mobile / phone").fill("+91 98765 43210");
    await other.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await api("get", "/api/customers?q=Phone%20Two")).customers[0].phone).toBe("+91 9876543210");
  });

  test("a phone typed key by key keeps every digit, and another country can be chosen", async ({ page, request }) => {
    const api = await owner(page, request);
    const form = await newCustomer(page, "Phone Three");
    await form.getByLabel("Country code").selectOption("OM");
    await form.getByLabel("Mobile / phone").pressSequentially("91234567");
    await form.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await api("get", "/api/customers?q=Phone%20Three")).customers[0].phone).toBe("+968 91234567");
    const four = await newCustomer(page, "Phone Four");
    await four.getByLabel("Mobile / phone").pressSequentially("0509876543");
    await expect(four.getByLabel("Mobile / phone")).toHaveValue("0509876543");
    await four.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await api("get", "/api/customers?q=Phone%20Four")).customers[0].phone).toBe("+971 50 987 6543");
  });

  test("an odd phone is kept in one plain box", async ({ page, request }) => {
    const api = await owner(page, request);
    const { customer } = await api("post", "/api/customers", { name: "Odd Phone", phone: "050 123 4567 / 055 1112222" });
    await page.goto(`/#/customers/${customer.id}`);
    await page.getByRole("button", { name: "Edit" }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByLabel("Mobile / phone")).toHaveValue("050 123 4567 / 055 1112222");
    await expect(form.getByLabel("Country code")).toHaveCount(0);
    await form.getByLabel("Notes").fill("Two numbers");
    await form.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByText("Customer updated")).toBeVisible();
    expect((await api("get", `/api/customers/${customer.id}`)).customer).toMatchObject({ phone: "050 123 4567 / 055 1112222", notes: "Two numbers" });
  });

  test("a short TRN shows its count and isn't saved", async ({ page }) => {
    await signIn(page);
    const form = await newCustomer(page, "TRN LLC");
    await form.getByLabel("Type").selectOption("company");
    await form.getByLabel("Customer TRN").fill("1001234567");
    await form.getByLabel("Customer TRN").blur();
    await expect(form.getByText("A UAE TRN has 15 digits (this has 10)")).toBeVisible();
    await form.getByRole("button", { name: "Save customer" }).click();
    await expect(form).toBeVisible();
    await form.getByLabel("Customer TRN").fill("100123456700003");
    await form.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByText("Customer added")).toBeVisible();
  });

  test("a whole plate typed in the box is sorted; one from elsewhere is as typed; a short VIN is only noted", async ({ page, request }) => {
    const api = await owner(page, request);
    const { customer } = await api("post", "/api/customers", { name: "Plates" });
    const add = async () => {
      await page.goto(`/#/customers/${customer.id}`);
      await page.getByRole("button", { name: "Add vehicle" }).click();
      return page.getByRole("dialog");
    };
    let form = await add();
    await form.getByLabel("Plate number").fill("shj 3 48213");
    await expect(form.getByLabel("Plate emirate")).toHaveValue("SHJ");
    await expect(form.getByLabel("Plate code")).toHaveValue("3");
    await expect(form.getByLabel("Plate number")).toHaveValue("48213");
    await form.getByLabel("VIN / chassis number").fill("grj76-1234567");
    await expect(form.getByText("A VIN usually has 17 characters (this has 13)")).toBeVisible();
    await form.getByLabel("Year").fill("21");
    await form.getByRole("button", { name: "Save vehicle" }).click();
    await expect(form.getByText(/Enter a year from 1900/)).toBeVisible();
    await form.getByLabel("Year").fill("2021");
    await form.getByRole("button", { name: "Save vehicle" }).click();
    await expect(page.getByText("Vehicle added")).toBeVisible();
    form = await add();
    await form.getByLabel("Plate emirate").selectOption("other");
    await form.getByLabel("Plate number").fill("ksa 1234 abc");
    await form.getByRole("button", { name: "Save vehicle" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const { vehicles } = await api("get", `/api/customers/${customer.id}`);
    expect(vehicles.map((v: { plate: string }) => v.plate).sort()).toEqual(["KSA 1234 ABC", "SHJ 3 48213"]);
    expect(vehicles.find((v: { plate: string }) => v.plate === "SHJ 3 48213").vin).toBe("GRJ76-1234567");
  });

  test("setup's address prints as lines and its emirate is the VAT emirate", async ({ page, request }) => {
    const api = await owner(page, request);
    const { garage, settings } = await api("get", "/api/settings");
    expect(garage).toMatchObject({ address: "Warehouse 12\nAl Quoz Industrial 3\nDubai", addressParts: { unit: "Warehouse 12", area: "Al Quoz Industrial 3", emirate: "dubai" } });
    expect(settings.garage.emirate).toBe("dubai");
  });

  test("garage details has the address form with one Emirate box, and saves both", async ({ page, request }) => {
    const api = await owner(page, request);
    await page.goto("/#/settings/garage");
    await expect(page.getByLabel("Emirate")).toHaveCount(1);
    await expect(page.getByLabel("Emirate")).toHaveValue("dubai");
    await page.getByLabel("Street").fill("Street 6");
    await page.getByLabel("PO Box").fill("1234");
    await page.getByLabel("Emirate").selectOption("sharjah");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved")).toBeVisible();
    await expect.poll(async () => (await api("get", "/api/settings")).garage.address).toBe("Warehouse 12\nStreet 6, Al Quoz Industrial 3\nSharjah, PO Box 1234");
    expect((await api("get", "/api/settings")).settings.garage.emirate).toBe("sharjah");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled(); // the screen has caught up
    await page.getByLabel("Emirate").selectOption("dubai");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await api("get", "/api/settings")).garage.address).toBe("Warehouse 12\nStreet 6, Al Quoz Industrial 3\nDubai, PO Box 1234");
  });

  test("garage details: a save that fails halfway keeps what was typed", async ({ page, request }) => {
    const api = await owner(page, request);
    await page.goto("/#/settings/garage");
    await page.route("**/api/settings/garage", (r) => (r.request().method() === "PUT" ? r.abort() : r.continue()));
    await page.getByLabel("Building").fill("Block B");
    await page.getByLabel("Emirate").selectOption("ajman");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await api("get", "/api/settings")).garage.addressParts.building).toBe("Block B");
    await page.waitForTimeout(800);
    await expect(page.getByLabel("Emirate")).toHaveValue("ajman");
    await expect(page.getByLabel("Building")).toHaveValue("Block B");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await api("get", "/api/settings")).settings.garage.emirate).toBe("ajman");
  });

  test("a customer's address is saved in parts and printed", async ({ page, request }) => {
    const api = await owner(page, request);
    const form = await newCustomer(page, "Address One");
    await form.getByLabel("Unit / shop no.").fill("Villa 4");
    await form.getByLabel("Street").fill("Street 12");
    await form.getByLabel("Area").fill("Al Barsha 1");
    await form.getByLabel("Emirate").selectOption("dubai");
    await form.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const c = (await api("get", "/api/customers?q=Address%20One")).customers[0];
    expect(c).toMatchObject({ address: "Villa 4\nStreet 12, Al Barsha 1\nDubai", addressParts: { unit: "Villa 4", emirate: "dubai" } });
    await page.goto(`/#/customers/${c.id}`);
    await page.getByRole("button", { name: "Edit" }).first().click();
    await expect(form.getByLabel("Street")).toHaveValue("Street 12");
    await expect(form.getByLabel("Arabic address")).toBeVisible();
  });

  test("a supplier abroad has a country, and no emirate", async ({ page, request }) => {
    const api = await owner(page, request);
    await page.goto("/#/suppliers");
    await page.getByRole("button", { name: "New supplier" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name", { exact: true }).fill("Muscat Parts");
    await expect(form.getByLabel("Country", { exact: true })).toHaveValue("United Arab Emirates");
    await expect(form.getByLabel("Emirate")).toBeVisible();
    await form.getByLabel("Building").fill("Al Noor");
    await form.getByLabel("Country", { exact: true }).selectOption("Oman");
    await expect(form.getByLabel("Emirate")).toHaveCount(0);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Supplier saved")).toBeVisible();
    const s = (await api("get", "/api/suppliers")).suppliers.find((x: { name: string }) => x.name === "Muscat Parts");
    expect(s).toMatchObject({ address: "Al Noor\nOman", addressParts: { country: "Oman", emirate: null } });
  });

  test("an old customer with a bad TRN and an odd phone: changing the notes saves, and both stay", async ({ page, request }) => {
    const api = await owner(page, request);
    const { customer } = await api("post", "/api/customers", { kind: "company", name: "Old Record LLC", trn: "123", phone: "office 04", email: "old@office", address: "Villa 4\nAl Barsha" });
    await page.goto(`/#/customers/${customer.id}`);
    await page.getByRole("button", { name: "Edit" }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByLabel("Street")).toHaveValue("Villa 4, Al Barsha");
    await form.getByLabel("Customer TRN").focus();
    await form.getByLabel("Email").focus();
    await form.getByLabel("Notes").fill("Pays monthly");
    await expect(form.getByRole("alert")).toHaveCount(0);
    await form.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByText("Customer updated")).toBeVisible();
    expect((await api("get", `/api/customers/${customer.id}`)).customer).toMatchObject({ trn: "123", phone: "office 04", email: "old@office", address: "Villa 4\nAl Barsha", notes: "Pays monthly" });
  });

  const newJobCard = async (page: Page, query = "") => {
    await page.goto(`/#/documents/new/jobcard${query}`);
    await expect(page.getByRole("heading", { name: /New job card/ })).toBeVisible();
  };
  const pickCustomer = async (page: Page, text: string) => {
    await page.getByText("Choose customer…").click();
    await page.getByPlaceholder("Search name, phone or plate…").fill(text);
  };

  test("a new customer's vehicle is added without leaving the job card", async ({ page, request }) => {
    const api = await owner(page, request);
    await newJobCard(page);
    await page.getByLabel("Line title").first().fill("Front brakes");
    await pickCustomer(page, "Ahmed Saleh");
    await page.getByText(/New customer “/).click();
    await page.getByRole("button", { name: "Save customer" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "New vehicle for Ahmed Saleh" })).toBeVisible();
    // The job card isn't made (and no "vehicle received" message offered) while its vehicle is being typed.
    await page.waitForTimeout(1800);
    expect((await api("get", "/api/documents?type=jobcard")).documents.filter((d: { customerName: string }) => d.customerName === "Ahmed Saleh")).toHaveLength(0);
    await dialog.getByLabel("Plate number").fill("dxb k 48213");
    await dialog.getByLabel("Make").fill("Toyota");
    await dialog.getByLabel("Odometer (km)").fill("84250");
    await dialog.getByRole("button", { name: "Save vehicle" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Vehicle" }).locator("option:checked")).toHaveText(/DXB K 48213/);
    await expect(page.getByLabel("Odometer (km)")).toHaveValue("84250");
    await expect(page.getByLabel("Line title").first()).toHaveValue("Front brakes");
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });
    const doc = (await api("get", "/api/documents?type=jobcard")).documents.find((d: { customerName: string }) => d.customerName === "Ahmed Saleh");
    expect(doc.plate).toBe("DXB K 48213");
  });

  test("Skip leaves the job card without a vehicle", async ({ page }) => {
    await signIn(page);
    await newJobCard(page);
    await pickCustomer(page, "Counter Sale");
    await page.getByText(/New customer “/).click();
    await page.getByRole("button", { name: "Save customer" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Skip" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Counter Sale", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Vehicle" })).toHaveValue("");
  });

  test("New vehicle from the list on a saved job card", async ({ page, request }) => {
    const api = await owner(page, request);
    const { customer } = await api("post", "/api/customers", { name: "Later Vehicle" });
    const { document } = await api("post", "/api/documents", { type: "jobcard", customerId: customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] });
    await page.goto(`/#/documents/${document.id}`);
    await page.getByRole("combobox", { name: "Vehicle" }).selectOption({ label: "+ New vehicle" });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    await dialog.getByLabel("Plate number").fill("AUH 12 34567");
    await dialog.getByRole("button", { name: "Save vehicle" }).click();
    await expect(page.getByRole("combobox", { name: "Vehicle" }).locator("option:checked")).toHaveText(/AUH 12 34567/);
    await expect.poll(async () => (await api("get", `/api/documents/${document.id}`)).document.vehicle?.plate).toBe("AUH 12 34567");
    // Closing the form without saving leaves the choice as it was.
    await page.getByRole("combobox", { name: "Vehicle" }).selectOption({ label: "+ New vehicle" });
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("combobox", { name: "Vehicle" }).locator("option:checked")).toHaveText(/AUH 12 34567/);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Vehicle" }).locator("option:checked")).toHaveText(/AUH 12 34567/);
  });

  test("a customer with one vehicle gets it selected; searching by plate picks that vehicle", async ({ page, request }) => {
    const api = await owner(page, request);
    const one = (await api("post", "/api/customers", { name: "One Car" })).customer;
    await api("post", "/api/vehicles", { customerId: one.id, plate: "RAK A 111", odometer: 5000 });
    const two = (await api("post", "/api/customers", { name: "Two Cars" })).customer;
    await api("post", "/api/vehicles", { customerId: two.id, plate: "FUJ B 2221" });
    await api("post", "/api/vehicles", { customerId: two.id, plate: "FUJ B 3331", odometer: 7000 });
    const vehicle = page.getByRole("combobox", { name: "Vehicle" }).locator("option:checked");
    await newJobCard(page);
    await pickCustomer(page, "One Car");
    await page.getByText("One Car", { exact: true }).click();
    await expect(vehicle).toHaveText(/RAK A 111/);
    await expect(page.getByLabel("Odometer (km)")).toHaveValue("5000");
    await page.goto("/#/vehicles");
    await page.evaluate(() => localStorage.clear());
    await newJobCard(page);
    await pickCustomer(page, "fuj b 3331");
    await page.getByText("Two Cars", { exact: true }).click();
    await expect(vehicle).toHaveText(/FUJ B 3331/);
    await expect(page.getByLabel("Odometer (km)")).toHaveValue("7000");
    await page.goto("/#/vehicles");
    await page.evaluate(() => localStorage.clear());
    await newJobCard(page);
    await pickCustomer(page, "Two Cars");
    await page.getByText("Two Cars", { exact: true }).click();
    await expect(vehicle).toHaveText("Choose vehicle…");
  });

  test("another car's odometer never goes onto the new vehicle", async ({ page, request }) => {
    const api = await owner(page, request);
    const ali = (await api("post", "/api/customers", { name: "Wrong Person" })).customer;
    await api("post", "/api/vehicles", { customerId: ali.id, plate: "SHJ 1 7777", odometer: 99000 });
    const dialog = page.getByRole("dialog");
    // The wrong person first (their car and its km are chosen), then a new customer with their own car.
    await newJobCard(page);
    await pickCustomer(page, "Wrong Person");
    await page.getByText("Wrong Person", { exact: true }).click();
    await expect(page.getByLabel("Odometer (km)")).toHaveValue("99000");
    await page.getByText("Wrong Person", { exact: true }).click();
    await page.getByPlaceholder("Search name, phone or plate…").fill("Sara New");
    await page.getByText(/New customer “/).click();
    await page.getByRole("button", { name: "Save customer" }).click();
    await dialog.getByLabel("Plate number").fill("SHJ 2 8888");
    await dialog.getByLabel("Odometer (km)").fill("12000");
    await dialog.getByRole("button", { name: "Save vehicle" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Odometer (km)")).toHaveValue("12000");
    // A new vehicle without a reading, over a chosen one: blank, not the other car's.
    await page.goto("/#/vehicles");
    await expect(page.getByRole("heading", { name: "Vehicles" })).toBeVisible();
    await page.evaluate(() => localStorage.clear());
    await newJobCard(page, `?customerId=${ali.id}`);
    await expect(page.getByLabel("Odometer (km)")).toHaveValue("99000");
    await page.getByRole("combobox", { name: "Vehicle" }).selectOption({ label: "+ New vehicle" });
    await dialog.getByLabel("Plate number").fill("SHJ 3 9999");
    await dialog.getByRole("button", { name: "Save vehicle" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Odometer (km)")).toHaveValue("");
    await page.evaluate(() => localStorage.clear());
  });

  test("choosing the same customer again, by plate or by name", async ({ page, request }) => {
    const api = await owner(page, request);
    const fleet = (await api("post", "/api/customers", { name: "Same Fleet" })).customer;
    await api("post", "/api/vehicles", { customerId: fleet.id, plate: "AJM A 4441" });
    await api("post", "/api/vehicles", { customerId: fleet.id, plate: "AJM A 5551", odometer: 6100 });
    const vehicle = page.getByRole("combobox", { name: "Vehicle" }).locator("option:checked");
    await newJobCard(page, `?customerId=${fleet.id}`);
    await expect(vehicle).toHaveText("Choose vehicle…");
    await page.getByText("Same Fleet", { exact: true }).click();
    await page.getByPlaceholder("Search name, phone or plate…").fill("AJM A 5551");
    await page.getByText("Same Fleet", { exact: true }).click();
    await expect(vehicle).toHaveText(/AJM A 5551/);
    await expect(page.getByLabel("Odometer (km)")).toHaveValue("6100");
    await page.getByText("Same Fleet", { exact: true }).click();
    await page.getByPlaceholder("Search name, phone or plate…").fill("Same Fl");
    await page.getByText("Same Fleet", { exact: true }).click();
    await expect(vehicle).toHaveText(/AJM A 5551/);
    await page.evaluate(() => localStorage.clear());
  });

  test("a driver's phone that's wrong stays marked after auto-save", async ({ page, request }) => {
    const api = await owner(page, request);
    const { customer } = await api("post", "/api/customers", { name: "Driver Check" });
    const { document } = await api("post", "/api/documents", { type: "jobcard", customerId: customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] });
    await page.goto(`/#/documents/${document.id}`);
    await page.getByLabel("Driver phone").fill("05012");
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });
    await page.getByLabel("Driver name").focus();
    await expect(page.getByText("A UAE mobile has 10 digits, like 050 123 4567")).toBeVisible();
    await page.getByLabel("Driver phone").fill("+998 90 123 4567");
    await page.getByLabel("Driver name").focus();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("Driver phone")).toHaveValue("+998 90 123 4567");
    await expect(page.getByLabel("Country code")).toHaveCount(0);
  });

  test("a plate typed key by key with a number code is sorted; a VIN is corrected where the cursor is", async ({ page, request }) => {
    const api = await owner(page, request);
    const { customer } = await api("post", "/api/customers", { name: "Typing Plates" });
    await page.goto(`/#/customers/${customer.id}`);
    await page.getByRole("button", { name: "Add vehicle" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Plate number").pressSequentially("AUH 14 34568");
    await form.getByLabel("Make").focus();
    await expect(form.getByLabel("Plate emirate")).toHaveValue("AUH");
    await expect(form.getByLabel("Plate code")).toHaveValue("14");
    await expect(form.getByLabel("Plate number")).toHaveValue("34568");
    const vin = form.getByLabel("VIN / chassis number");
    await vin.fill("JTMHV05J604012345");
    await vin.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
    await vin.pressSequentially("ab");
    await vin.blur();
    await expect(vin).toHaveValue("JTMABHV05J604012345");
    await vin.fill("jtmhv05j604012345");
    await vin.press("Enter");
    await expect(page.getByText("Vehicle added")).toBeVisible();
    const { vehicles } = await api("get", `/api/customers/${customer.id}`);
    expect(vehicles[0]).toMatchObject({ plate: "AUH 14 34568", vin: "JTMHV05J604012345" });
  });

  test("a TRN typed with spaces is kept without them, even when Enter saves it", async ({ page, request }) => {
    const api = await owner(page, request);
    const form = await newCustomer(page, "Spaces LLC");
    await form.getByLabel("Type").selectOption("company");
    await form.getByLabel("Customer TRN").fill("100 1234 5670 0003");
    await form.getByLabel("Customer TRN").press("Enter");
    await expect(page.getByText("Customer added")).toBeVisible();
    expect((await api("get", "/api/customers?q=Spaces%20LLC")).customers[0].trn).toBe("100123456700003");
  });

  test("screens", async ({ page, request, browser }) => {
    const api = await owner(page, request);
    const { customer } = await api("post", "/api/customers", { kind: "company", name: "Emirates Logistics LLC", trn: "100987654300003", phone: "+971 50 123 4567", addressParts: { unit: "Office 12", building: "Al Noor Tower", street: "Street 6", area: "Al Quoz 3", emirate: "dubai", poBox: "1234", country: null } });
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const shot = async (name: string) => page.screenshot({ path: `test-results/screens/fields-${name}-${width}.png`, fullPage: true });
      await page.goto("/#/settings/garage");
      await expect(page.getByLabel("Street")).toBeVisible();
      await shot("garage");
      await page.goto(`/#/customers/${customer.id}`);
      await page.getByRole("button", { name: "Edit" }).first().click();
      await shot("customer");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Add vehicle" }).click();
      await shot("vehicle");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.goto("/#/suppliers");
      await page.getByRole("button", { name: "New supplier" }).click();
      await shot("supplier");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.goto("/#/settings/users");
      await page.getByRole("button", { name: "Add user" }).click();
      await shot("user");
      await page.getByRole("button", { name: "Cancel" }).click();
      // Setup, as a first run sees it.
      const first = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: "light" });
      await first.route("**/api/setup/status", (r) => r.fulfill({ json: { configured: false }, headers: { "access-control-allow-origin": "*" } }));
      await first.goto("/");
      await expect(first.getByRole("heading", { name: "Set up your garage" })).toBeVisible();
      await first.screenshot({ path: `test-results/screens/fields-setup-${width}.png`, fullPage: true });
      await first.close();
    }
  });
});
