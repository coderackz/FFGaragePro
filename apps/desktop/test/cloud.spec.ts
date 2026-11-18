import { expect, test } from "@playwright/test";
import { garageDay, shooter, stockDay } from "./flow";

test("cloud garage day: Fleet Fix creates the garage, the owner runs it in a browser", async ({ page }) => {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  const shot = shooter(page, "cloud-");

  // Fleet Fix staff create the garage and get its setup code.
  await page.goto("/admin.html");
  await page.getByLabel("Username").fill("fleetfix");
  await page.getByLabel("Password").fill("admin-pass-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New garage" }).click();
  await page.getByLabel("Garage name").fill("Al Quoz Auto Care");
  await page.getByLabel("Garage ID").fill("alquoz-auto");
  await page.getByRole("button", { name: "Create garage" }).click();
  const welcome = await page.getByTestId("welcome").textContent();
  const setupCode = /Setup code: ([A-Z0-9]{8})/.exec(welcome ?? "")?.[1];
  expect(setupCode).toBeTruthy();
  await shot("00-admin");

  // The owner opens the browser app with the garage ID (typed loosely) and sets up with the code.
  await page.goto("/");
  await page.getByLabel("Garage ID").fill(" AlQuoz-Auto ");
  await page.getByRole("button", { name: "Continue" }).click();
  await garageDay(page, shot, { setupCode });
  await stockDay(page, shot);

  // Back in admin: the garage is set up with one user.
  await page.goto("/admin.html");
  await expect(page.getByRole("row", { name: /alquoz-auto/ })).toContainText("Yes");
});

test("wrong garage ID", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Garage ID").fill("nope-garage");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("No garage with that ID")).toBeVisible();
});
