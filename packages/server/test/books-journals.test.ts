import { describe, expect, it } from "vitest";
import { dubaiDate, SYSTEM_ACCOUNTS } from "@ffgp/shared";
import { addDays } from "../src/books/post";
import { addUser, call, createPart, makeApp, setUp } from "./helpers";

const A = SYSTEM_ACCOUNTS;
const RENT = "00000000-0000-4000-8000-0000000a6010";
const today = () => dubaiDate(new Date().toISOString());
const line = (accountId: string, debitFils: number, creditFils: number) => ({ accountId, debitFils, creditFils });

async function books(o: { posts?: boolean; startDate?: string } = {}) {
  const app = await makeApp(undefined, { postsBooks: o.posts ?? true });
  const owner = await setUp(app);
  await call(app, "PUT", "/api/settings/books", owner, { startDate: o.startDate ?? today() });
  return { app, owner };
}

describe("manual journals", () => {
  it("draft → post → reverse", async () => {
    const { app, owner } = await books();
    const accountant = await addUser(app, owner, "accountant");
    const draft = (await call(app, "POST", "/api/books/drafts", accountant, { date: today(), narration: "Rent", lines: [line(RENT, 5000, 0), line(A.bank.id, 0, 4000)] })).body.draft;
    expect(draft).toMatchObject({ kind: "manual", narration: "Rent" });
    // Unbalanced drafts can be saved, not posted.
    expect((await call(app, "POST", `/api/books/drafts/${draft.id}/post`, accountant)).status).toBe(400);
    await call(app, "PATCH", `/api/books/drafts/${draft.id}`, accountant, { lines: [line(RENT, 5000, 0), line(A.bank.id, 0, 5000)] });
    const posted = await call(app, "POST", `/api/books/drafts/${draft.id}/post`, accountant);
    expect(posted.status).toBe(200);
    expect(posted.body.entry).toMatchObject({ number: "JV-00001", narration: "Rent", sourceType: "manual" });
    expect((await call(app, "GET", "/api/books/drafts", accountant)).body.drafts).toEqual([]);

    const reversed = await call(app, "POST", `/api/books/journals/${posted.body.entry.id}/reverse`, accountant, { date: today() });
    expect(reversed.status).toBe(200);
    const lines = app.db.all<{ account_id: string; debit_fils: number; credit_fils: number }>(
      "SELECT account_id, debit_fils, credit_fils FROM journal_lines WHERE entry_id = ? ORDER BY position", [reversed.body.entry.id]);
    expect(lines).toEqual([{ account_id: RENT, debit_fils: 0, credit_fils: 5000 }, { account_id: A.bank.id, debit_fils: 5000, credit_fils: 0 }]);
    expect(reversed.body.entry.reversesId).toBe(posted.body.entry.id);
    expect((await call(app, "POST", `/api/books/journals/${posted.body.entry.id}/reverse`, accountant, { date: today() })).status).toBe(409);

    const c = (await call(app, "POST", "/api/customers", owner, { name: "Walk-in" })).body.customer;
    await call(app, "POST", "/api/receipts", owner, { customerId: c.id, amountFils: 1000, method: "cash" });
    const auto = app.db.get<{ id: string }>("SELECT id FROM journal_entries WHERE source_type = 'receipt'")!;
    expect((await call(app, "POST", `/api/books/journals/${auto.id}/reverse`, accountant, { date: today() })).status).toBe(400);
  });

  it("an advisor can't touch the books", async () => {
    const { app, owner } = await books();
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "GET", "/api/books/drafts", advisor)).status).toBe(403);
    expect((await call(app, "POST", "/api/books/drafts", advisor, { date: today(), narration: "x", lines: [] })).status).toBe(403);
  });

  it("linked server refuses to post", async () => {
    const { app, owner } = await books({ posts: false });
    const draft = (await call(app, "POST", "/api/books/drafts", owner, { date: today(), narration: "Rent", lines: [line(RENT, 5000, 0), line(A.bank.id, 0, 5000)] })).body.draft;
    const res = await call(app, "POST", `/api/books/drafts/${draft.id}/post`, owner);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Post from the browser app: this garage's books are kept in the cloud.");
  });
});

