import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "@ffgp/server";
import { runCloud } from "../src/run";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.FFGP_CLOUD_STAFF;
});

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "ffgp-run-"));
  const cloud = await runCloud({ dataDir, port: 0, host: "127.0.0.1" });
  cleanups.push(async () => {
    await cloud.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}`;
}

const login = (url: string, password: string) =>
  fetch(`${url}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "fleetfix", password }) });

describe("first staff account", () => {
  it("can be given as a password hash, so the password itself never sits in the server's settings", async () => {
    process.env.FFGP_CLOUD_STAFF = `fleetfix:Fleet Fix Admin:${hashPassword("hashed-pass-123")}`;
    const url = await start();
    expect((await login(url, "hashed-pass-123")).status).toBe(200);
    expect((await login(url, hashPassword("hashed-pass-123"))).status).toBe(401);
  });

  it("can still be given as a plain password (development and tests)", async () => {
    process.env.FFGP_CLOUD_STAFF = "fleetfix:Fleet Fix Admin:plain-pass-123";
    const url = await start();
    expect((await login(url, "plain-pass-123")).status).toBe(200);
  });
});
