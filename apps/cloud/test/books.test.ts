import { describe, expect, it, vi } from "vitest";
import { dubaiDate } from "@ffgp/shared";
import { buildApp } from "@ffgp/server";
import { linkDownload, readOnlyGuard, SyncClient } from "@ffgp/sync";
import { call, tempDir } from "../../../packages/server/test/helpers";
import { api, garageReady, SETUP, startCloud } from "./helpers";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("books in the cloud", () => {
  it("linked PC never posts; cloud entries arrive by sync", async () => {
    const cloud = await startCloud();
    const { token: browser } = await garageReady(cloud, "alquoz-auto");
    expect((await api(cloud.url, "PUT", "/api/settings/books", { garage: "alquoz-auto", token: browser, body: { startDate: dubaiDate(new Date().toISOString()) } })).status).toBe(200);

    const dataDir = tempDir();
    const link = await linkDownload({ url: cloud.url, garageCode: "alquoz-auto", username: "rashid", password: SETUP.owner.password, deviceName: "PC", dataDir });
    let client!: SyncClient;
    // A linked PC: numbers from the cloud, and no postsBooks.
    const pc = await buildApp({ dataDir, numbers: { next: (k) => client.numbers().next(k), offlineSeries: link.deviceCode }, guard: readOnlyGuard(() => client) });
    try {
      client = new SyncClient(pc.db, link, {});
      const token = (await call(pc, "POST", "/api/auth/login", undefined, { username: "rashid", password: SETUP.owner.password })).body.token;
      const customer = (await call(pc, "POST", "/api/customers", token, { name: "From the PC" })).body.customer;
      const inv = (await call(pc, "POST", "/api/documents", token, { type: "invoice", customerId: customer.id, lines: [{ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 }] })).body.document;
      expect((await call(pc, "POST", `/api/documents/${inv.id}/issue`, token)).status).toBe(200);
      expect(pc.db.get("SELECT COUNT(*) AS n FROM journal_entries")).toEqual({ n: 0 });

      expect(await client.syncOnce()).toMatchObject({ ok: true });
      expect(pc.db.all("SELECT post_key FROM journal_entries")).toEqual([{ post_key: `invoice:${inv.id}` }]);
      expect(pc.db.get("SELECT COUNT(*) AS n FROM journal_lines")).toEqual({ n: 3 });
      expect(client.status()).toMatchObject({ issues: 0 });
    } finally {
      await pc.close();
    }
  });
});
