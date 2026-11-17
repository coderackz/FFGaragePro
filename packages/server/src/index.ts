export { buildApp, type AppOptions } from "./app";

import { buildApp } from "./app";

/** Starts the garage server. Single PC: host 127.0.0.1. Main-computer mode: 0.0.0.0. */
export async function startServer(options: { dataDir: string; host?: string; port?: number; logger?: boolean }) {
  const app = await buildApp({ dataDir: options.dataDir, logger: options.logger });
  const address = await app.listen({ host: options.host ?? "127.0.0.1", port: options.port ?? 0 });
  return { app, address };
}
