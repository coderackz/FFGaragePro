import { startServer } from "./index";

// Stand-alone server for running the screens in a browser: `npm run dev:server -w @ffgp/server`.
const dataDir = process.env.FFGP_DATA ?? new URL("../.dev-data", import.meta.url).pathname;
// FFGP_OUTBOX_FAST=1 (end-to-end tests only): rounds every half second and retries after 1 s instead of 1/5/30 min.
const fast = process.env.FFGP_OUTBOX_FAST === "1";
const { address } = await startServer({
  dataDir, port: Number(process.env.PORT ?? 4780),
  sendsMessages: { place: "dev server", ...(fast ? { everyMs: 500, retryMinutes: [1 / 60, 1 / 60, 1 / 60] } : {}) },
});
console.log(`Fleetfix Garage Pro dev server on ${address} (data: ${dataDir})`);
