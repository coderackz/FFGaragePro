import { postedDepreciation, type AssetRow } from "../assets/register";
import { dubaiDate, SYSTEM_ACCOUNTS as A, type AccountType } from "@ffgp/shared";
import type { Db } from "../db";
import { badRequest, conflict } from "../errors";
import { customerBalance } from "../ledger";
import { getSettings } from "../settings";
import { ENTRY_SELECT, NOT_HERE, entryOut, getEntry, type EntryOut } from "./journals";
import { addDays, postEntry } from "./post";
import { stockValue } from "./rules";
import { supplierBalance } from "../payables/ledger";

const today = () => dubaiDate(new Date().toISOString());
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymdOr = (v: string | undefined, fallback: string) => {
  if (v === undefined || v === "") return fallback;
  if (!YMD.test(v)) throw badRequest("Use a date like 2026-01-31");
  return v;
};
const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

interface Balance { accountId: string; code: string; name: string; type: AccountType; b: number }

/** Each account's balance (debits − credits) over entries in [from, to], optionally leaving out some entry kinds. */
function balances(db: Db, o: { from?: string; to: string; types?: AccountType[]; excludeSources?: string[] }): Balance[] {
  const where = [`e.date <= :to`];
  if (o.from) where.push(`e.date >= :from`);
  if (o.types) where.push(`a.type IN (${o.types.map((t) => `'${t}'`).join(", ")})`);
  if (o.excludeSources?.length) where.push(`e.source_type NOT IN (${o.excludeSources.map((t) => `'${t}'`).join(", ")})`);
  return db.all<Balance>(
    `SELECT a.id AS accountId, a.code, a.name, a.type, SUM(l.debit_fils - l.credit_fils) AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE ${where.join(" AND ")} GROUP BY a.id HAVING b <> 0 ORDER BY a.code`,
    o.from ? { to: o.to, from: o.from } : { to: o.to },
  );
}

export function trialBalance(db: Db, asOf?: string) {
  const rows = balances(db, { to: ymdOr(asOf, today()) }).map((r) => ({
    accountId: r.accountId, code: r.code, name: r.name, type: r.type, debitFils: r.b > 0 ? r.b : 0, creditFils: r.b < 0 ? -r.b : 0,
  }));
  return {
    rows,
    totals: { debitFils: rows.reduce((s, r) => s + r.debitFils, 0), creditFils: rows.reduce((s, r) => s + r.creditFils, 0) },
  };
}

type Row = { accountId: string; code: string; name: string; amountFils: number };
const rowsOf = (list: Balance[], type: AccountType, sign: 1 | -1): Row[] =>
  list.filter((b) => b.type === type).map((b) => ({ accountId: b.accountId, code: b.code, name: b.name, amountFils: sign * b.b }));
const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.amountFils, 0);

/** Profit and loss for [from, to] (the year-end closing entry left out), with the same length of time before it. */
export function profitAndLoss(db: Db, fromIn?: string, toIn?: string) {
  const to = ymdOr(toIn, today());
  const from = ymdOr(fromIn, `${to.slice(0, 8)}01`);
  if (from > to) throw badRequest("The start date is after the end date");
  const section = (f: string, t: string) => {
    const list = balances(db, { from: f, to: t, types: ["income", "cost_of_sales", "expense"], excludeSources: ["year_close"] });
    const income = rowsOf(list, "income", -1);
    const costOfSales = rowsOf(list, "cost_of_sales", 1);
    const expenses = rowsOf(list, "expense", 1);
    const incomeFils = sum(income);
    const costOfSalesFils = sum(costOfSales);
    const expensesFils = sum(expenses);
    return {
      from: f, to: t, income, costOfSales, expenses, incomeFils, costOfSalesFils, grossProfitFils: incomeFils - costOfSalesFils, expensesFils,
      netProfitFils: incomeFils - costOfSalesFils - expensesFils,
    };
  };
  const length = daysBetween(from, to) + 1;
  return { current: section(from, to), previous: section(addDays(from, -length), addDays(from, -1)) };
}

/** Balance sheet at a date: assets, liabilities and equity, with the profit not yet closed into retained earnings. */
export function balanceSheet(db: Db, asOf?: string) {
  const to = ymdOr(asOf, today());
  const list = balances(db, { to });
  const assets = rowsOf(list, "asset", 1);
  const liabilities = rowsOf(list, "liability", -1);
  const equity = rowsOf(list, "equity", -1);
  const profitThisYearFils = -list.filter((b) => b.type === "income" || b.type === "cost_of_sales" || b.type === "expense").reduce((s, b) => s + b.b, 0);
  return {
    asOf: to, assets, liabilities, equity, assetsFils: sum(assets), liabilitiesFils: sum(liabilities), profitThisYearFils,
    equityFils: sum(equity) + profitThisYearFils,
  };
}

