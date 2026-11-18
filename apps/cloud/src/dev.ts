import { existsSync } from "node:fs";
import { runCloud } from "./run";

// Fleetfix Cloud on this machine for development: `npm run dev -w @ffgp/cloud`.
const dataDir = process.env.FFGP_CLOUD_DATA ?? new URL("../.cloud-data", import.meta.url).pathname;
const defaultWeb = new URL("../../desktop/dist-web", import.meta.url).pathname;
const webDir = process.env.FFGP_CLOUD_WEB ?? (existsSync(defaultWeb) ? defaultWeb : undefined);

await runCloud({ dataDir, webDir, port: Number(process.env.PORT ?? 4790) });
