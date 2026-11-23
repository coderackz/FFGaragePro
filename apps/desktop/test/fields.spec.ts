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
});
