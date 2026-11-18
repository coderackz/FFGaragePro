import { existsSync } from "node:fs";
import { createCloudServer } from "./server";

// Fleetfix Cloud on this machine for development: `npm run dev -w @ffgp/cloud`.
const dataDir = process.env.FFGP_CLOUD_DATA ?? new URL("../.cloud-data", import.meta.url).pathname;
const defaultWeb = new URL("../../desktop/dist-web", import.meta.url).pathname;
const webDir = process.env.FFGP_CLOUD_WEB ?? (existsSync(defaultWeb) ? defaultWeb : undefined);
const port = Number(process.env.PORT ?? 4790);

const cloud = await createCloudServer({ dataDir, webDir });
cloud.server.listen(port, () => {
  console.log(`Fleetfix Cloud on http://localhost:${port}  (data: ${dataDir}${webDir ? `, web: ${webDir}` : ", no web build"})`);
});
