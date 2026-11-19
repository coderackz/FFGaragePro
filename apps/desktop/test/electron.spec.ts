import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, screenPrefix as prefix } from "./electron-app";
import { garageDay, OWNER, setUpGarage, shooter, stockDay } from "./flow";

// The real desktop app, end to end (built app, or the installed one when FFGP_EXE is set).
const launch = (dataDir: string) => launchApp({ FFGP_USER_DATA: dataDir });

test("desktop app: garage day, PDF tax invoice, data kept after restart", async () => {
  test.setTimeout(360_000);
  const dataDir = mkdtempSync(join(tmpdir(), "ffgp-electron-"));
  const pdfPath = resolve(`test-results/screens/${prefix}INV-00001.pdf`);
  mkdirSync(resolve("test-results/screens"), { recursive: true });

  let app = await launch(dataDir);
  let win = await app.firstWindow();
  win.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  win.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
  await garageDay(win, shooter(win, prefix));

  // PDF: answer the Save dialog in the main process, don't open a PDF viewer.
  await app.evaluate(({ dialog, shell }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
    shell.openPath = async () => "";
  }, pdfPath);
  await win.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(win.getByText("PDF saved")).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(pdfPath).subarray(0, 5).toString()).toBe("%PDF-");
  expect(statSync(pdfPath).size).toBeGreaterThan(10_000);
  await app.close();

  // Restart on the same database: sign in again, the invoice and its balance are still there.
  app = await launch(dataDir);
  win = await app.firstWindow();
  await expect(win.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 30_000 });
  await win.getByLabel("Username").fill(OWNER.username);
  await win.getByLabel("Password").fill(OWNER.password);
  await win.getByRole("button", { name: "Sign in" }).click();
  await win.getByRole("navigation").getByRole("link", { name: "Invoices", exact: true }).click();
  await expect(win.getByRole("cell", { name: "INV-00001" })).toBeVisible();
  await win.getByRole("cell", { name: "INV-00001" }).click();
  await expect(win.getByText("AED 180.40").first()).toBeVisible();
  await shooter(win, prefix)("07-after-restart");

  // Inventory on the real app (and on the installed Windows app in CI).
  win.on("dialog", (d) => void d.accept());
  await stockDay(win, shooter(win, prefix));

  // Backups: Back up now, and a file that isn't a backup is refused without touching the garage.
  await win.getByRole("navigation").getByRole("link", { name: "Settings", exact: true }).click();
  await win.getByTestId("tile-backups").click();
  await win.getByRole("button", { name: "Back up now" }).click();
  await expect(win.getByTestId("backup-status")).toContainText("Last backup just now");
  const notABackup = join(dataDir, "notes.db");
  writeFileSync(notABackup, "not a garage");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as unknown as typeof dialog.showOpenDialog;
  }, notABackup);
  await win.getByRole("button", { name: "Restore from a backup…" }).click();
  await expect(win.getByText("This file isn't a Fleetfix Garage Pro backup")).toBeVisible();
  await shooter(win, prefix)("08-backups");
  await win.getByRole("navigation").getByRole("link", { name: "Invoices", exact: true }).click();
  await expect(win.getByRole("cell", { name: "INV-00001" })).toBeVisible();
  await app.close();
});

test("closing with unsaved Settings changes asks first", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "ffgp-electron-close-"));
  const app = await launch(dataDir);
  const win = await app.firstWindow();
  await setUpGarage(win);
  await win.getByRole("navigation").getByRole("link", { name: "Settings", exact: true }).click();
  await win.getByTestId("tile-garage").click();
  await win.getByLabel("Bank").fill("Emirates NBD");
  await expect(win.getByText("Unsaved changes")).toBeVisible();

  // The native "Leave without saving?" question: answer Stay, the window stays and nothing is lost.
  const answer = (choice: number) =>
    app.evaluate(({ dialog }, c) => {
      const g = globalThis as unknown as { asked?: number };
      g.asked = g.asked ?? 0;
      dialog.showMessageBoxSync = ((..._args: unknown[]) => (g.asked! += 1, c)) as typeof dialog.showMessageBoxSync;
    }, choice);
  await answer(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { asked?: number }).asked ?? 0)).toBe(1);
  await expect(win.getByLabel("Bank")).toHaveValue("Emirates NBD");

  // Answer Leave: the app closes.
  await answer(0);
  const closed = app.waitForEvent("close", { timeout: 15_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
});