describe("opening balances", () => {
  it("opening proposal and post", async () => {
    const start = today();
    const { app, owner } = await books({ startDate: addDays(start, 30) });
    // Before the start: a customer owing 300 and 2 parts at 40 on the shelf.
    const c = (await call(app, "POST", "/api/customers", owner, { name: "Old account", openingBalanceFils: 30000, openingBalanceDate: addDays(start, -10) })).body.customer;
    await createPart(app, owner, {}, { qty: 2, unitCostFils: 4000 });
    const proposal = (await call(app, "GET", "/api/books/opening/proposal", owner)).body;
    expect(proposal.date).toBe(addDays(start, 29));
    expect(proposal.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: A.receivables.id, customerId: c.id, debitFils: 30000, creditFils: 0 }),
      expect.objectContaining({ accountId: A.inventory.id, debitFils: 8000, creditFils: 0 }),
    ]));
    // The accountant adds the bank balance; the rest goes to opening balance equity.
    const draft = (await call(app, "POST", "/api/books/drafts", owner, { kind: "opening", date: proposal.date, narration: "Opening balances", lines: [...proposal.lines, line(A.bank.id, 50000, 0)] })).body.draft;
    const posted = await call(app, "POST", `/api/books/drafts/${draft.id}/post`, owner);
    if (posted.status !== 200) throw new Error(JSON.stringify(posted.body));
    expect(posted.status).toBe(200);
    expect(posted.body.entry).toMatchObject({ sourceType: "opening", date: addDays(start, 29) });
    expect(app.db.get("SELECT credit_fils FROM journal_lines WHERE entry_id = ? AND account_id = ?", [posted.body.entry.id, A.opening_equity.id]))
      .toEqual({ credit_fils: 88000 });
    const again = (await call(app, "POST", "/api/books/drafts", owner, { kind: "opening", date: proposal.date, narration: "Again", lines: proposal.lines })).body.draft;
    expect((await call(app, "POST", `/api/books/drafts/${again.id}/post`, owner)).status).toBe(409);
  });
});

describe("locks and year end", () => {
  it("locks", async () => {
    const { app, owner } = await books({ startDate: addDays(today(), -40) });
    const accountant = await addUser(app, owner, "accountant");
    expect((await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), -40), lockDate: today() })).status).toBe(400);
    expect((await call(app, "PUT", "/api/settings/books", accountant, { startDate: addDays(today(), -40), lockDate: addDays(today(), -10) })).status).toBe(403);
    expect((await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), -40), lockDate: addDays(today(), -10) })).status).toBe(200);
    const c = (await call(app, "POST", "/api/customers", owner, { name: "X" })).body.customer;
    const late = await call(app, "POST", "/api/receipts", owner, { customerId: c.id, amountFils: 1000, method: "cash", receivedAt: `${addDays(today(), -12)}T08:00:00.000Z` });
    expect(late.status).toBe(400);
    expect(late.body.error).toMatch(/^The books are locked up to \d{2} \w{3} \d{4}$/);
    const draft = (await call(app, "POST", "/api/books/drafts", owner, { date: addDays(today(), -11), narration: "Rent", lines: [line(RENT, 5000, 0), line(A.bank.id, 0, 5000)] })).body.draft;
    expect((await call(app, "POST", `/api/books/drafts/${draft.id}/post`, owner)).status).toBe(400);
    // Something has posted (the receipt below), so the start date can't move.
    await call(app, "POST", "/api/receipts", owner, { customerId: c.id, amountFils: 1000, method: "cash" });
    const moved = await call(app, "PUT", "/api/settings/books", owner, { startDate: addDays(today(), -60), lockDate: addDays(today(), -10) });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatch(/^The books have started on /);
  });

  it("year end", async () => {
    const { app, owner } = await books({ startDate: "2025-01-01" });
    const post = async (date: string, lines: ReturnType<typeof line>[]) => {
      const d = (await call(app, "POST", "/api/books/drafts", owner, { date, narration: "x", lines })).body.draft;
      return call(app, "POST", `/api/books/drafts/${d.id}/post`, owner);
    };
    expect((await post("2025-06-01", [line(A.bank.id, 10000, 0), line(A.sales_labour.id, 0, 10000)])).status).toBe(200);
    expect((await post("2025-07-01", [line(RENT, 3000, 0), line(A.bank.id, 0, 3000)])).status).toBe(200);
    expect((await post("2026-01-05", [line(RENT, 999, 0), line(A.bank.id, 0, 999)])).status).toBe(200);
    const closed = await call(app, "POST", "/api/books/year-end", owner, { yearEnd: "2025-12-31" });
    expect(closed.status).toBe(200);
    const lines = app.db.all<{ account_id: string; debit_fils: number; credit_fils: number }>(
      "SELECT account_id, debit_fils, credit_fils FROM journal_lines WHERE entry_id = ? ORDER BY account_id", [closed.body.entry.id]);
    expect(lines).toEqual(expect.arrayContaining([
      { account_id: A.sales_labour.id, debit_fils: 10000, credit_fils: 0 },
      { account_id: RENT, debit_fils: 0, credit_fils: 3000 },
      { account_id: A.retained_earnings.id, debit_fils: 0, credit_fils: 7000 },
    ]));
    expect(closed.body.entry.date).toBe("2025-12-31");
    expect((await call(app, "GET", "/api/settings", owner)).body.settings.books.lockDate).toBe("2025-12-31");
    expect((await call(app, "POST", "/api/books/year-end", owner, { yearEnd: "2025-12-31" })).status).toBe(409);
    expect((await call(app, "POST", "/api/books/year-end", owner, { yearEnd: "2025-11-30" })).status).toBe(400);
  });
});
