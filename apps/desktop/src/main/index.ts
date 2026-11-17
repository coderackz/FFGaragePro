import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { discoverMainComputers, NETWORK_PORT, startGarageServer, type GarageServer } from "@ffgp/server";

// Tests run several "PCs" on one machine, each with its own profile folder.
if (process.env.FFGP_USER_DATA) app.setPath("userData", process.env.FFGP_USER_DATA);

/** How this PC works: its own garage (single PC or main computer), or connected to a main computer. */
type Config =
  | { mode: "local" }
  | { mode: "client"; host: string; port: number; deviceKey: string; garageName: string; deviceName: string };

interface Connection {
  apiBase: string;
  deviceKey: string | null;
  mode: "local" | "main" | "client";
  mainComputer: { host: string; garageName: string } | null;
}

let server: GarageServer | null = null;
let connection: Connection = { apiBase: "", deviceKey: null, mode: "local", mainComputer: null };
let mainWindow: BrowserWindow | null = null;

const configFile = () => join(app.getPath("userData"), "config.json");
const dataDir = () => process.env.FFGP_DATA_DIR ?? join(app.getPath("userData"), "data");
const networkPort = () => Number(process.env.FFGP_NETWORK_PORT) || NETWORK_PORT;

function readConfig(): Config {
  try {
    const c = JSON.parse(readFileSync(configFile(), "utf8")) as Config;
    return c.mode === "client" && c.host && c.deviceKey ? c : { mode: "local" };
  } catch {
    return { mode: "local" };
  }
}

function writeConfig(c: Config): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

/** Starts (or restarts) this PC's own garage server; sharing on → main computer. */
async function startLocal(): Promise<void> {
  await server?.close();
  server = await startGarageServer({ dataDir: dataDir(), networkPort: networkPort() });
  connection = { apiBase: server.address, deviceKey: null, mode: server.sharing ? "main" : "local", mainComputer: null };
}

async function applyConfig(c: Config): Promise<void> {
  if (c.mode === "client") {
    await server?.close();
    server = null;
    connection = { apiBase: `http://${c.host}:${c.port}`, deviceKey: c.deviceKey, mode: "client", mainComputer: { host: c.host, garageName: c.garageName } };
  } else {
    await startLocal();
  }
}

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
  await applyConfig(readConfig());
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

app.on("before-quit", () => void server?.close());

ipcMain.on("ffgp:info", (event) => {
  event.returnValue = { ...connection, hostname: hostname() };
});

const reloadSoon = () => setTimeout(() => mainWindow?.reload(), 100);

ipcMain.handle("ffgp:discover", () => discoverMainComputers({ timeoutMs: 1500 }));

/** Pairs this PC with a main computer, then switches the app over to it. */
ipcMain.handle("ffgp:connect", async (_event, args: { host: string; code: string; deviceName: string }) => {
  const [host, portText] = args.host.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").split(":");
  const port = Number(portText) || NETWORK_PORT;
  if (!host) return { error: "Type the main computer's address, e.g. 192.168.1.20" };
  if (connection.mode !== "client") {
    const status = await fetch(`${connection.apiBase}/api/setup/status`).then((r) => r.json() as Promise<{ configured: boolean }>).catch(() => null);
    if (status?.configured) return { error: "This PC already has its own garage set up, so it can't connect to another one." };
  }
  let res: Response;
  try {
    res = await fetch(`http://${host}:${port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: args.code, deviceName: args.deviceName }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return { error: `Couldn't reach a main computer at ${host}. Check the address, that it's switched on, and that sharing is turned on in its Settings.` };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; deviceKey?: string; garage?: { name: string } };
  if (!res.ok || !body.deviceKey) return { error: body.error ?? `The main computer refused to pair (${res.status})` };
  const config: Config = { mode: "client", host, port, deviceKey: body.deviceKey, garageName: body.garage?.name ?? "", deviceName: args.deviceName };
  writeConfig(config);
  await applyConfig(config);
  reloadSoon();
  return { ok: true };
});

/** Forgets the main computer; this PC goes back to having its own (empty) garage. */
ipcMain.handle("ffgp:disconnect", async () => {
  writeConfig({ mode: "local" });
  await applyConfig({ mode: "local" });
  reloadSoon();
});

/** Restarts the server after the owner turns sharing on or off. */
ipcMain.handle("ffgp:applyNetwork", async () => {
  if (connection.mode === "client") return;
  await startLocal();
  reloadSoon();
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
