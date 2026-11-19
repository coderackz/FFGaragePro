import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { abandonQueuedEmails, audit, discoverMainComputers, NETWORK_PORT, SCHEMA_VERSION, startGarageServer, type GarageServer } from "@ffgp/server";
import { CloudError, installCapture, linkDownload, linkUpload, readOnlyGuard, removeCapture, trustedLink, type CloudLink } from "@ffgp/sync";
import { backupNow, backupStatus, checkRestoreFile, pruneBackups, restoreFile, scheduleBackups, undoRestore, type BackupStatus } from "./backups";
import { CloudSync, type CloudStatus } from "./cloud";
import { PINNED_LICENCE_KEYS } from "./trusted-keys";

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
async function startLocal(saved?: CloudLink): Promise<void> {
  // Fleetfix cloud's own key, not whatever config.json says.
  const link = saved && trustedLink(saved, PINNED_LICENCE_KEYS);
  cloud?.stop();
  await server?.close();
  cloud = link ? new CloudSync(() => server?.db ?? null, link, sendCloudStatus) : null;
  const sync = cloud;
  server = await startGarageServer({
    dataDir: dataDir(),
    networkPort: networkPort(),
    app: sync ? { numbers: sync.client.numbers(), guard: readOnlyGuard(sync.client) } : undefined,
    // One sender per garage: the cloud when linked, else this PC (or main computer). Client PCs have no server.
    sendsMessages: !sync,
    // The same rule for the books: the cloud posts when linked, else this PC (or main computer).
    postsBooks: !sync,
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
  // Daily copy of this PC's garage (checked hourly; a PC working through a main computer has nothing to copy).
  scheduleBackups(() => void runBackup(false));
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
  // A Settings section with unsaved changes holds the window (beforeunload); Electron cancels silently unless
  // asked here, so ask the same question the app asks inside.
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    const options = {
      type: "question" as const,
      buttons: ["Leave without saving", "Stay"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: "Leave without saving?",
      detail: "Your changes in Settings will be lost.",
    };
    const choice = mainWindow ? dialog.showMessageBoxSync(mainWindow, options) : dialog.showMessageBoxSync(options);
    if (choice === 0) event.preventDefault();
  });
}

app.on("window-all-closed", () => app.quit());

// Only once quitting is certain (windows closed): a quit cancelled by "Stay" must leave the garage running.
app.on("will-quit", () => {
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
        link = await linkDownload({ url, garageCode, username: args.username ?? "", password: args.password ?? "", deviceName: args.deviceName, dataDir: dataDir(), pinned: PINNED_LICENCE_KEYS });
      } catch (error) {
        await startLocal();
        throw error;
      }
    } else {
      if (!configured.configured || !server) return { error: "Set up this PC's garage first, or sign in to download the cloud garage." };
      link = await linkUpload({ url, garageCode, setupCode: args.setupCode ?? "", deviceName: args.deviceName, db: server.db, pinned: PINNED_LICENCE_KEYS });
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
  // This PC becomes the sender: emails it holds as queued may still be sent by the cloud, so a person decides.
  abandonQueuedEmails(server.db, "this PC was unlinked from the cloud, which may already have sent it");
  writeConfig({ mode: "local" });
  await startLocal();
  reloadSoon();
});

// ---- Backups (this PC's garage) ----

const DAY_MS = 86_400_000;

/** This PC's own settings (backup folder, days kept): `local.` keys, which never sync. */
function localSetting<T>(key: string, fallback: T): T {
  try {
    const row = server?.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
    return row ? (JSON.parse(row.value) as T) : fallback;
  } catch {
    return fallback;
  }
}
function setLocalSetting(key: string, value: unknown): void {
  server?.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value)]);
}
// Tests run with their own profile (FFGP_USER_DATA) and must never write into the real Documents folder.
const defaultBackupFolder = () =>
  process.env.FFGP_USER_DATA ? join(app.getPath("userData"), "Fleetfix Backups") : join(app.getPath("documents"), "Fleetfix Backups");
const backupFolder = () => localSetting("local.backup.folder", defaultBackupFolder());
const keepDays = () => localSetting("local.backup.keepDays", 30);
const garageName = () => server?.db.get<{ name: string }>("SELECT name FROM garage WHERE id = 1")?.name ?? null;

/** Backs up when the newest copy is over a day old (or always, when `force`). Returns the file, or null. */
function runBackup(force: boolean): string | null {
  if (connection.mode === "client" || !server) return null;
  const name = garageName();
  if (!name) return null;
  const folder = backupFolder();
  const status = backupStatus(folder, keepDays());
  if (!force && status.last && Date.now() - Date.parse(status.last) < DAY_MS) return null;
  const file = backupNow(server.db, folder, name);
  pruneBackups(folder, keepDays());
  return file;
}

ipcMain.handle("ffgp:backupStatus", (): BackupStatus | null =>
  connection.mode === "client" || !server ? null : backupStatus(backupFolder(), keepDays()));

