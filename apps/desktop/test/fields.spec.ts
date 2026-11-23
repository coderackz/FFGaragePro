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
    await page.getByLabel("Emirate").selectOption("dubai");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await api("get", "/api/settings")).garage.address).toBe("Warehouse 12\nStreet 6, Al Quoz Industrial 3\nDubai, PO Box 1234");
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
});
