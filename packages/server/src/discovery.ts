import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { isLoopback } from "./network";

/** UDP port the main computer listens on for "who is the main computer?" broadcasts. */
export const DISCOVERY_PORT = 47821;
const ASK = "FFGP-DISCOVER-1";

export interface FoundComputer {
  host: string;
  port: number;
  name: string;
}

/** Main computer: answers discovery broadcasts with the garage name and the sharing port. */
export function startDiscoveryResponder(o: { port?: number; httpPort: number; name: () => string | null }): Promise<{ close(): Promise<void> }> {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (msg, from) => {
    const name = msg.toString() === ASK ? o.name() : null;
    if (name) socket.send(JSON.stringify({ app: "ffgp", v: 1, name, port: o.httpPort }), from.port, from.address);
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(o.port ?? DISCOVERY_PORT, "0.0.0.0", () => {
      socket.off("error", reject);
      socket.on("error", () => undefined); // a bad packet must never take the app down
      resolve({ close: () => new Promise<void>((r) => socket.close(() => r())) });
    });
  });
}

/** Broadcast address of every IPv4 network this PC is on, e.g. 192.168.1.255. */
function broadcastAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => {
      const a = i!.address.split(".").map(Number);
      const m = i!.netmask.split(".").map(Number);
      return a.map((x, k) => (x | (~m[k]! & 255)) >>> 0).join(".");
    });
}

/** Other PCs: asks the network for main computers and collects the answers for `timeoutMs`. */
export function discoverMainComputers(o: { port?: number; timeoutMs?: number } = {}): Promise<FoundComputer[]> {
  const port = o.port ?? DISCOVERY_PORT;
  const found = new Map<string, FoundComputer>();
  const socket = dgram.createSocket("udp4");
  return new Promise((resolve) => {
    socket.on("error", () => undefined);
    socket.on("message", (msg, from) => {
      try {
        const reply = JSON.parse(msg.toString()) as { app?: string; name?: string; port?: number };
        if (reply.app !== "ffgp" || typeof reply.name !== "string" || typeof reply.port !== "number") return;
        const key = `${reply.name}|${reply.port}`;
        const existing = found.get(key);
        // The same computer may answer on several addresses; prefer a real network address over loopback.
        if (!existing || (isLoopback(existing.host) && !isLoopback(from.address))) {
          found.set(key, { host: from.address, port: reply.port, name: reply.name });
        }
      } catch {
        /* not ours */
      }
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const target of new Set(["255.255.255.255", ...broadcastAddresses(), "127.0.0.1"])) {
        socket.send(ASK, port, target, () => undefined);
      }
      setTimeout(() => socket.close(() => resolve([...found.values()])), o.timeoutMs ?? 1500);
    });
  });
}
