import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { OWNER, setUpGarage, shooter } from "./flow";

const API = "http://127.0.0.1:4780";
const token = (page: Page) => page.evaluate(() => sessionStorage.getItem("ffgp.token"));

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
}
async function apiAs(page: Page, request: APIRequestContext) {
  const headers = { authorization: `Bearer ${await token(page)}` };
  return async (method: "get" | "post", path: string, data?: unknown) => (await (await request[method](`${API}${path}`, { headers, data })).json());
}

test.describe.serial("vehicle makes and models", () => {
  let customerId = "";
  const addVehicle = async (page: Page) => {
    await page.goto(`/#/customers/${customerId}`);
    await page.getByRole("button", { name: "Add vehicle" }).click();
    return page.getByRole("dialog");
  };

  test("misspellings and short names are corrected on leaving the box, with Undo; an unlisted car is kept", async ({ page, request }) => {
    await page.goto("/");
    await setUpGarage(page);
    const api = await apiAs(page, request);
    customerId = (await api("post", "/api/customers", { name: "Ahmed", phone: "0501112222" })).customer.id;

    let form = await addVehicle(page);
    await form.getByLabel("Plate number").fill("D 11111");
    await form.getByLabel("Make", { exact: true }).fill("Toyta");
    await form.getByLabel("Model", { exact: true }).fill("landcruser");
    await form.getByLabel("Year").click();
    await expect(form.getByLabel("Make", { exact: true })).toHaveValue("Toyota");
    await expect(form.getByLabel("Model", { exact: true })).toHaveValue("Land Cruiser");
    await expect(form.getByTestId("make-note")).toContainText("Corrected from Toyta");
    await expect(form.getByTestId("model-note")).toContainText("Corrected from landcruser");
    await shooter(page, "vehicles-")("corrected");
    await form.getByRole("button", { name: "Save vehicle" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    form = await addVehicle(page);
    await form.getByLabel("Plate number").fill("D 22222");
    await form.getByLabel("Model", { exact: true }).fill("LC200");
    await form.getByLabel("Year").click();
    await expect(form.getByLabel("Make", { exact: true })).toHaveValue("Toyota");
    await expect(form.getByTestId("make-note")).toContainText("Filled in from the model");
    await expect(form.getByLabel("Model", { exact: true })).toHaveValue("Land Cruiser");
    await form.getByTestId("model-note").getByRole("button", { name: "Undo" }).click();
    await expect(form.getByLabel("Model", { exact: true })).toHaveValue("LC200");
    await form.getByLabel("Model", { exact: true }).click();
    await form.getByLabel("Year").click();
    await expect(form.getByLabel("Model", { exact: true })).toHaveValue("LC200"); // kept: not corrected again
    await form.getByRole("button", { name: "Save vehicle" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    form = await addVehicle(page);
    await form.getByLabel("Plate number").fill("D 33333");
    await form.getByLabel("VIN / chassis number").fill("WDD2050461A123456");
    await expect(form.getByLabel("Make", { exact: true })).toHaveValue("Mercedes-Benz");
    await form.getByRole("button", { name: "Cancel" }).click();

    form = await addVehicle(page);
    await form.getByLabel("Plate number").fill("D 44444");
    await form.getByLabel("Make", { exact: true }).fill("Rox");
    await form.getByLabel("Model", { exact: true }).fill("01");
    await form.getByLabel("Year").click();
    await expect(form.getByLabel("Make", { exact: true })).toHaveValue("Rox");
    await expect(form.getByTestId("make-note")).toHaveCount(0);
    await form.getByRole("button", { name: "Save vehicle" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const { vehicles } = await api("get", `/api/customers/${customerId}`);
    expect(vehicles.map((v: { make: string; model: string }) => `${v.make} ${v.model}`).sort()).toEqual(["Rox 01", "Toyota LC200", "Toyota Land Cruiser"]);
  });

  test("the owner merges a spelling from Vehicles → Makes & models", async ({ page, request }) => {
    await signIn(page);
    const api = await apiAs(page, request);
    await api("post", "/api/vehicles", { customerId, plate: "D 55555", make: "Toyta", model: "Camry" }); // typed elsewhere, as it was
    await page.getByRole("navigation").getByRole("link", { name: "Vehicles", exact: true }).click();
    await page.getByRole("button", { name: "Makes & models" }).click();
    const makes = page.getByTestId("garage-makes");
    await expect(makes).toContainText("Looks like Toyota");
    await shooter(page, "vehicles-")("tidy");
    await makes.getByRole("button", { name: "Change to Toyota" }).click();
    await expect(page.getByText("Toyta is now Toyota: 1 vehicle")).toBeVisible();
    await expect(makes).not.toContainText("Toyta");
    await makes.getByRole("button", { name: "Toyota" }).click();
    await expect(page.getByTestId("garage-models")).toContainText("Camry");
    expect((await api("get", "/api/vehicle-names")).makes).toEqual([{ name: "Rox", vehicles: 1 }, { name: "Toyota", vehicles: 3 }]);
  });
});
