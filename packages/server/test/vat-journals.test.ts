import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { Db } from "../src/db";
import { call, makeApp, setUp, tempDir } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const OTHER_INCOME = A.sales_other.id;
const today = () => dubaiDate(new Date().toISOString());
type L = { accountId: string; debitFils: number; creditFils: number; vatBox?: string };
const debit = (accountId: string, fils: number, vatBox?: string): L => ({ accountId, debitFils: fils, creditFils: 0, ...(vatBox ? { vatBox } : {}) });
const credit = (accountId: string, fils: number, vatBox?: string): L => ({ accountId, debitFils: 0, creditFils: fils, ...(vatBox ? { vatBox } : {}) });

async function books() {
  const app = await makeApp(undefined, { postsBooks: true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: today() });
  const postJournal = async (lines: L[]) => {
    const d = (await call(app, "POST", "/api/books/drafts", owner, { date: today(), narration: "VAT", lines })).body.draft;
    return call(app, "POST", `/api/books/drafts/${d.id}/post`, owner);
  };
  return { app, owner, postJournal };
}

describe("VAT box tags on journal lines", () => {
  it("a tagged journal may use Output VAT; untagged it may not", async () => {
    const { postJournal } = await books();
    // VAT on a customer advance: Dr Bank 1050 / Cr Other income 1000 (box 1) / Cr Output VAT 50 (box 1).
    expect((await postJournal([debit(A.bank.id, 105000), credit(OTHER_INCOME, 100000, "1"), credit(A.vat_output.id, 5000, "1")])).status).toBe(200);
    const r = await postJournal([debit(A.bank.id, 5000), credit(A.vat_output.id, 5000)]);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/tag the line with its VAT return box/);
  });

  it("tags must fit the account", async () => {
    const { postJournal } = await books();
    expect((await postJournal([debit(A.bank.id, 5000), credit(A.vat_output.id, 5000, "9")])).status).toBe(400);
    expect((await postJournal([debit(A.vat_input.id, 5000, "1"), credit(A.bank.id, 5000)])).status).toBe(400);
    expect((await postJournal([debit(A.bank.id, 5000), credit(OTHER_INCOME, 5000, "1adj")])).status).toBe(400);
  });

  it("tags are kept on the entry and copied to its reversal", async () => {
    const { app, owner, postJournal } = await books();
    const e = (await postJournal([debit(A.bank.id, 100000), credit(OTHER_INCOME, 100000, "4")])).body.entry;
    expect(e.lines.find((l: { vatBox: string | null }) => l.vatBox).vatBox).toBe("4");
    const rev = (await call(app, "POST", `/api/books/journals/${e.id}/reverse`, owner, { date: today() })).body.entry;
    expect(rev.lines.map((l: { vatBox: string | null }) => l.vatBox).sort()).toEqual(["4", null]);
  });

  it("migration 13 keeps entries and accepts vat_return", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 12 });
    old.run(`INSERT INTO journal_entries (id, series, seq, number, date, narration, source_type, created_at) VALUES ('e1', '', 1, 'JV-00001', '2026-11-01', 'Old', 'manual', 'x')`);
    old.close();
    const db = new Db(file);
    expect(db.get("SELECT narration FROM journal_entries WHERE id = 'e1'")).toEqual({ narration: "Old" });
    db.run(`INSERT INTO journal_entries (id, series, seq, number, date, narration, source_type, created_at) VALUES ('e2', '', 2, 'JV-00002', '2026-11-30', 'VAT', 'vat_return', 'x')`);
    db.run(`INSERT INTO journal_lines (id, entry_id, position, account_id, debit_fils, credit_fils, vat_box) VALUES ('l1', 'e2', 0, ?, 1, 0, '4')`, [A.bank.id]);
    expect(db.get("SELECT COUNT(*) AS n FROM vat_returns")).toEqual({ n: 0 });
    db.close();
  });
});
