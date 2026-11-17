import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { buildApp } from "../src/app";

const dirs: string[] = [];
const apps: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffgp-test-"));
  dirs.push(dir);
  return dir;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function makeApp(dataDir = tempDir()) {
  const app = await buildApp({ dataDir });
  apps.push(app);
  return app;
}

export async function call(app: App, method: string, url: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as object | undefined,
  });
  return { status: res.statusCode, body: res.json() as any };
}

export const SETUP = {
  garage: { name: "Al Quoz Auto Care", trn: "100123456700003", address: "Al Quoz 3, Dubai", phone: "+971 4 000 0000" },
  owner: { name: "Owner One", username: "owner", password: "owner-pass-1" },
};

/** Sets the garage up and returns the owner's token. */
export async function setUp(app: App): Promise<string> {
  const res = await call(app, "POST", "/api/setup", undefined, SETUP);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.token;
}

export async function addUser(app: App, ownerToken: string, role: "owner" | "accountant" | "advisor", username = role) {
  await call(app, "POST", "/api/users", ownerToken, { name: `${role} user`, username, role, password: `${role}-pass-1` });
  const login = await call(app, "POST", "/api/auth/login", undefined, { username, password: `${role}-pass-1` });
  return login.body.token as string;
}