/** One account's entries in [from, to] with a running balance (debits − credits), optionally for one customer or supplier. */
export function ledger(db: Db, q: { accountId?: string; from?: string; to?: string; customerId?: string; supplierId?: string }) {
  if (!q.accountId) throw badRequest("Choose an account");
  const to = ymdOr(q.to, today());
  const from = q.from ? ymdOr(q.from, to) : null;
  const filter = `l.account_id = :account AND (:customer IS NULL OR l.customer_id = :customer) AND (:supplier IS NULL OR l.supplier_id = :supplier)`;
  const params = { account: q.accountId, customer: q.customerId ?? null, supplier: q.supplierId ?? null, from, to };
  const openingFils = from
    ? db.get<{ b: number | null }>(`SELECT SUM(l.debit_fils - l.credit_fils) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE ${filter} AND e.date < :from`, params)!.b ?? 0
    : 0;
  const lines = db.all<{ entry_id: string; number: string; date: string; narration: string; source_type: string; source_id: string | null; source_number: string | null; debit_fils: number; credit_fils: number; memo: string | null }>(
    `SELECT l.entry_id, e.number, e.date, e.narration, e.source_type, e.source_id, l.debit_fils, l.credit_fils, l.memo,
       COALESCE((SELECT number FROM documents WHERE id = e.source_id), (SELECT number FROM receipts WHERE id = e.source_id),
                (SELECT supplier_invoice_no FROM goods_receipts WHERE id = e.source_id),
  (SELECT number FROM supplier_returns WHERE id = e.source_id)) AS source_number
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE ${filter} AND (:from IS NULL OR e.date >= :from) AND e.date <= :to ORDER BY e.date, e.series, e.seq, l.position`,
    params,
  );
  let running = openingFils;
  const rows = lines.map((l) => {
    running += l.debit_fils - l.credit_fils;
    return {
      entryId: l.entry_id, number: l.number, date: l.date, narration: l.narration, sourceType: l.source_type, sourceId: l.source_id, sourceNumber: l.source_number,
      debitFils: l.debit_fils, creditFils: l.credit_fils, memo: l.memo, balanceFils: running,
    };
  });
  return { accountId: q.accountId, from, to, openingFils, rows, closingFils: running };
}

/** Posted journals, newest first, with their total. */
export function journals(db: Db, q: { from?: string; to?: string; sourceType?: string; q?: string }) {
  const rows = db.all<Parameters<typeof entryOut>[1] & { total: number }>(
    `${ENTRY_SELECT.replace("FROM journal_entries e", ", (SELECT SUM(debit_fils) FROM journal_lines WHERE entry_id = e.id) AS total FROM journal_entries e")}
     WHERE (:from IS NULL OR e.date >= :from) AND (:to IS NULL OR e.date <= :to) AND (:type IS NULL OR e.source_type = :type)
       AND (:q IS NULL OR e.number LIKE :like OR e.narration LIKE :like)
     ORDER BY e.date DESC, e.series DESC, e.seq DESC LIMIT 500`,
    { from: q.from || null, to: q.to || null, type: q.sourceType || null, q: q.q || null, like: `%${q.q ?? ""}%` },
  );
  return rows.map((r) => {
    const { lines: _lines, ...entry } = entryOut(db, r);
    return { ...entry, totalFils: r.total };
  });
}

// ── Books health ──────────────────────────────────────────────────────────────────────────────────────────────────
const accountBalance = (db: Db, id: string, sources?: string[]) =>
  db.get<{ b: number | null }>(
    `SELECT SUM(l.debit_fils - l.credit_fils) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ?
     ${sources ? `AND e.source_type IN (${sources.map((s) => `'${s}'`).join(", ")})` : ""}`,
    [id],
  )!.b ?? 0;


/**
 * Checks that the books agree with the workshop: they balance; receivables = what customers owe; inventory = stock
 * at average cost; output VAT = the VAT on invoices less credit notes since the start; opening clearing is zero.
 * Also lists entries posted late (dated in a locked period) and job cards with parts still in work in progress.
 */
