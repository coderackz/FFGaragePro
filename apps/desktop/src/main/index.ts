import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { discoverMainComputers, NETWORK_PORT, startGarageServer, type GarageServer } from "@ffgp/server";
import { CloudError, installCapture, linkDownload, linkUpload, readOnlyGuard, removeCapture, type CloudLink } from "@ffgp/sync";
import { CloudSync, type CloudStatus } from "./cloud";

// Tests run several "PCs" on one machine, each with its own profile folder.
if (process.env.FFGP_USER_DATA) app.setPath("userData", process.env.FFGP_USER_DATA);

/** How this PC works: its own garage (single PC or main computer), or connected to a main computer. */
type Config =
  | { mode: "local"; cloud?: CloudLink }
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
/** Set while this PC's own garage is linked to Fleetfix cloud (a PC connected to a main computer never syncs). */
let cloud: CloudSync | null = null;

const configFile = () => join(app.getPath("userData"), "config.json");
const dataDir = () => process.env.FFGP_DATA_DIR ?? join(app.getPath("userData"), "data");
const networkPort = () => Number(process.env.FFGP_NETWORK_PORT) || NETWORK_PORT;

function readConfig(): Config {
  try {
    const c = JSON.parse(readFileSync(configFile(), "utf8")) as Config;
    if (c.mode === "client" && c.host && c.deviceKey) return c;
    const link = c.mode === "local" ? c.cloud : undefined;
    return link?.url && link.deviceKey && link.publicKey ? { mode: "local", cloud: link } : { mode: "local" };
  } catch {
    return { mode: "local" };
  }
}

function writeConfig(c: Config): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

const sendCloudStatus = (s: CloudStatus) => mainWindow?.webContents.send("ffgp:cloud-status", s);

/**
 * Starts (or restarts) this PC's own garage server; sharing on → main computer. Linked to the cloud, the server
 * takes numbers from the cloud (or this PC's own series) and follows the cloud licence, and the sync loop runs.
 */
async function startLocal(link?: CloudLink): Promise<void> {
  cloud?.stop();
  await server?.close();
  cloud = link ? new CloudSync(() => server?.db ?? null, link, sendCloudStatus) : null;
  const sync = cloud;
  server = await startGarageServer({
    dataDir: dataDir(),
    networkPort: networkPort(),
    app: sync ? { numbers: sync.client.numbers(), guard: readOnlyGuard(sync.client) } : undefined,
  });
  connection = { apiBase: server.address, deviceKey: null, mode: server.sharing ? "main" : "local", mainComputer: null };
  if (sync) {
    // Re-installed at every start, so columns added by an app update are captured too.
    installCapture(server.db, "local");
    sync.start();
  }
}

async function applyConfig(c: Config): Promise<void> {
  if (c.mode === "client") {
    cloud?.stop();
    cloud = null;
    await server?.close();
    server = null;
    connection = { apiBase: `http://${c.host}:${c.port}`, deviceKey: c.deviceKey, mode: "client", mainComputer: { host: c.host, garageName: c.garageName } };
  } else {
    await startLocal(c.cloud);
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

app.on("before-quit", () => {
  cloud?.stop();
  void server?.close();
});

ipcMain.on("ffgp:info", (event) => {
  event.returnValue = { ...connection, hostname: hostname(), cloudLinked: !!cloud };
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
  await startLocal(cloud?.link);
  reloadSoon();
});

// ---- Fleetfix cloud ----

ipcMain.handle("ffgp:cloudStatus", (): CloudStatus => cloud?.status() ?? { linked: false, syncing: false });

interface CloudLinkArgs {
  mode: "download" | "upload";
  url: string;
  garageCode: string;
  deviceName: string;
  username?: string;
  password?: string;
  setupCode?: string;
}

const cloudMessage = (error: unknown) =>
  error instanceof CloudError && error.reason === "offline"
    ? "Can't reach Fleetfix cloud at that address. Check the internet connection and the address."
    : (error as Error).message;

/**
 * Links this PC to its Fleetfix cloud garage. download: a new PC takes the cloud garage (the server is stopped
 * while the file is replaced). upload: this PC's garage goes into a new, empty cloud garage.
 */
ipcMain.handle("ffgp:cloudLink", async (_event, args: CloudLinkArgs) => {
  if (connection.mode === "client") return { error: "This PC works through a main computer. Link the main computer to the cloud instead." };
  if (cloud) return { error: "This PC is already linked to Fleetfix cloud." };
  const url = args.url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(url)) return { error: "Type the cloud address, e.g. https://garagepro.fleetfix.ae" };
  const garageCode = args.garageCode.trim().toLowerCase();
  // Asked of the database itself: a failed check must never look like "no garage here".
  if (!server) return { error: "The garage isn't open. Restart Fleetfix Garage Pro and try again." };
  const configured = { configured: !!server.db.get("SELECT 1 FROM garage WHERE id = 1") };
  try {
    let link: CloudLink;
    if (args.mode === "download") {
      if (configured.configured) return { error: "This PC already has a garage. Use Settings → Fleetfix cloud to upload it instead." };
      await server?.close();
      server = null;
      try {
        link = await linkDownload({ url, garageCode, username: args.username ?? "", password: args.password ?? "", deviceName: args.deviceName, dataDir: dataDir() });
      } catch (error) {
        await startLocal();
        throw error;
      }
    } else {
      if (!configured.configured || !server) return { error: "Set up this PC's garage first, or sign in to download the cloud garage." };
      link = await linkUpload({ url, garageCode, setupCode: args.setupCode ?? "", deviceName: args.deviceName, db: server.db });
    }
    writeConfig({ mode: "local", cloud: link });
    await startLocal(link);
    reloadSoon();
    return { ok: true };
  } catch (error) {
    return { error: cloudMessage(error) };
  }
});

ipcMain.handle("ffgp:cloudSyncNow", async () => {
  if (!cloud) return { ok: false, reason: "not_linked", message: "This PC isn't linked to Fleetfix cloud." };
  return cloud.syncNow();
});

/** Stops syncing. The garage's data stays on this PC, which carries on as a standalone garage. */
ipcMain.handle("ffgp:cloudUnlink", async () => {
  if (!cloud || !server) return;
  cloud.stop();
  removeCapture(server.db);
  writeConfig({ mode: "local" });
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
