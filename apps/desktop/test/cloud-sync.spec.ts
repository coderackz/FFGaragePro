import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./electron-app";
import { OWNER, setUpGarage, shooter } from "./flow";

// The built desktop app linked to Fleetfix Cloud (port 4792), checked from the browser app on the same cloud.
const CLOUD = "http://localhost:4792";

async function createGarage(code: string, name: string): Promise<string> {
  const login = await fetch(`${CLOUD}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "fleetfix", password: "admin-pass-1" }) });
  const { token } = (await login.json()) as { token: string };
  const res = await fetch(`${CLOUD}/admin/api/garages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ code, name }),
  });
  const body = (await res.json()) as { garage: { setupCode: string } };
  return body.garage.setupCode;
}

async function openGarage(page: Page, code: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await page.getByLabel("Garage ID").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function signIn(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Username").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Good (morning|afternoon|evening), Rashid/)).toBeVisible();
}

async function addCustomer(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation").getByRole("link", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Full name").fill(name);
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function customerNames(page: Page): Promise<void> {
  await page.getByRole("navigation").getByRole("link", { name: "Customers", exact: true }).click();
}

async function syncNow(win: Page): Promise<void> {
  await win.getByRole("navigation").getByRole("link", { name: "Settings", exact: true }).click();
  const card = win.getByTestId("cloud-card");
  await expect(card).toBeVisible();
  await win.getByRole("button", { name: "Sync now" }).click();
  await expect(win.getByText("Synced with Fleetfix cloud")).toBeVisible({ timeout: 20_000 });
}

test("a new PC downloads the cloud garage and edits meet both ways", async ({ page }) => {
  const shot = shooter(page, "sync-");
  const setupCode = await createGarage("alquoz-auto", "Al Quoz Auto Care");

  // The owner sets the garage up in the browser and adds a customer.
  await openGarage(page, "alquoz-auto");
  await setUpGarage(page, async () => undefined, { setupCode });
  await addCustomer(page, "Customer A");

  // A new PC: first run → Connect to Fleetfix cloud → sign in → the cloud garage is on the PC.
  const app = await launchApp({ FFGP_USER_DATA: mkdtempSync(join(tmpdir(), "ffgp-sync-pc-")) });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  const pcShot = shooter(win, "sync-pc-");
  await expect(win.getByRole("heading", { name: "Set up your garage" })).toBeVisible({ timeout: 30_000 });
  await win.getByRole("button", { name: "Connect to Fleetfix cloud" }).click();
  const dialog = win.getByRole("dialog");
  await dialog.getByLabel("Garage ID").fill("alquoz-auto");
  await dialog.getByLabel("Username").fill(OWNER.username);
  await dialog.getByLabel("Password").fill(OWNER.password);
  await dialog.getByLabel("This PC's name").fill("Front desk");
  await dialog.getByLabel("Cloud address").fill(CLOUD);
  await pcShot("01-connect");
  await dialog.getByRole("button", { name: "Sign in and download" }).click();
  await signIn(win);
  await customerNames(win);
  await expect(win.getByRole("cell", { name: "Customer A" })).toBeVisible();

  // The PC adds a customer and syncs; the browser sees it.
  await addCustomer(win, "Customer B");
  await syncNow(win);
  await expect(win.getByTestId("cloud-card")).toContainText("alquoz-auto");
  await expect(win.getByTestId("cloud-card")).toContainText("P1");
  await pcShot("02-cloud-card");
  await page.reload();
  await customerNames(page);
  await expect(page.getByRole("cell", { name: "Customer B" })).toBeVisible();
  await shot("03-browser-sees-pc");

  // The browser adds one; the PC gets it on its next sync.
  await addCustomer(page, "Customer C");
  await syncNow(win);
  await customerNames(win);
  await expect(win.getByRole("cell", { name: "Customer C" })).toBeVisible();
  await pcShot("04-pc-sees-browser");
  await app.close();
});

test("an existing PC garage uploads", async ({ page }) => {
  const setupCode = await createGarage("pc-garage", "PC Garage");
  const app = await launchApp({ FFGP_USER_DATA: mkdtempSync(join(tmpdir(), "ffgp-sync-up-")) });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await setUpGarage(win);
  await addCustomer(win, "Customer on the PC");

  await win.getByRole("navigation").getByRole("link", { name: "Settings", exact: true }).click();
  await win.getByRole("button", { name: "Connect to Fleetfix cloud" }).click();
  const dialog = win.getByRole("dialog");
  await expect(dialog).toContainText("The cloud garage must be new");
  await dialog.getByLabel("Garage ID").fill("pc-garage");
  await dialog.getByLabel("Setup code").fill(setupCode);
  await dialog.getByLabel("Cloud address").fill(CLOUD);
  // Linking restarts the PC's server and reloads the window.
  const reloaded = win.waitForEvent("load", { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Upload this garage" }).click();
  await reloaded;
  await expect(win.getByTestId("cloud-card")).toContainText("pc-garage", { timeout: 30_000 });
  await shooter(win, "sync-up-")("01-linked");

  // The browser signs in as the PC's owner and sees the PC's customers.
  await openGarage(page, "pc-garage");
  await signIn(page);
  await customerNames(page);
  await expect(page.getByRole("cell", { name: "Customer on the PC" })).toBeVisible();
  await app.close();
});
