import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { setUp, tempDir } from "./helpers";

const from = (app: Awaited<ReturnType<typeof buildApp>>, url: string, token?: string) =>
  app.inject({ method: "GET", url, remoteAddress: "10.0.0.5", headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("cloud mode", () => {
  it("accepts requests from any address without a device key", async () => {
    const app = await buildApp({ dataDir: tempDir(), cloud: true });
    try {
      expect((await from(app, "/api/setup/status")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("has no network routes", async () => {
    const app = await buildApp({ dataDir: tempDir(), cloud: true });
    try {
      const owner = await setUp(app);
      expect((await from(app, "/api/network", owner)).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("local mode still guards other addresses", async () => {
    const app = await buildApp({ dataDir: tempDir() });
    try {
      expect((await from(app, "/api/setup/status")).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
