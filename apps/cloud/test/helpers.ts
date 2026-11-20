import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createCloudServer, type CloudOptions } from "../src/server";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A clock tests can move: `clock.advance(days)`. */
export function makeClock(start = Date.parse("2026-11-18T08:00:00Z")) {
  let t = start;
  return { now: () => t, advanceDays: (d: number) => { t += d * 86_400_000; } };
}

export async function startCloud(o: { maxOpen?: number; now?: () => number; webDir?: string; mailerFor?: CloudOptions["mailerFor"]; integrations?: CloudOptions["integrations"] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "ffgp-cloud-test-"));
  const cloud = await createCloudServer({ dataDir, ...o });
  await new Promise<void>((r) => cloud.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    await cloud.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { url, admin: cloud.admin, dataDir, outbox: cloud.outbox, integrations: cloud.integrations };
}

export async function api(
  url: string, method: string, path: string,
  o: { garage?: string; token?: string; setupCode?: string | null; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (o.garage !== undefined) headers["x-ffgp-garage"] = o.garage;
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.setupCode) headers["x-ffgp-setup-code"] = o.setupCode;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export const SETUP = {
  garage: { name: "Al Quoz Auto Care", trn: "100123456700003" },
  owner: { name: "Rashid Khan", username: "rashid", password: "garage-pass-1" },
};

/** Creates a garage in admin.db and sets it up through the browser API; returns the owner's token. */
export async function garageReady(cloud: { url: string; admin: { createGarage: Function } }, code: string, now = Date.now) {
  const g = cloud.admin.createGarage({ code, name: code, notes: null, now: now() });
  const res = await api(cloud.url, "POST", "/api/setup", { garage: code, setupCode: g.setup_code, body: SETUP });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return { garage: g, token: res.body.token as string };
}
