export { buildApp, type AppOptions } from "./app";
export { DISCOVERY_PORT, discoverMainComputers, type FoundComputer } from "./discovery";
export { DEVICE_HEADER, NETWORK_PORT } from "./network";

import { buildApp } from "./app";
import { DISCOVERY_PORT, startDiscoveryResponder } from "./discovery";
import { isSharing, NETWORK_PORT, type NetworkStatus } from "./network";
import { garage } from "./routes/setup";

/** Starts a server on a given host/port (development and tests). */
export async function startServer(options: { dataDir: string; host?: string; port?: number; logger?: boolean }) {
  const app = await buildApp({ dataDir: options.dataDir, logger: options.logger });
  const address = await app.listen({ host: options.host ?? "127.0.0.1", port: options.port ?? 0 });
  return { app, address };
}

export interface GarageServer {
  /** URL this PC's own window uses (always loopback). */
  address: string;
  /** Whether the owner turned on sharing with other PCs. */
  sharing: boolean;
  status: NetworkStatus;
  close(): Promise<void>;
}

/**
 * The app's server. Single PC: a random loopback port. Main computer (sharing on): every network on
 * `networkPort`, plus the discovery responder. If the sharing port is taken, it still opens for this PC
 * alone and reports why other PCs can't connect.
 */
export async function startGarageServer(o: { dataDir: string; networkPort?: number; discoveryPort?: number; logger?: boolean }): Promise<GarageServer> {
  const networkPort = o.networkPort ?? NETWORK_PORT;
  const status: NetworkStatus = { listening: false, error: null };
  const build = () => buildApp({ dataDir: o.dataDir, logger: o.logger, networkPort, networkStatus: status });

  let app = await build();
  const sharing = isSharing(app.db);
  if (sharing) {
    try {
      await app.listen({ host: "0.0.0.0", port: networkPort });
      status.listening = true;
      const responder = await startDiscoveryResponder({ port: o.discoveryPort ?? DISCOVERY_PORT, httpPort: networkPort, name: () => garage(app.db)?.name ?? null }).catch(
        (error: Error) => {
          status.error = `Other PCs can't search for this computer (${error.message}). They can still connect by typing its address.`;
          return null;
        },
      );
      return {
        address: `http://127.0.0.1:${networkPort}`,
        sharing,
        status,
        close: async () => {
          await responder?.close();
          await app.close();
        },
      };
    } catch (error) {
      await app.close();
      const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      status.error = inUse
        ? `Port ${networkPort} is in use by another program, so other PCs can't connect. Close that program or restart this computer.`
        : `Other PCs can't connect: ${(error as Error).message}`;
      app = await build();
    }
  }
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { address, sharing, status, close: () => app.close() };
}
