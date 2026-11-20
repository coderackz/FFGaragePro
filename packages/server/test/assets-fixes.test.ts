import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { call, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const TOOLS = "00000000-0000-4000-8000-0000000a1500";
const VEHICLES = "00000000-0000-4000-8000-0000000a1510";
afterEach(() => vi.useRealTimers());
const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
const LIFT = { name: "Lift", category: "equipment", accountId: TOOLS, costFils: 1200000, lifeMonths: 36 };
const lines = (app: App) => app.db.all<{ key: string; date: string; asset: string; d: number }>(
  `SELECT e.post_key AS key, e.date, l.asset_id AS asset, l.debit_fils - l.credit_fils AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
   WHERE e.source_type = 'depreciation' AND l.account_id = ? ORDER BY e.date, e.post_key`, [A.depreciation.id]);
const net1590 = (app: App, assetId: string) => -(app.db.get<{ b: number | null }>("SELECT SUM(debit_fils - credit_fils) AS b FROM journal_lines WHERE asset_id = ? AND account_id = ?", [assetId, A.accumulated_depreciation.id])!.b ?? 0);

async function garage(start = "2026-07-01", clock = "2026-11-20T08:00:00Z") {
  at(clock);
  const app = await makeApp(undefined, { postsBooks: true });
  let owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: start });
  const add = async (a: Record<string, unknown>) => (await call(app, "POST", "/api/assets", owner, a)).body.asset;
  // A real write (a new customer), so the books' catch-up step runs again.
  let n = 0;
  const touch = () => call(app, "POST", "/api/customers", owner, { name: `Walk-in ${++n}` }).then((r) => { expect(r.status).toBe(200); postPending(app.db); });
  const later = async (iso: string) => {
    at(iso);
    owner = (await call(app, "POST", "/api/auth/login", undefined, { username: "owner", password: "owner-pass-1" })).body.token;
  };
  return { app, get owner() { return owner; }, add, touch, later };
}

describe("fixed asset review fixes", () => {
  it("C1: months before the first charge are never revisited with reversals", async () => {
    const g = await garage();
    await g.add({ ...LIFT, name: "Old compressor", costFils: 100000, lifeMonths: 12, inUseFrom: "2020-01-01", openingDepreciationFils: 100000 });
    await g.add({ ...LIFT, inUseFrom: "2026-10-10" });
    for (let i = 0; i < 4; i++) { postPending(g.app.db); await g.touch(); }
    expect(lines(g.app).map((l) => [l.date, l.d])).toEqual([["2026-10-31", 33333]]);
  });

  it("C1: a late asset dated before the others is caught up in the latest month, nothing else moves", async () => {
    const g = await garage();
    const lift = await g.add({ ...LIFT, inUseFrom: "2026-09-05" });
    postPending(g.app.db);
    const jack = await g.add({ ...LIFT, name: "Jack", costFils: 360000, lifeMonths: 36, inUseFrom: "2026-07-01" });
    postPending(g.app.db);
    await g.touch();
    const all = lines(g.app);
    expect(all.every((l) => l.d > 0)).toBe(true);
    expect(all.filter((l) => l.asset === jack.id).map((l) => [l.key, l.d])).toEqual([["depreciation:2026-10:2", 40000]]);
    expect(net1590(g.app, lift.id)).toBe(66666);
  });

  it("I1: depreciation before the books is never reversed; opening only for assets from before the books", async () => {
    const g = await garage();
    const van = await g.add({ name: "Van", category: "vehicle", accountId: VEHICLES, costFils: 6000000, inUseFrom: "2025-07-01", lifeMonths: 60, openingDepreciationFils: 1200000 });
    postPending(g.app.db);
    await call(g.app, "PATCH", `/api/assets/${van.id}`, g.owner, { lifeMonths: 120 });
    postPending(g.app.db);
    expect(net1590(g.app, van.id)).toBeGreaterThanOrEqual(0);
    const bad = await call(g.app, "POST", "/api/assets", g.owner, { ...LIFT, inUseFrom: "2026-08-01", openingDepreciationFils: 1000 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/before the books/);
  });

  it("I2: a disposal before the books start is left out of the books", async () => {
    const g = await garage("2027-01-01");
    const lift = await g.add({ ...LIFT, inUseFrom: "2026-01-10" });
    expect((await call(g.app, "POST", `/api/assets/${lift.id}/dispose`, g.owner, { date: "2026-10-15", proceedsFils: 500000, proceedsAccountId: A.bank.id })).status).toBe(200);
    await g.later("2027-02-05T08:00:00Z");
    await g.touch();
    expect(g.app.db.get("SELECT COUNT(*) AS n FROM journal_lines WHERE asset_id = ?", [lift.id])).toEqual({ n: 0 });
  });

  it("I3: a month's depreciation posts once the month ends, without any other change", async () => {
    const g = await garage();
    await g.add({ ...LIFT, inUseFrom: "2026-07-10" });
    postPending(g.app.db);
    at("2026-12-02T08:00:00Z");
    postPending(g.app.db);
    expect(lines(g.app).map((l) => l.date)).toContain("2026-11-30");
  });

  it("promoted: Accumulated depreciation follows the register (no manual journals to it)", async () => {
    const g = await garage();
    const d = (await call(g.app, "POST", "/api/books/drafts", g.owner, { date: "2026-10-31", narration: "Depreciation", lines: [
      { accountId: A.depreciation.id, debitFils: 1000 }, { accountId: A.accumulated_depreciation.id, creditFils: 1000 },
    ] })).body.draft;
    const r = await call(g.app, "POST", `/api/books/drafts/${d.id}/post`, g.owner);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/fixed asset register/);
  });
});
