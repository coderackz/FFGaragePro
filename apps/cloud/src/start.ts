import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCloud } from "./run";

// Fleetfix Cloud in production (the bundled server.mjs). The data lives outside the app folder, which every
// deploy replaces: FFGP_CLOUD_DATA, or ~/fleetfix-cloud-data. The browser app sits next to the server, in ./web.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.FFGP_CLOUD_DATA ?? join(homedir(), "fleetfix-cloud-data");
const web = process.env.FFGP_CLOUD_WEB ?? join(here, "web");

await runCloud({ dataDir, webDir: existsSync(web) ? web : undefined, port: Number(process.env.PORT ?? 3000), backups: true });
