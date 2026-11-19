import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, screenPrefix } from "./electron-app";
import { OWNER, setUpGarage, shooter } from "./flow";

// Two "PCs" on one machine, each with its own profile: A is the main computer, B connects to it.
// Port 47830 keeps the test clear of a real copy of the app sharing on 47820.
const PORT = "47830";
const nav = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();

test("main computer: share, pair a second PC, work together, remove it", async () => {
  test.setTimeout(240_000);
  mkdirSync(resolve("test-results/screens"), { recursive: true });
  const prefix = `${screenPrefix}net-`;

  const a = await launchApp({ FFGP_USER_DATA: mkdtempSync(join(tmpdir(), "ffgp-pc-a-")), FFGP_NETWORK_PORT: PORT });
  const pcA = await a.firstWindow();
  pcA.on("dialog", (d) => void d.accept());
  const shotA = shooter(pcA, `${prefix}a-`);
  await setUpGarage(pcA);

  // A: turn on sharing (the server restarts and the window reloads, still signed in), then get a pairing code.
  await nav(pcA, "Settings");
  await pcA.getByTestId("tile-other-pcs").click();
  await pcA.getByRole("button", { name: "Share with other PCs" }).click();
  await expect(pcA.getByText("Sharing on")).toBeVisible({ timeout: 20_000 });
  const lanAddresses = await pcA.getByTestId("lan-address").allTextContents();
  // Connect over a real network address, so the paired-PC check applies. Some machines (macOS firewall in
  // stealth mode) refuse connections to their own network address; then B uses loopback and the
  // "removed PC is cut off" step is left to the server tests.
  const reachable = async (h: string) => fetch(`http://${h}:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  let host = "127.0.0.1";
  for (const address of lanAddresses) if (await reachable(address)) { host = address; break; }
  const viaLan = host !== "127.0.0.1";
  console.log(`main computer shares on ${lanAddresses.join(", ") || "no network"}; PC B connects via ${host}:${PORT}`);
  if (!viaLan) test.info().annotations.push({ type: "note", description: "Own network address unreachable here; connected over loopback." });
  await pcA.getByRole("button", { name: "Pair a new PC" }).click();
  const code = (await pcA.getByTestId("pairing-code").textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);
  await shotA("01-sharing");

  // B: first run → connect to the main computer instead of setting up a garage.
  const b = await launchApp({ FFGP_USER_DATA: mkdtempSync(join(tmpdir(), "ffgp-pc-b-")) });
  const pcB = await b.firstWindow();
  pcB.on("dialog", (d) => void d.accept());
  const shotB = shooter(pcB, `${prefix}b-`);
  await expect(pcB.getByRole("heading", { name: "Set up your garage" })).toBeVisible({ timeout: 30_000 });
  await pcB.getByRole("button", { name: "Connect to main computer" }).click();
  await expect(pcB.getByRole("heading", { name: "Connect to the main computer" })).toBeVisible();
  await expect(pcB.getByRole("button", { name: /Al Quoz Auto Care/ })).toBeVisible({ timeout: 10_000 }); // found by discovery
  await pcB.getByLabel("Main computer address").fill(`${host}:${PORT}`);
  await pcB.getByLabel("Pairing code").fill(code);
  await pcB.getByLabel("Name for this PC").fill("Front desk");
  await shotB("02-connect");
  await pcB.getByRole("button", { name: "Connect", exact: true }).click();

  // B: now signs in against the main computer.
  await expect(pcB.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 20_000 });
  await expect(pcB.getByText(/Connected to Al Quoz Auto Care/)).toBeVisible();
  for (let i = 0; i < 5; i++) {
    await pcB.getByLabel("Username").fill("front");
    await pcB.getByLabel("Password").fill(`guess-${i}`);
    await pcB.getByRole("button", { name: "Sign in" }).click();
    await expect(pcB.getByText("Wrong username or password")).toBeVisible();
  }
  await pcB.getByRole("button", { name: "Sign in" }).click();
  await expect(pcB.getByText(/locked — try again in 5 minutes/)).toBeVisible();
  await shotB("03-locked");

  await pcB.getByLabel("Username").fill(OWNER.username);
  await pcB.getByLabel("Password").fill(OWNER.password);
  await pcB.getByRole("button", { name: "Sign in" }).click();
  await expect(pcB.getByText(/Good (morning|afternoon|evening), Rashid/)).toBeVisible();
  await nav(pcB, "Customers");
  await pcB.getByRole("button", { name: "New customer" }).click();
  await pcB.getByLabel("Full name").fill("Customer From Front Desk");
  await pcB.getByRole("button", { name: "Save customer" }).click();
  await expect(pcB.getByRole("heading", { name: "Customer From Front Desk" })).toBeVisible();

  // A sees B's customer: one garage database.
  await nav(pcA, "Customers");
  await expect(pcA.getByText("Customer From Front Desk")).toBeVisible();
  await shotA("04-sees-customer");

  // A removes B; B's next action shows it's disconnected.
  await nav(pcA, "Settings");
  await pcA.getByTestId("tile-other-pcs").click();
  await expect(pcA.getByText("Front desk", { exact: true })).toBeVisible();
  await pcA.getByRole("button", { name: "Remove Front desk" }).click();
  await expect(pcA.getByText("No other PCs yet.")).toBeVisible();
  if (viaLan) {
    await nav(pcB, "Vehicles");
    await expect(pcB.getByText("This PC is no longer connected")).toBeVisible();
    await shotB("05-removed");
  }

  await b.close();
  await a.close();
});
