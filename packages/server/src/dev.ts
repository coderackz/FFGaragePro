import { startServer } from "./index";

// Stand-alone server for running the screens in a browser: `npm run dev:server -w @ffgp/server`.
const dataDir = process.env.FFGP_DATA ?? new URL("../.dev-data", import.meta.url).pathname;
const { address } = await startServer({ dataDir, port: Number(process.env.PORT ?? 4780) });
console.log(`Fleetfix Garage Pro dev server on ${address} (data: ${dataDir})`);
