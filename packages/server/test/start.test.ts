import dgram from "node:dgram";
import { connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMainComputers, startGarageServer } from "../src/index";
import { SETUP, tempDir } from "./helpers";

const running: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

const freeTcpPort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
const freeUdpPort = () =>
  new Promise<number>((resolve) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

async function start(dataDir: string, networkPort: number, discoveryPort: number) {
  const server = await startGarageServer({ dataDir, networkPort, discoveryPort });
  running.push(server);
  return server;
}

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json()) as any };
}

/** Sets up a garage on a fresh server and turns sharing on; returns the owner's token. */
async function setUpSharing(dataDir: string, networkPort: number, discoveryPort: number): Promise<string> {
  const first = await start(dataDir, networkPort, discoveryPort);
  const headers = { "content-type": "application/json" };
  const { token } = (await json(`${first.address}/api/setup`, { method: "POST", headers, body: JSON.stringify(SETUP) })).body;
  await json(`${first.address}/api/network/sharing`, { method: "PUT", headers: { ...headers, authorization: `Bearer ${token}` }, body: JSON.stringify({ enabled: true }) });
  await first.close();
  running.splice(running.indexOf(first), 1);
  return token;
}

describe("starting the garage server", () => {
  it("single PC: listens on loopback only", async () => {
    const server = await start(tempDir(), await freeTcpPort(), await freeUdpPort());
    expect(server.sharing).toBe(false);
    expect(server.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await json(`${server.address}/api/health`)).body.ok).toBe(true);
  });

  it("main computer: shares on the fixed port and answers discovery with the garage name", async () => {
    const dataDir = tempDir();
    const [port, udp] = [await freeTcpPort(), await freeUdpPort()];
    const token = await setUpSharing(dataDir, port, udp);
    const server = await start(dataDir, port, udp);
    expect(server.sharing).toBe(true);
    expect(server.address).toBe(`http://127.0.0.1:${port}`);
    const net = (await json(`${server.address}/api/network`, { headers: { authorization: `Bearer ${token}` } })).body;
    expect(net).toMatchObject({ sharing: true, listening: true, error: null, port });

    const found = await discoverMainComputers({ port: udp, timeoutMs: 800 });
    expect(found).toContainEqual(expect.objectContaining({ name: "Al Quoz Auto Care", port }));
  });

  it("port already taken: still opens on this PC and says why others can't connect", async () => {
    const dataDir = tempDir();
    const [port, udp] = [await freeTcpPort(), await freeUdpPort()];
    const token = await setUpSharing(dataDir, port, udp);
    const blocker: Server = await new Promise((resolve) => {
      const s = createServer().listen(port, "0.0.0.0", () => resolve(s));
    });
    try {
      const server = await start(dataDir, port, udp);
      expect(server.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(server.address).not.toBe(`http://127.0.0.1:${port}`);
      const net = (await json(`${server.address}/api/network`, { headers: { authorization: `Bearer ${token}` } })).body;
      expect(net.listening).toBe(false);
      expect(net.error).toMatch(new RegExp(`${port}.*in use`));
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("discovery finds nothing when no main computer is sharing", async () => {
    expect(await discoverMainComputers({ port: await freeUdpPort(), timeoutMs: 300 })).toEqual([]);
  });
});

describe("restarting the server", () => {
  it("stops promptly even when a connection was opened but no request sent yet", async () => {
    // Chromium opens spare connections ahead of time; one must not hold up a restart (seen when linking to the cloud).
    const server = await startGarageServer({ dataDir: tempDir(), networkPort: await freeTcpPort(), discoveryPort: await freeUdpPort() });
    const { port } = new URL(server.address);
    const socket = connect(Number(port), "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const started = Date.now();
    await Promise.race([server.close(), new Promise((_, reject) => setTimeout(() => reject(new Error("close() still waiting after 3 s")), 3000))]);
    expect(Date.now() - started).toBeLessThan(3000);
    socket.destroy();
  });
});