export function health(db: Db) {
  const check = (key: string, appFils: number, booksFils: number, note: string) => ({ key, ok: appFils === booksFils, appFils, booksFils, differenceFils: appFils - booksFils, note });
  const totals = db.get<{ d: number | null; c: number | null }>("SELECT SUM(debit_fils) AS d, SUM(credit_fils) AS c FROM journal_lines")!;
  // Both sides over all dates: the books hold anything dated ahead too (a bill dated next week).
  const ALL = "9999-12-31";
  const owed = db.all<{ id: string }>("SELECT id FROM customers").reduce((s, c) => s + customerBalance(db, c.id, ALL).balanceFils, 0);
  const owedToSuppliers = db.all<{ id: string }>("SELECT id FROM suppliers").reduce((s, x) => s + supplierBalance(db, x.id, ALL).balanceFils, 0);
  const start = getSettings(db).books.startDate;
  const vat = start
    ? db.get<{ v: number | null }>(
        `SELECT SUM(CASE WHEN type = 'invoice' THEN vat_fils ELSE -vat_fils END) AS v FROM documents
         WHERE type IN ('invoice', 'credit_note') AND status <> 'draft' AND issued_at IS NOT NULL AND date(issued_at, '+4 hours') >= ?`,
        [start],
      )!.v ?? 0
    : 0;
  const checks = [
    check("trial_balance", totals.d ?? 0, totals.c ?? 0, "Debits equal credits"),
    check("receivables", owed, accountBalance(db, A.receivables.id), "What customers owe = Accounts receivable"),
    check("payables", owedToSuppliers, -accountBalance(db, A.payables.id), "What we owe suppliers = Accounts payable"),
    check("inventory", stockValue(db), accountBalance(db, A.inventory.id), "Stock at average cost = Inventory"),
    check("output_vat", vat, -accountBalance(db, A.vat_output.id, ["invoice", "credit_note"]), "VAT on invoices less credit notes = Output VAT"),
    check("opening_clearing", 0, -accountBalance(db, A.opening_clearing.id), "Opening balance clearing is zero once the opening balances are in"),
    ...fixedAssetChecks(db),
  ];
  const late = db.all<{ id: string; number: string; date: string; original_date: string; narration: string }>(
    "SELECT id, number, date, original_date, narration FROM journal_entries WHERE original_date IS NOT NULL ORDER BY date DESC LIMIT 100",
  ).map((e) => ({ id: e.id, number: e.number, date: e.date, originalDate: e.original_date, narration: e.narration }));
  const openWip = db.all<{ job: string; number: string; wip: number }>(
    `SELECT l.document_id AS job, d.number, SUM(l.debit_fils - l.credit_fils) AS wip FROM journal_lines l JOIN documents d ON d.id = l.document_id
     WHERE l.account_id = ? GROUP BY l.document_id HAVING wip <> 0 ORDER BY d.number`,
    [A.wip.id],
  ).map((r) => ({ jobId: r.job, number: r.number, wipFils: r.wip }));
  const failures = db.all<{ post_key: string; error: string; at: string }>("SELECT * FROM book_failures ORDER BY at DESC")
    .map((f) => ({ postKey: f.post_key, error: f.error, at: f.at }));
  return { checks, late, openWip, failures };
}

/** Brings the books' inventory to the stock's value at average cost (after a cost was recalculated). */
export function revalueStock(db: Db, userId: string, posts: boolean): EntryOut {
  if (!posts) throw conflict(NOT_HERE);
  const diff = stockValue(db) - accountBalance(db, A.inventory.id);
  if (diff === 0) throw conflict("Stock already matches the books");
  const id = postEntry(db, {
    date: today(), narration: "Stock revaluation (average cost)", sourceType: "revaluation", postKey: `revaluation:${crypto.randomUUID()}`, userId,
    lines: [
      { accountId: A.inventory.id, debitFils: diff > 0 ? diff : 0, creditFils: diff < 0 ? -diff : 0 },
      { accountId: A.stock_revaluation.id, debitFils: diff < 0 ? -diff : 0, creditFils: diff > 0 ? diff : 0 },
    ],
  });
  return getEntry(db, id!)!;
}

/**
 * The fixed asset register agrees with the books: the cost of assets still held = the balance of the accounts they
 * sit in; their depreciation (brought forward and posted) = accumulated depreciation. Only once there's a register.
 */
function fixedAssetChecks(db: Db) {
  const assets = db.all<AssetRow>("SELECT * FROM fixed_assets");
  if (!assets.length) return [];
  const held = assets.filter((a) => !a.disposed_on);
  const accounts = [...new Set(assets.map((a) => a.account_id))];
  const booksCost = accounts.reduce((s, id) => s + (db.get<{ b: number | null }>("SELECT SUM(debit_fils - credit_fils) AS b FROM journal_lines WHERE account_id = ?", [id])!.b ?? 0), 0);
  const registerCost = held.reduce((s, a) => s + a.cost_fils, 0);
  const registerDepreciation = held.reduce((s, a) => s + postedDepreciation(db, a), 0);
  const booksDepreciation = -(db.get<{ b: number | null }>("SELECT SUM(debit_fils - credit_fils) AS b FROM journal_lines WHERE account_id = ?", [A.accumulated_depreciation.id])!.b ?? 0);
  const ok = registerCost === booksCost && registerDepreciation === booksDepreciation;
  const appFils = registerCost - registerDepreciation;
  const booksFils = booksCost - booksDepreciation;
  return [{ key: "fixed_assets", ok, appFils, booksFils, differenceFils: appFils - booksFils, note: "Fixed asset register = asset accounts less accumulated depreciation" }];
}

