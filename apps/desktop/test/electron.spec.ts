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

  // An English + Arabic estimate: the PDF carries the bundled Arabic font (drawn with it, not a fallback).
  const arPdf = resolve(`test-results/screens/${prefix}bilingual.pdf`);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
  }, arPdf);
  const estimateId = await win.evaluate(async () => {
    const base = window.ffgp!.apiBase;
    const headers = { "content-type": "application/json", authorization: `Bearer ${sessionStorage.getItem("ffgp.token")}` };
    const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) })).json();
    const { customer } = await post("/api/customers", { name: "Mohammed Al Marri", nameAr: "محمد المري", docLanguage: "en_ar" });
    const { document } = await post("/api/documents", {
      type: "estimate", customerId: customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }],
    });
    return document.id as string;
  });
  await win.evaluate((id) => { location.hash = `#/documents/${id}`; }, estimateId);
  await expect(win.getByLabel("Document language")).toHaveValue("en_ar");
  await win.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(win.getByText(arPdf)).toBeVisible({ timeout: 30_000 }); // the toast names the file once it's written
  expect(readFileSync(arPdf).toString("latin1")).toContain("NotoNaskhArabic");
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

test("messages: makePdf returns a PDF and WhatsApp saves the attachment", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "ffgp-electron-msg-"));
  const docs = mkdtempSync(join(tmpdir(), "ffgp-docs-"));
  const app = await launch(dataDir);
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  const b64 = await win.evaluate(() => window.ffgp!.makePdf("<!doctype html><p>Invoice INV-00001</p>"));
  expect(Buffer.from(b64, "base64").subarray(0, 5).toString()).toBe("%PDF-");

  // WhatsApp: the PDF lands in Documents/Fleetfix Garage Pro/Sent and the wa.me chat opens (stubbed here).
  await app.evaluate(({ app: electronApp, shell }, dir) => {
    electronApp.setPath("documents", dir);
    const g = globalThis as unknown as { opened: string[]; shown: string[] };
    g.opened = [];
    g.shown = [];
    shell.openExternal = async (url: string) => void g.opened.push(url);
    shell.showItemInFolder = (p: string) => void g.shown.push(p);
  }, docs);
  await win.evaluate((pdf) => window.ffgp!.whatsapp({ url: "https://wa.me/971501234567?text=Hi", pdf: { fileName: "INV-00001.pdf", base64: pdf } }), b64);
  const saved = join(docs, "Fleetfix Garage Pro", "Sent", "INV-00001.pdf");
  expect(readFileSync(saved).subarray(0, 5).toString()).toBe("%PDF-");
  expect(await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual(["https://wa.me/971501234567?text=Hi"]);
  await expect(win.evaluate(() => window.ffgp!.whatsapp({ url: "https://evil.example/", pdf: null }))).rejects.toThrow(/WhatsApp link/);
  await app.close();
});
