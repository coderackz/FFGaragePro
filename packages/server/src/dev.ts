import { startServer } from "./index";

// Stand-alone server for running the screens in a browser: `npm run dev:server -w @ffgp/server`.
const dataDir = process.env.FFGP_DATA ?? new URL("../.dev-data", import.meta.url).pathname;
// FFGP_OUTBOX_FAST=1 (end-to-end tests only): rounds every half second and retries after 1 s instead of 1/5/30 min.
const fast = process.env.FFGP_OUTBOX_FAST === "1";
// FFGP_FAKE_PROVIDERS=1 (end-to-end tests only): integrations on, against stand-in WhatsApp, Zoho and QuickBooks APIs.
const port = Number(process.env.PORT ?? 4780);
const fakes = process.env.FFGP_FAKE_PROVIDERS === "1" ? await (await import("./integrations/fakes")).startFakeProviders(4799) : null;
const { address } = await startServer({
  dataDir, port,
  ...(fakes ? { integrations: { publicUrl: `http://127.0.0.1:${port}`, appUrl: process.env.FFGP_APP_URL ?? "http://localhost:5180", endpoints: fakes.endpoints, ownLoopMs: fast ? 500 : 5000 } } : {}),
  sendsMessages: { place: "dev server", ...(fast ? { everyMs: 500, retryMinutes: [1 / 60, 1 / 60, 1 / 60] } : {}) },
  postsBooks: true,
});
console.log(`Fleetfix Garage Pro dev server on ${address} (data: ${dataDir})`);