ipcMain.handle("ffgp:backupNow", () => {
  try {
    const file = runBackup(true);
    return file ? { ok: true, file } : { error: "There's no garage on this PC to back up." };
  } catch (error) {
    return { error: `The backup couldn't be written to ${backupFolder()}: ${(error as Error).message}` };
  }
});

ipcMain.handle("ffgp:backupChooseFolder", async () => {
  const options = { title: "Folder for backups", defaultPath: backupFolder(), properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  setLocalSetting("local.backup.folder", result.filePaths[0]);
  return backupStatus(backupFolder(), keepDays());
});

ipcMain.handle("ffgp:backupSetKeepDays", (_event, days: number) => {
  const n = Math.min(365, Math.max(1, Math.round(Number(days) || 30)));
  setLocalSetting("local.backup.keepDays", n);
  pruneBackups(backupFolder(), n);
  return backupStatus(backupFolder(), n);
});

/** Owner: replaces this PC's garage with a backup, after checking it and backing up today's data. */
ipcMain.handle("ffgp:restore", async () => {
  if (connection.mode === "client") return { error: "This PC works through a main computer. Restore on the main computer." };
  if (cloud) return { error: "This PC is linked to Fleetfix cloud. To get the garage back, disconnect and download it again." };
  const options = { title: "Choose a backup", defaultPath: backupFolder(), properties: ["openFile"] as "openFile"[], filters: [{ name: "Fleetfix backups", extensions: ["db"] }] };
  const picked = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const file = picked.filePaths[0];
  if (picked.canceled || !file) return { cancelled: true };
  let checked: { garageName: string };
  try {
    checked = checkRestoreFile(file, SCHEMA_VERSION);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const confirm = {
    type: "warning" as const,
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Restore a backup",
    message: `Replace this PC's garage with the backup of ${checked.garageName}?`,
    detail: `${basename(file)}\n\nToday's data is backed up first, so nothing is lost. The app restarts afterwards.`,
  };
  const answer = mainWindow ? await dialog.showMessageBox(mainWindow, confirm) : await dialog.showMessageBox(confirm);
  if (answer.response !== 0) return { cancelled: true };
  // Today's data is copied to the backup folder first (when the garage is open; either way the file being
  // replaced is kept as garage.db.before-restore).
  if (server) {
    try {
      runBackup(true);
    } catch (error) {
      return { error: `Today's data couldn't be backed up first, so nothing was changed: ${(error as Error).message}` };
    }
    await server.close();
    server = null;
  }
  try {
    restoreFile(file, dataDir(), SCHEMA_VERSION, () => undefined);
  } catch (error) {
    await startLocal().catch(() => undefined);
    return { error: (error as Error).message };
  }
  try {
    await startLocal();
  } catch (error) {
    // The restored garage won't open: put the previous one back so the PC keeps working.
    undoRestore(dataDir());
    await startLocal().catch(() => undefined);
    reloadSoon();
    return { error: `That backup couldn't be opened, so the garage was put back as it was: ${(error as Error).message}` };
  }
  const restored = server as GarageServer | null;
  if (restored) audit(restored.db, { action: "backup.restore", entity: "garage", after: { file: basename(file) }, userId: null });
  reloadSoon();
  return { ok: true };
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
    win.webContents.printToPDF(PDF_OPTIONS),
  );
  const parent = mainWindow ?? undefined;
  const options = { defaultPath: join(app.getPath("documents"), args.fileName), filters: [{ name: "PDF", extensions: ["pdf"] }] };
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, pdf);
  void shell.openPath(result.filePath);
  return result.filePath;
});

const PDF_OPTIONS = { pageSize: "A4", printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } } as const;

/** A page as PDF bytes (base64), to attach to an email or hand to WhatsApp. */
ipcMain.handle("ffgp:makePdf", async (_event, args: { html: string }) =>
  Buffer.from(await withPrintWindow(args.html, (win) => win.webContents.printToPDF(PDF_OPTIONS))).toString("base64"),
);

/**
 * WhatsApp click-to-send: saves the PDF to Documents/Fleetfix Garage Pro/Sent, shows it in its folder (ready to drag
 * into the chat), then opens the chat with the message typed in. Only wa.me links are opened.
 */
ipcMain.handle("ffgp:whatsapp", async (_event, args: { url: string; pdf: { fileName: string; base64: string } | null }) => {
  if (!/^https:\/\/wa\.me\/\d{8,15}\?text=/.test(args.url)) throw new Error("Not a WhatsApp link");
  if (args.pdf) {
    const dir = join(app.getPath("documents"), "Fleetfix Garage Pro", "Sent");
    await mkdir(dir, { recursive: true });
    const file = join(dir, basename(args.pdf.fileName.replace(/[\\/:*?"<>|]+/g, " ").trim() || "document.pdf"));
    await writeFile(file, Buffer.from(args.pdf.base64, "base64"));
    shell.showItemInFolder(file);
  }
  await shell.openExternal(args.url);
  return true;
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
