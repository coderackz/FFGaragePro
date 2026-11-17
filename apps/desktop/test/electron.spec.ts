import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { garageDay, OWNER, shooter } from "./flow";

// The real desktop app, end to end. By default it runs the built app (`npm run build -w @ffgp/desktop`
// first). Set FFGP_EXE to an installed "Fleetfix Garage Pro.exe" to test what a garage actually installs.
const exe = process.env.FFGP_EXE;
const prefix = exe ? "win-" : "electron-";

function launch(dataDir: string): Promise<ElectronApplication> {
  const env = { ...process.env, FFGP_DATA_DIR: dataDir } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return exe ? electron.launch({ executablePath: exe, env }) : electron.launch({ args: ["apps/desktop"], env });
}

test("desktop app: garage day, PDF tax invoice, data kept after restart", async () => {
  test.setTimeout(180_000);
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
  await app.close();
});
