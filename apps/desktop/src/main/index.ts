import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { startServer } from "@ffgp/server";

let apiBase = "";
let mainWindow: BrowserWindow | null = null;

// One copy per PC: two copies would run two servers on the same garage database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(boot).catch((error) => {
    dialog.showErrorBox("Fleetfix Garage Pro couldn't start", String(error?.stack ?? error));
    app.quit();
  });
}

async function boot(): Promise<void> {
  // FFGP_DATA_DIR lets tests run against a throwaway database.
  const dataDir = process.env.FFGP_DATA_DIR ?? join(app.getPath("userData"), "data");
  const { address } = await startServer({ dataDir });
  apiBase = address;
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  createWindow();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1100,
    minHeight: 680,
    title: "Fleetfix Garage Pro",
    backgroundColor: "#f4f4f5",
    show: false,
    webPreferences: { preload: join(__dirname, "../preload/index.cjs"), sandbox: true, contextIsolation: true },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => (mainWindow = null));
}

app.on("window-all-closed", () => app.quit());

ipcMain.on("ffgp:apiBase", (event) => {
  event.returnValue = apiBase;
});

/** Renders print HTML in a hidden window (Electron handles Arabic / RTL correctly). */
async function withPrintWindow<T>(html: string, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const file = join(app.getPath("temp"), `ffgp-print-${randomUUID()}.html`);
  await writeFile(file, html, "utf8");
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await win.loadFile(file);
    return await fn(win);
  } finally {
    win.destroy();
    await rm(file, { force: true });
  }
}

ipcMain.handle("ffgp:savePdf", async (_event, args: { html: string; fileName: string }) => {
  const pdf = await withPrintWindow(args.html, (win) =>
    win.webContents.printToPDF({ pageSize: "A4", printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } }),
  );
  const parent = mainWindow ?? undefined;
  const options = { defaultPath: join(app.getPath("documents"), args.fileName), filters: [{ name: "PDF", extensions: ["pdf"] }] };
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, pdf);
  void shell.openPath(result.filePath);
  return result.filePath;
});

ipcMain.handle("ffgp:print", async (_event, args: { html: string }) =>
  withPrintWindow(
    args.html,
    (win) =>
      new Promise<boolean>((resolve) => {
        win.webContents.print({ printBackground: true }, (success) => resolve(success));
      }),
  ),
);
