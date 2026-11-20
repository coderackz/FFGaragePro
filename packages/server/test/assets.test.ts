import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postPending } from "../src/books/pending";
import { addUser, call, makeApp, setUp, type App } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const TOOLS = "00000000-0000-4000-8000-0000000a1500";
const VEHICLES = "00000000-0000-4000-8000-0000000a1510";
afterEach(() => vi.useRealTimers());
const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
const entries = (app: App, like: string) => app.db.all<{ post_key: string; date: string }>("SELECT post_key, date FROM journal_entries WHERE post_key LIKE ? ORDER BY date, post_key", [like]);
const byKey = (app: App, key: string) =>
  Object.fromEntries(app.db.all<{ code: string; d: number }>(
    `SELECT a.code, SUM(l.debit_fils - l.credit_fils) AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.post_key = ? GROUP BY a.code`, [key]).map((r) => [r.code, r.d]));
const LIFT = { name: "Hydraulic lift", category: "equipment", accountId: TOOLS, costFils: 1200000, inUseFrom: "2026-07-10", lifeMonths: 36 };

async function garage(clock = "2026-11-20T08:00:00Z") {
  at(clock);
  const app = await makeApp(undefined, { postsBooks: true });
  let owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: "2026-07-01" });
  const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Al Futtaim" })).body.supplier;
  // The lift's cost reaches the books through its bill (the register never posts the purchase).
  await call(app, "POST", "/api/bills", owner, { supplierId: supplier.id, supplierInvoiceNo: "LIFT-1", billDate: "2026-07-10", lines: [{ accountId: TOOLS, description: "Lift", netFils: 1200000, vat: "none" }] });
  const add = async (asset: Record<string, unknown>) => (await call(app, "POST", "/api/assets", owner, asset)).body.asset;
  const later = async (iso: string) => {
    at(iso);
    owner = (await call(app, "POST", "/api/auth/login", undefined, { username: "owner", password: "owner-pass-1" })).body.token;
  };
  return { app, get owner() { return owner; }, add, later };
}

describe("fixed assets", () => {
  it("monthly depreciation posts per month", async () => {
    const g = await garage("2026-07-15T08:00:00Z");
    expect((await call(g.app, "POST", "/api/assets", g.owner, LIFT)).status).toBe(200);
    await g.later("2026-11-20T08:00:00Z");
    postPending(g.app.db);
    postPending(g.app.db);
    const list = entries(g.app, "depreciation:%");
    expect(list.map((e) => e.date)).toEqual(["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31"]);
    expect(byKey(g.app, list[0]!.post_key)).toEqual({ "6070": 33333, "1590": -33333 });
  });

  it("late asset catches up", async () => {
    const g = await garage();
    await g.add({ ...LIFT, name: "Socket set", costFils: 360000, lifeMonths: 12, inUseFrom: "2026-07-01" });
    postPending(g.app.db);
    expect(entries(g.app, "depreciation:%")).toHaveLength(4);
    await g.add(LIFT);
    postPending(g.app.db);
    const late = entries(g.app, "depreciation:2026-10:2");
    expect(late).toHaveLength(1);
    expect(byKey(g.app, "depreciation:2026-10:2")).toEqual({ "6070": 133332, "1590": -133332 });
  });

  it("pre-start asset continues", async () => {
    const g = await garage();
    await g.add({ name: "Recovery van", category: "vehicle", accountId: VEHICLES, costFils: 6000000, inUseFrom: "2025-07-01", lifeMonths: 60, openingDepreciationFils: 1200000 });
    postPending(g.app.db);
    expect(byKey(g.app, "depreciation:2026-07:1")).toEqual({ "6070": 100000, "1590": -100000 });
  });

  it("disposal posts gain or loss", async () => {
    const g = await garage();
    const lift = await g.add(LIFT);
    postPending(g.app.db);
    const r = await call(g.app, "POST", `/api/assets/${lift.id}/dispose`, g.owner, { date: "2026-10-15", proceedsFils: 1150000, proceedsAccountId: A.bank.id });
    expect(r.status).toBe(200);
    postPending(g.app.db);
    expect(byKey(g.app, `asset_disposal:${lift.id}`)).toEqual({ "1590": 133332, "1020": 1150000, "1500": -1200000, "4030": -83332 });
    await g.later("2027-01-05T08:00:00Z");
    postPending(g.app.db);
    expect(g.app.db.get("SELECT COUNT(*) AS n FROM journal_lines WHERE asset_id = ? AND account_id = ?", [lift.id, A.depreciation.id])).toEqual({ n: 4 });
    expect((await call(g.app, "POST", `/api/assets/${lift.id}/dispose`, g.owner, { date: "2026-10-16", proceedsFils: 0 })).status).toBe(409);

    const h = await garage();
    const tool = await h.add(LIFT);
    postPending(h.app.db);
    await call(h.app, "POST", `/api/assets/${tool.id}/dispose`, h.owner, { date: "2026-10-15", proceedsFils: 0, note: "Broken" });
    postPending(h.app.db);
    expect(byKey(h.app, `asset_disposal:${tool.id}`)).toEqual({ "1590": 133332, "1500": -1200000, "6080": 1066668 });
  });

  it("change in estimate", async () => {
    const g = await garage();
    const lift = await g.add(LIFT);
    postPending(g.app.db);
    await call(g.app, "PATCH", `/api/assets/${lift.id}`, g.owner, { lifeMonths: 24 });
    postPending(g.app.db);
    expect(byKey(g.app, "depreciation:2026-10:2")).toEqual({ "6070": 4 * 50000 - 133332, "1590": -(4 * 50000 - 133332) });
    await call(g.app, "PATCH", `/api/assets/${lift.id}`, g.owner, { lifeMonths: 48 });
    postPending(g.app.db);
    expect(byKey(g.app, "depreciation:2026-10:3")).toEqual({ "6070": 4 * 25000 - 200000, "1590": 200000 - 4 * 25000 });
    expect((await call(g.app, "GET", `/api/assets/${lift.id}`, g.owner)).body.asset.postedFils).toBe(100000);
  });

  it("fixed asset health", async () => {
    const g = await garage();
    await g.add(LIFT);
    postPending(g.app.db);
    const check = async () => (await call(g.app, "GET", "/api/books/health", g.owner)).body.checks.find((c: { key: string }) => c.key === "fixed_assets");
    expect(await check()).toMatchObject({ ok: true });
    await g.add({ ...LIFT, name: "Not in the books", costFils: 50000 });
    expect(await check()).toMatchObject({ ok: false });
  });

  it("permissions", async () => {
    const g = await garage();
    const advisor = await addUser(g.app, g.owner, "advisor");
    expect((await call(g.app, "GET", "/api/assets", advisor)).status).toBe(403);
    expect((await call(g.app, "POST", "/api/assets", advisor, LIFT)).status).toBe(403);
    const accountant = await addUser(g.app, g.owner, "accountant");
    expect((await call(g.app, "POST", "/api/assets", accountant, LIFT)).status).toBe(200);
    expect((await call(g.app, "POST", "/api/assets", g.owner, { ...LIFT, accountId: A.bank.id })).status).toBe(400);
  });
});
