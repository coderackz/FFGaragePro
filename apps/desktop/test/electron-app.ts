import { _electron as electron, type ElectronApplication } from "@playwright/test";

/**
 * Launches the desktop app. By default the built app (`npm run build -w @ffgp/desktop` first); with FFGP_EXE
 * set, the installed "Fleetfix Garage Pro.exe" — what a garage actually runs.
 */
export function launchApp(env: Record<string, string>): Promise<ElectronApplication> {
  const exe = process.env.FFGP_EXE;
  const all = { ...process.env, ...env } as Record<string, string>;
  delete all.ELECTRON_RUN_AS_NODE;
  return exe ? electron.launch({ executablePath: exe, env: all }) : electron.launch({ args: ["apps/desktop"], env: all });
}

export const screenPrefix = process.env.FFGP_EXE ? "win-" : "electron-";
