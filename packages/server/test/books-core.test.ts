import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHART, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { postEntry } from "../src/books/post";
import { Db } from "../src/db";
import { addUser, call, makeApp, setUp, tempDir } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const line = (accountId: string, debitFils: number, creditFils: number) => ({ accountId, debitFils, creditFils });

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  return { app, owner };
}

describe("books core", () => {
  it("chart seeded; advisors can't see it", async () => {
    const { app, owner } = await garage();
    const res = await call(app, "GET", "/api/books/accounts", owner);
    expect(res.body.accounts).toHaveLength(DEFAULT_CHART.length);
    expect(res.body.accounts.find((a: { code: string }) => a.code === "1100")).toMatchObject({ id: A.receivables.id, systemKey: "receivables", active: true });
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "GET", "/api/books/accounts", advisor)).status).toBe(403);
  });

  it("system accounts can be renamed, not retyped or removed; new accounts can be added", async () => {
    const { app, owner } = await garage();
    expect((await call(app, "PATCH", `/api/books/accounts/${A.bank.id}`, owner, { name: "Emirates NBD current" })).body.account.name).toBe("Emirates NBD current");
    expect((await call(app, "PATCH", `/api/books/accounts/${A.bank.id}`, owner, { type: "expense" })).status).toBe(400);
    expect((await call(app, "PATCH", `/api/books/accounts/${A.bank.id}`, owner, { active: false })).status).toBe(400);
    const added = await call(app, "POST", "/api/books/accounts", owner, { code: "6070", name: "Advertising", type: "expense" });
    expect(added.body.account).toMatchObject({ code: "6070", systemKey: null, active: true });
    expect((await call(app, "POST", "/api/books/accounts", owner, { code: "6070", name: "Again", type: "expense" })).status).toBe(409);
    expect((await call(app, "PATCH", `/api/books/accounts/${added.body.account.id}`, owner, { active: false })).body.account.active).toBe(false);
  });

  it("postEntry balances or refuses, numbers, and is idempotent by key", async () => {
    const { app } = await garage();
    expect(() => postEntry(app.db, { date: "2026-11-20", narration: "x", sourceType: "manual", lines: [line(A.cash.id, 100, 0), line(A.bank.id, 0, 90)], userId: null }))
      .toThrow(/Debits and credits must be equal/);
    expect(app.db.get("SELECT COUNT(*) AS n FROM journal_entries")).toEqual({ n: 0 });
    const id = postEntry(app.db, { date: "2026-11-20", narration: "Float", sourceType: "manual", postKey: "k1", lines: [line(A.cash.id, 100, 0), line(A.bank.id, 0, 100), line(A.wip.id, 0, 0)], userId: null });
    expect(id).toBeTruthy();
    expect(app.db.get("SELECT number, date FROM journal_entries WHERE id = ?", [id])).toEqual({ number: "JV-00001", date: "2026-11-20" });
    expect(app.db.get("SELECT COUNT(*) AS n FROM journal_lines WHERE entry_id = ?", [id])).toEqual({ n: 2 });
    expect(postEntry(app.db, { date: "2026-11-20", narration: "Float", sourceType: "manual", postKey: "k1", lines: [line(A.cash.id, 100, 0), line(A.bank.id, 0, 100)], userId: null })).toBeNull();
    expect(app.db.get("SELECT COUNT(*) AS n FROM journal_entries")).toEqual({ n: 1 });
  });

  it("postEntry moves locked dates to the first open day", async () => {
    const { app, owner } = await garage();
    expect((await call(app, "PUT", "/api/settings/books", owner, { lockDate: "2026-10-31" })).status).toBe(200);
    const id = postEntry(app.db, { date: "2026-10-15", narration: "Late receipt", sourceType: "manual", lines: [line(A.cash.id, 100, 0), line(A.bank.id, 0, 100)], userId: null });
    expect(app.db.get("SELECT date, original_date, narration FROM journal_entries WHERE id = ?", [id])).toEqual({
      date: "2026-11-01", original_date: "2026-10-15", narration: "Late receipt (dated 15 Oct 2026; books locked)",
    });
  });

  it("migration 11 on an old database", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 10 });
    old.close();
    const db = new Db(file);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n).toBe(DEFAULT_CHART.length);
    for (const t of ["journal_entries", "journal_lines", "journal_drafts"]) expect(db.get("SELECT name FROM sqlite_master WHERE name = ?", [t])).toBeTruthy();
    db.close();
  });
});
