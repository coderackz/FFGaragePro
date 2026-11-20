import { dueThrough, postedDepreciation, type AssetRow } from "../assets/register";
import { gratuityAtStart, type Snapshot } from "../payroll/runs";
import type { SettlementSnapshot } from "../payroll/settlements";
import { getSettings } from "../settings";
import { dubaiDate, SYSTEM_ACCOUNTS as A, type Settings } from "@ffgp/shared";
import type { Db } from "../db";
import type { PostInput, PostLine } from "./post";

/**
 * The automatic entries, one function per kind of event (spec "How the automatic entries post"). Each finds the
 * events at or after the books' start date that have no entry yet (by post key) and posts them from the data as it
 * stands now. Running again posts nothing.
 */
export interface PostCtx {
  db: Db;
  /** Books start date (YYYY-MM-DD). */
  start: string;
  methodAccounts: Settings["books"]["methodAccounts"];
  /**
   * Posts one event; an event that can't post is recorded (Books health lists it) and the rest carry on. Returns
   * whether it posted.
   */
  post: (e: PostInput) => boolean;
  /** The batch is full: stop, the next run carries on. */
  full: () => boolean;
}

const DUBAI = "'+4 hours'";
const unposted = (key: string) => `NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.post_key = ${key})`;
const debit = (accountId: string, fils: number, extra: Partial<PostLine> = {}): PostLine =>
  fils >= 0 ? { accountId, debitFils: fils, creditFils: 0, ...extra } : { accountId, debitFils: 0, creditFils: -fils, ...extra };
const credit = (accountId: string, fils: number, extra: Partial<PostLine> = {}): PostLine => debit(accountId, -fils, extra);
const SALES: Record<string, string> = { labour: A.sales_labour.id, part: A.sales_parts.id, other: A.sales_other.id };

/** Net by line kind, and VAT as gross less those nets (so the entry always balances to the fil). */
function salesLines(db: Db, docId: string, grossFils: number, sign: 1 | -1): PostLine[] {
  const byKind = db.all<{ kind: string; net: number }>("SELECT kind, SUM(net_fils) AS net FROM document_lines WHERE document_id = ? GROUP BY kind", [docId]);
  const nets = byKind.reduce((s, k) => s + k.net, 0);
  return [...byKind.map((k) => credit(SALES[k.kind] ?? A.sales_other.id, sign * k.net)), credit(A.vat_output.id, sign * (grossFils - nets))];
}

/** Issued invoices: Dr receivables (customer) gross / Cr sales by line kind, output VAT. Credit notes: the mirror. */
export function postSalesDocuments(c: PostCtx): number {
  let n = 0;
  const docs = c.db.all<{ id: string; type: string; number: string; customer_id: string; gross_fils: number; day: string }>(
    `SELECT d.id, d.type, d.number, d.customer_id, d.gross_fils, date(d.issued_at, ${DUBAI}) AS day FROM documents d
     WHERE d.type IN ('invoice', 'credit_note') AND d.status <> 'draft' AND d.issued_at IS NOT NULL AND date(d.issued_at, ${DUBAI}) >= ?
       AND ${unposted("d.type || ':' || d.id")}
     ORDER BY d.issued_at`,
    [c.start],
  );
  for (const d of docs) {
    if (c.full()) break;
    const invoice = d.type === "invoice";
    const id = c.post({
      date: d.day, narration: `${invoice ? "Invoice" : "Credit note"} ${d.number}`, sourceType: invoice ? "invoice" : "credit_note", sourceId: d.id,
      postKey: `${d.type}:${d.id}`, userId: null,
      lines: [debit(A.receivables.id, (invoice ? 1 : -1) * d.gross_fils, { customerId: d.customer_id }), ...salesLines(c.db, d.id, d.gross_fils, invoice ? 1 : -1)],
    });
    if (id) n++;
  }
  return n;
}

/** Receipts: Dr the method's account / Cr receivables (customer). A refund (negative) is the other way round. */
export function postReceipts(c: PostCtx): number {
  let n = 0;
  const rows = c.db.all<{ id: string; number: string; customer_id: string; amount_fils: number; method: string; day: string }>(
    `SELECT r.id, r.number, r.customer_id, r.amount_fils, r.method, date(r.received_at, ${DUBAI}) AS day FROM receipts r
     WHERE date(r.received_at, ${DUBAI}) >= ? AND ${unposted("'receipt:' || r.id")} ORDER BY r.received_at`,
    [c.start],
  );
  for (const r of rows) {
    if (c.full()) break;
    const money = (c.methodAccounts as Record<string, string>)[r.method] ?? c.methodAccounts.cash;
    const id = c.post({
      date: r.day, narration: `${r.amount_fils < 0 ? "Refund" : "Receipt"} ${r.number}`, sourceType: "receipt", sourceId: r.id, postKey: `receipt:${r.id}`,
      userId: null, lines: [debit(money, r.amount_fils), credit(A.receivables.id, r.amount_fils, { customerId: r.customer_id })],
    });
    if (id) n++;
  }
  return n;
}

/** The job's invoice is issued (so parts bought for it later are a cost now, not work in progress). */
const jobInvoiced = (db: Db, jobId: string) =>
  !!db.get("SELECT 1 FROM documents WHERE type = 'invoice' AND status <> 'draft' AND (id = ? OR source_id = ?)", [jobId, jobId]);

/**
 * Goods receipts (the supplier's bill for parts): Dr inventory (stocked parts go on the shelf), work in progress
 * (non-stocked parts bought for a job; cost of parts if the job is already invoiced) or other purchases; Dr input
 * VAT / Cr payables (supplier) gross. Counted from the day it was entered; dated by the supplier's invoice date.
 */
export function postGoodsReceipts(c: PostCtx): number {
  let n = 0;
  const rows = c.db.all<{ id: string; net_fils: number; gross_fils: number; supplier_id: string; supplier_name: string; invoice_no: string | null; invoice_date: string | null; day: string }>(
    `SELECT g.id, g.net_fils, g.gross_fils, p.supplier_id, s.name AS supplier_name, g.supplier_invoice_no AS invoice_no,
            g.supplier_invoice_date AS invoice_date, date(g.created_at, ${DUBAI}) AS day
     FROM goods_receipts g JOIN purchase_orders p ON p.id = g.po_id JOIN suppliers s ON s.id = p.supplier_id
     WHERE date(g.created_at, ${DUBAI}) >= ? AND ${unposted("'goods_receipt:' || g.id")} ORDER BY g.created_at`,
    [c.start],
  );
  for (const g of rows) {
    if (c.full()) break;
    const lines = c.db.all<{ qty: number; cost: number; part_id: string | null; job: string | null; stocked: number | null }>(
      `SELECT gl.qty, gl.unit_cost_fils AS cost, pl.part_id, pl.job_document_id AS job, pt.stocked
       FROM goods_receipt_lines gl JOIN po_lines pl ON pl.id = gl.po_line_id LEFT JOIN parts pt ON pt.id = pl.part_id WHERE gl.receipt_id = ?`,
      [g.id],
    );
    const posted: PostLine[] = lines.map((l) => {
      const value = Math.round(l.qty * l.cost);
      if (l.part_id && l.stocked) return debit(A.inventory.id, value);
      if (l.job) return jobInvoiced(c.db, l.job) ? debit(A.cogs_parts.id, value) : debit(A.wip.id, value, { documentId: l.job });
      return debit(A.purchases_other.id, value);
    });
    // Rounding between the lines and the receipt's net goes on the last line, so the bill is exact.
    const linesNet = posted.reduce((s, l) => s + l.debitFils, 0);
    if (posted.length) posted[posted.length - 1]!.debitFils += g.net_fils - linesNet;
    const date = g.invoice_date && /^\d{4}-\d{2}-\d{2}$/.test(g.invoice_date) && g.invoice_date >= c.start ? g.invoice_date : g.day;
    const id = c.post({
      date, narration: `Parts from ${g.supplier_name}${g.invoice_no ? `, invoice ${g.invoice_no}` : ""}`, sourceType: "goods_receipt", sourceId: g.id,
      postKey: `goods_receipt:${g.id}`, userId: null,
      lines: [...posted, debit(A.vat_input.id, g.gross_fils - g.net_fils), credit(A.payables.id, g.gross_fils, { supplierId: g.supplier_id })],
    });
    if (id) n++;
  }
  return n;
}

/**
 * Stock movements (the goods receipt covers parts received): fitted on a job card → work in progress (that job);
 * taken by an invoice → cost of parts; returned on a credit note → back from cost of parts; counted, damaged, lost →
 * stock adjustments; opening stock → opening balance clearing. A part coming back reverses the entry.
 */
export function postStock(c: PostCtx): number {
  let n = 0;
  const rows = c.db.all<{ id: string; qty: number; cost: number; reason: string; document_id: string | null; doc_type: string | null; doc_number: string | null; part: string; day: string }>(
    `SELECT m.id, m.qty, m.unit_cost_fils AS cost, m.reason, m.document_id, d.type AS doc_type, d.number AS doc_number, p.name AS part,
            date(m.created_at, ${DUBAI}) AS day
     FROM stock_movements m JOIN parts p ON p.id = m.part_id LEFT JOIN documents d ON d.id = m.document_id
     WHERE m.reason <> 'receive' AND (m.reason = 'opening' OR date(m.created_at, ${DUBAI}) >= ?) AND ROUND(ABS(m.qty) * m.unit_cost_fils) <> 0
       AND ${unposted("'stock:' || m.id")} ORDER BY m.created_at, m.rowid`,
    [c.start],
  );
  for (const m of rows) {
    if (c.full()) break;
    const value = Math.round(Math.abs(m.qty) * m.cost);
    const out = m.qty < 0;
    let other: PostLine;
    let narration: string;
    if (m.reason === "job") {
      other = debit(A.wip.id, 0, { documentId: m.document_id });
      narration = `${m.part} ${out ? "fitted on" : "back from"} ${m.doc_number ?? "a job card"}`;
    } else if (m.reason === "invoice" || (m.reason === "adjust" && m.doc_type === "credit_note")) {
      other = debit(A.cogs_parts.id, 0);
      narration = `${m.part} ${out ? "sold on" : "returned on"} ${m.doc_number ?? "an invoice"}`;
    } else if (m.reason === "opening") {
      other = debit(A.opening_clearing.id, 0);
      narration = `Opening stock: ${m.part}`;
    } else {
      other = debit(A.stock_adjustments.id, 0);
      narration = `Stock adjustment: ${m.part}`;
    }
    // Out of stock: Dr the other account / Cr inventory. Into stock: the other way round.
    const lines = out
      ? [{ ...other, debitFils: value }, credit(A.inventory.id, value)]
      : [debit(A.inventory.id, value), { ...other, debitFils: 0, creditFils: value }];
    const id = c.post({ date: m.day < c.start ? c.start : m.day, narration, sourceType: "stock", sourceId: m.id, postKey: `stock:${m.id}`, userId: null, lines });
    if (id) n++;
  }
  return n;
}

/**
 * When a job's invoice is issued, its work in progress becomes cost of parts sold. Posts whatever WIP balance the
 * job still has (so parts that reach the books later are moved too); `cogs:<invoice>:<n>` counts each posting.
 */
export function postCogs(c: PostCtx): number {
  let n = 0;
  const rows = c.db.all<{ invoice: string; number: string; job: string; day: string; wip: number }>(
    `SELECT i.id AS invoice, i.number, j.id AS job, date(i.issued_at, ${DUBAI}) AS day,
            (SELECT COALESCE(SUM(l.debit_fils - l.credit_fils), 0) FROM journal_lines l WHERE l.account_id = ? AND l.document_id = j.id) AS wip
     FROM documents i JOIN documents j ON j.id = i.source_id AND j.type = 'jobcard'
     WHERE i.type = 'invoice' AND i.status <> 'draft' AND i.issued_at IS NOT NULL AND date(i.issued_at, ${DUBAI}) >= ?`,
    [A.wip.id, c.start],
  );
  for (const r of rows) {
    if (c.full()) break;
    if (r.wip === 0) continue;
    const k = c.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'cogs' AND source_id = ?", [r.invoice])!.n + 1;
    const id = c.post({
      date: r.day, narration: `Parts cost of ${r.number}`, sourceType: "cogs", sourceId: r.invoice, postKey: `cogs:${r.invoice}:${k}`, userId: null,
      lines: [debit(A.cogs_parts.id, r.wip), credit(A.wip.id, r.wip, { documentId: r.job })],
    });
    if (id) n++;
  }
  return n;
}

/**
 * Customer opening balances, whatever their date (dated the start date at the earliest): Dr receivables (customer) /
 * Cr opening balance clearing. A change posts the difference. The opening balances entry clears the clearing account.
 */
export function postCustomerOpenings(c: PostCtx): number {
  let n = 0;
  const rows = c.db.all<{ id: string; name: string; fils: number; day: string | null; posted: number; k: number }>(
    `SELECT cu.id, cu.name, cu.opening_balance_fils AS fils, cu.opening_balance_date AS day,
            (SELECT COALESCE(SUM(l.debit_fils - l.credit_fils), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
             WHERE e.source_type = 'customer_opening' AND e.source_id = cu.id AND l.account_id = ?) AS posted,
            (SELECT COUNT(*) FROM journal_entries e WHERE e.source_type = 'customer_opening' AND e.source_id = cu.id) AS k
     FROM customers cu WHERE cu.opening_balance_fils <> 0 OR EXISTS (SELECT 1 FROM journal_entries e WHERE e.source_type = 'customer_opening' AND e.source_id = cu.id)`,
    [A.receivables.id],
  );
  for (const r of rows) {
    if (c.full()) break;
    const diff = r.fils - r.posted;
    if (diff === 0) continue;
    const id = c.post({
      date: r.day && r.day > c.start ? r.day : c.start, narration: `Opening balance: ${r.name}`, sourceType: "customer_opening", sourceId: r.id, postKey: `customer_opening:${r.id}:${r.k + 1}`,
      userId: null, lines: [debit(A.receivables.id, diff, { customerId: r.id }), credit(A.opening_clearing.id, diff)],
    });
    if (id) n++;
  }
  return n;
}

/** Stock on the shelf at average cost: what the books' inventory should hold. */
export const stockValue = (db: Db) => db.get<{ v: number | null }>("SELECT SUM(ROUND(on_hand * avg_cost_fils)) AS v FROM parts WHERE stocked = 1")!.v ?? 0;
export const inventoryBalance = (db: Db) =>
  db.get<{ b: number | null }>("SELECT SUM(debit_fils - credit_fils) AS b FROM journal_lines WHERE account_id = ?", [A.inventory.id])!.b ?? 0;

/**
 * Keeps inventory equal to the stock's value at average cost. Differences come from average-cost rounding and from
 * parts fitted before they were received (taken at the old cost); they are a cost of sales (stock revaluation).
 * Only once the books hold the stock that was there before the start (the opening balances), or there was none.
 */
export function postStockCorrection(c: PostCtx): number {
  if (c.full()) return 0;
  const before = c.db.get("SELECT 1 FROM stock_movements WHERE reason <> 'opening' AND date(created_at, '+4 hours') < ? LIMIT 1", [c.start]);
  if (before && !c.db.get("SELECT 1 FROM journal_entries WHERE source_type = 'opening' LIMIT 1")) return 0;
  const diff = stockValue(c.db) - inventoryBalance(c.db);
  if (diff === 0) return 0;
  const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  return c.post({
    date: today < c.start ? c.start : today, narration: "Stock value correction (average cost)", sourceType: "revaluation", postKey: `revaluation:${crypto.randomUUID()}`,
    userId: null, lines: [debit(A.inventory.id, diff), credit(A.stock_revaluation.id, diff)],
  }) ? 1 : 0;
}

/**
 * Supplier opening balances, whatever their date (dated the start date at the earliest): Dr opening balance clearing
 * / Cr payables (supplier). A change posts the difference. The opening balances entry clears the clearing account.
 */
export function postSupplierOpenings(c: PostCtx): number {
  let n = 0;
  const rows = c.db.all<{ id: string; name: string; fils: number; day: string | null; posted: number; k: number }>(
    `SELECT s.id, s.name, s.opening_balance_fils AS fils, s.opening_balance_date AS day,
            (SELECT COALESCE(SUM(l.credit_fils - l.debit_fils), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
             WHERE e.source_type = 'supplier_opening' AND e.source_id = s.id AND l.account_id = ?) AS posted,
            (SELECT COUNT(*) FROM journal_entries e WHERE e.source_type = 'supplier_opening' AND e.source_id = s.id) AS k
     FROM suppliers s WHERE s.opening_balance_fils <> 0 OR EXISTS (SELECT 1 FROM journal_entries e WHERE e.source_type = 'supplier_opening' AND e.source_id = s.id)`,
    [A.payables.id],
  );
  for (const r of rows) {
    if (c.full()) break;
    const diff = r.fils - r.posted;
    if (diff === 0) continue;
    if (c.post({
      date: r.day && r.day > c.start ? r.day : c.start, narration: `Opening balance: ${r.name}`, sourceType: "supplier_opening", sourceId: r.id,
      postKey: `supplier_opening:${r.id}:${r.k + 1}`, userId: null,
      lines: [debit(A.opening_clearing.id, diff), credit(A.payables.id, diff, { supplierId: r.id })],
    })) n++;
  }
  return n;
}

/** Supplier bills: Dr each line's account (net), input VAT / Cr payables (supplier) gross. A cancelled bill: the mirror. */
export function postSupplierBills(c: PostCtx): number {
  let n = 0;
  const bills = c.db.all<{ id: string; supplier_id: string; supplier_name: string; invoice_no: string; bill_date: string; vat_fils: number; gross_fils: number; status: string; cancelled_at: string | null; posted: number; cancel_posted: number }>(
    `SELECT b.id, b.supplier_id, s.name AS supplier_name, b.supplier_invoice_no AS invoice_no, b.bill_date, b.vat_fils, b.gross_fils, b.status, b.cancelled_at,
       EXISTS (SELECT 1 FROM journal_entries e WHERE e.post_key = 'supplier_bill:' || b.id) AS posted,
       EXISTS (SELECT 1 FROM journal_entries e WHERE e.post_key = 'bill_cancel:' || b.id) AS cancel_posted
     FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
     WHERE b.bill_date >= ?
       AND (NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.post_key = 'supplier_bill:' || b.id)
            OR (b.status = 'cancelled' AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.post_key = 'bill_cancel:' || b.id)))
     ORDER BY b.created_at`,
    [c.start],
  );
  for (const b of bills) {
    if (c.full()) break;
    const lines = c.db.all<{ account_id: string; net_fils: number }>("SELECT account_id, net_fils FROM supplier_bill_lines WHERE bill_id = ? ORDER BY position", [b.id]);
    const entry: PostLine[] = [
      ...lines.map((l) => debit(l.account_id, l.net_fils)), debit(A.vat_input.id, b.vat_fils), credit(A.payables.id, b.gross_fils, { supplierId: b.supplier_id }),
    ];
    const narration = `Bill ${b.invoice_no} from ${b.supplier_name}`;
    if (!b.posted && c.post({ date: b.bill_date, narration, sourceType: "supplier_bill", sourceId: b.id, postKey: `supplier_bill:${b.id}`, userId: null, lines: entry })) n++;
    if (b.status === "cancelled" && !b.cancel_posted && b.cancelled_at) {
      const mirror = entry.map((l) => ({ ...l, debitFils: l.creditFils, creditFils: l.debitFils }));
      if (c.post({ date: b.cancelled_at, narration: `Cancelled: ${narration}`, sourceType: "bill_cancel", sourceId: b.id, postKey: `bill_cancel:${b.id}`, userId: null, lines: mirror })) n++;
    }
  }
  return n;
}

/** Supplier payments: Dr payables (supplier) / Cr the account paid from; a cheque sits in cheques issued until it clears. */
export function postSupplierPayments(c: PostCtx): number {
  let n = 0;
  const rows = c.db.all<{ id: string; number: string; supplier_id: string; supplier_name: string; amount_fils: number; method: string; paid_from: string; paid_at: string }>(
    `SELECT p.id, p.number, p.supplier_id, s.name AS supplier_name, p.amount_fils, p.method, p.paid_from_account_id AS paid_from, p.paid_at
     FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.paid_at >= ? AND ${unposted("'supplier_payment:' || p.id")} ORDER BY p.created_at`,
    [c.start],
  );
  for (const p of rows) {
    if (c.full()) break;
    const from = p.method === "cheque" ? A.cheques_issued.id : p.paid_from;
    if (c.post({
      date: p.paid_at, narration: `Payment ${p.number} to ${p.supplier_name}`, sourceType: "supplier_payment", sourceId: p.id, postKey: `supplier_payment:${p.id}`,
      userId: null, lines: [debit(A.payables.id, p.amount_fils, { supplierId: p.supplier_id }), credit(from, p.amount_fils)],
    })) n++;
  }
  return n;
}

/** Expenses paid on the spot: Dr the expense (net), input VAT / Cr the account paid from. */
export function postExpenses(c: PostCtx): number {
  let n = 0;
  for (const e of c.db.all<{ id: string; number: string; date: string; account_id: string; description: string; net_fils: number; vat_fils: number; gross_fils: number; paid_from: string }>(
    `SELECT id, number, date, account_id, description, net_fils, vat_fils, gross_fils, paid_from_account_id AS paid_from FROM expenses
     WHERE date >= ? AND ${unposted("'expense:' || expenses.id")} ORDER BY created_at`,
    [c.start],
  )) {
    if (c.full()) break;
    if (c.post({
      date: e.date, narration: `${e.number}: ${e.description}`, sourceType: "expense", sourceId: e.id, postKey: `expense:${e.id}`, userId: null,
      lines: [debit(e.account_id, e.net_fils), debit(A.vat_input.id, e.vat_fils), credit(e.paid_from, e.gross_fils)],
    })) n++;
  }
  return n;
}

/** Money moved between bank and cash accounts; customer cheques paid into the bank; our cheques cleared by the bank. */
export function postMoneyMovements(c: PostCtx): number {
  let n = 0;
  for (const t of c.db.all<{ id: string; date: string; from_id: string; to_id: string; amount_fils: number; reference: string | null; from_name: string; to_name: string }>(
    `SELECT t.id, t.date, t.from_account_id AS from_id, t.to_account_id AS to_id, t.amount_fils, t.reference, f.name AS from_name, a.name AS to_name
     FROM money_transfers t JOIN accounts f ON f.id = t.from_account_id JOIN accounts a ON a.id = t.to_account_id
     WHERE t.date >= ? AND ${unposted("'transfer:' || t.id")} ORDER BY t.created_at`,
    [c.start],
  )) {
    if (c.full()) break;
    if (c.post({
      date: t.date, narration: `Transfer from ${t.from_name} to ${t.to_name}${t.reference ? ` (${t.reference})` : ""}`, sourceType: "transfer", sourceId: t.id,
      postKey: `transfer:${t.id}`, userId: null, lines: [debit(t.to_id, t.amount_fils), credit(t.from_id, t.amount_fils)],
    })) n++;
  }
  // Cheques paid in on one slip: one bank line for the total (the bank shows one credit).
  for (const d of c.db.all<{ batch: string; date: string; bank: string; total: number; n: number; numbers: string }>(
    `SELECT d.batch_id AS batch, MIN(d.date) AS date, MIN(d.bank_account_id) AS bank, SUM(r.amount_fils) AS total, COUNT(*) AS n, group_concat(r.number, ', ') AS numbers
     FROM cheque_deposits d JOIN receipts r ON r.id = d.receipt_id
     WHERE d.date >= ? AND ${unposted("'cheque_deposit:' || d.batch_id")} GROUP BY d.batch_id ORDER BY MIN(d.created_at)`,
    [c.start],
  )) {
    if (c.full()) break;
    if (c.post({
      date: d.date, narration: `${d.n === 1 ? "Cheque" : `${d.n} cheques`} paid in (${d.numbers})`, sourceType: "cheque_deposit", sourceId: d.batch,
      postKey: `cheque_deposit:${d.batch}`, userId: null, lines: [debit(d.bank, d.total), credit(A.cheques_in_hand.id, d.total)],
    })) n++;
  }
  for (const x of c.db.all<{ id: string; date: string; bank: string; amount_fils: number; number: string; supplier: string }>(
    `SELECT x.id, x.date, p.paid_from_account_id AS bank, p.amount_fils, p.number, s.name AS supplier
     FROM cheque_clearances x JOIN supplier_payments p ON p.id = x.payment_id JOIN suppliers s ON s.id = p.supplier_id
     WHERE x.date >= ? AND ${unposted("'cheque_clear:' || x.id")} ORDER BY x.created_at`,
    [c.start],
  )) {
    if (c.full()) break;
    if (c.post({
      date: x.date, narration: `Cheque ${x.number} to ${x.supplier} cleared`, sourceType: "cheque_clear", sourceId: x.id, postKey: `cheque_clear:${x.id}`,
      userId: null, lines: [debit(A.cheques_issued.id, x.amount_fils), credit(x.bank, x.amount_fils)],
    })) n++;
  }
  return n;
}

/**
 * Advances paid to staff: Dr Staff advances / Cr the cash or bank they came from. One paid before the books started is
 * part of the opening position: Cr opening balance clearing, dated the start. A cancelled advance is reversed.
 */
export function postStaffAdvances(c: PostCtx): number {
  let n = 0;
  for (const a of c.db.all<{ id: string; paid_on: string; amount_fils: number; paid_from: string; name: string; cancelled_on: string | null }>(
    `SELECT a.id, a.paid_on, a.amount_fils, a.paid_from_account_id AS paid_from, e.name, a.cancelled_on FROM staff_advances a JOIN employees e ON e.id = a.employee_id
     WHERE ${unposted("'staff_advance:' || a.id")} OR (a.cancelled_on IS NOT NULL AND ${unposted("'staff_advance_cancel:' || a.id")}) ORDER BY a.created_at`,
  )) {
    if (c.full()) break;
    const before = a.paid_on < c.start;
    const other = before ? A.opening_clearing.id : a.paid_from;
    const posted = c.post({
      date: before ? c.start : a.paid_on, narration: `Advance to ${a.name}${before ? ` (paid ${a.paid_on}, before the books)` : ""}`, sourceType: "staff_advance",
      sourceId: a.id, postKey: `staff_advance:${a.id}`, userId: null, lines: [debit(A.staff_advances.id, a.amount_fils), credit(other, a.amount_fils)],
    });
    if (posted) n++;
    if (a.cancelled_on && c.post({
      date: a.cancelled_on > c.start ? a.cancelled_on : c.start, narration: `Advance to ${a.name} cancelled`, sourceType: "staff_advance", sourceId: a.id,
      postKey: `staff_advance_cancel:${a.id}`, userId: null, lines: [debit(other, a.amount_fils), credit(A.staff_advances.id, a.amount_fils)],
    })) n++;
  }
  return n;
}

/**
 * Gratuity already owed when the books start, for staff who joined before: part of the opening position (Dr opening
 * balance clearing / Cr gratuity provision, dated the start), so the first payroll only puts aside its own month.
 * Once the pay rules are chosen; once per person.
 */
export function postPayrollOpenings(c: PostCtx): number {
  const rules = getSettings(c.db).payroll;
  if (!rules.gratuityDayRate || !rules.gratuityCap) return 0;
  let n = 0;
  for (const e of c.db.all<{ id: string; name: string; join_date: string; left_date: string | null; basic_fils: number; housing_fils: number; transport_fils: number; other_allowance_fils: number }>(
    `SELECT * FROM employees WHERE join_date < ? AND ${unposted("'payroll_opening:' || employees.id")} ORDER BY created_at`, [c.start],
  )) {
    if (c.full()) break;
    const fils = gratuityAtStart(c.db, e);
    if (fils <= 0) continue;
    if (c.post({
      date: c.start, narration: `Gratuity brought forward: ${e.name}`, sourceType: "payroll_opening", sourceId: e.id, postKey: `payroll_opening:${e.id}`, userId: null,
      lines: [debit(A.opening_clearing.id, fils), credit(A.gratuity_provision.id, fils)],
    })) n++;
  }
  return n;
}
/**
 * An approved payroll, dated its month end: salaries and allowances (less unpaid leave, split between them pro rata),
 * extras, a bonus paid through WPS and the gratuity put aside, against salaries payable, advances taken back and the
 * gratuity provision.
 */
export function postPayrollRuns(c: PostCtx): number {
  let n = 0;
  for (const r of c.db.all<{ id: string; month: string; snapshot_json: string }>(
    `SELECT r.id, r.month, a.snapshot_json FROM payroll_approvals a JOIN payroll_runs r ON r.id = a.run_id
     WHERE r.month || '-31' >= ? AND ${unposted("'payroll_run:' || r.id")} ORDER BY r.month`,
    [c.start],
  )) {
    if (c.full()) break;
    const lines = (JSON.parse(r.snapshot_json) as Snapshot).lines;
    let salaries = 0, allowances = 0, bonus = 0, payable = 0, advances = 0, gratuity = 0;
    for (const l of lines) {
      const gross = l.basicFils + l.allowancesFils;
      const fromBasic = gross ? Math.round((l.unpaidDeductionFils * l.basicFils) / gross) : 0;
      salaries += l.basicFils - fromBasic + l.extrasFils;
      allowances += l.allowancesFils - (l.unpaidDeductionFils - fromBasic);
      const wpsBonus = l.bonusInWps ? l.bonusFils : 0;
      bonus += wpsBonus;
      payable += l.netFils + wpsBonus;
      advances += l.advanceRepaymentFils;
      gratuity += l.gratuityFils;
    }
    const [y, m] = r.month.split("-").map(Number) as [number, number];
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const name = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${r.month}-01T00:00:00Z`));
    if (c.post({
      date: monthEnd, narration: `Payroll ${name}`, sourceType: "payroll_run", sourceId: r.id, postKey: `payroll_run:${r.id}`, userId: null,
      lines: [
        debit(A.salaries.id, salaries), debit(A.allowances.id, allowances), debit(A.staff_bonus.id, bonus), debit(A.gratuity_expense.id, gratuity),
        credit(A.salaries_payable.id, payable), credit(A.staff_advances.id, advances), credit(A.gratuity_provision.id, gratuity),
      ],
    })) n++;
  }
  return n;
}

/** Salaries paid through WPS (Dr Salaries payable / Cr the bank), and cash bonuses handed out (Dr Staff bonus / Cr cash). */
export function postPayrollPayments(c: PostCtx): number {
  let n = 0;
  for (const p of c.db.all<{ id: string; run_id: string; kind: "wps" | "bonus"; paid_on: string; account_id: string; amount_fils: number; month: string }>(
    `SELECT p.*, r.month FROM payroll_payments p JOIN payroll_runs r ON r.id = p.run_id
     WHERE p.paid_on >= ? AND ${unposted("CASE p.kind WHEN 'wps' THEN 'wps_paid:' ELSE 'bonus_paid:' END || p.run_id")} ORDER BY p.created_at`,
    [c.start],
  )) {
    if (c.full()) break;
    const wps = p.kind === "wps";
    if (c.post({
      date: p.paid_on, narration: wps ? `Salaries for ${p.month} paid (WPS)` : `Cash bonus for ${p.month}`, sourceType: wps ? "wps_paid" : "bonus_paid", sourceId: p.run_id,
      postKey: `${wps ? "wps_paid" : "bonus_paid"}:${p.run_id}`, userId: null,
      lines: [debit(wps ? A.salaries_payable.id : A.staff_bonus.id, p.amount_fils), credit(p.account_id, p.amount_fils)],
    })) n++;
  }
  return n;
}

/**
 * An approved final settlement, dated the last day: salary (basic and allowances), leave pay (or leave taken ahead, a
 * credit), the gratuity provision released and the difference to gratuity expense, advances taken back, and what's
 * owed to the leaver in salaries payable. Paying it: Dr Salaries payable / Cr the bank or cash.
 */
export function postSettlements(c: PostCtx): number {
  let n = 0;
  for (const s of c.db.all<{ id: string; snapshot_json: string }>(
    `SELECT f.id, a.snapshot_json FROM settlement_approvals a JOIN final_settlements f ON f.id = a.settlement_id WHERE ${unposted("'final_settlement:' || f.id")}`,
  )) {
    if (c.full()) break;
    const x = JSON.parse(s.snapshot_json) as SettlementSnapshot;
    const amt = (k: string) => x.items.find((i) => i.key === k)?.amountFils ?? 0;
    const salary = amt("salary");
    const forgiven = (x.advancesOwedFils ?? -amt("advances")) + amt("advances");
    // A leaver from before the books: what they were owed was part of the opening position (opening clearing), posted at the start.
    const before = x.lastDay < c.start;
    if (before && c.post({
      date: c.start, narration: `Final settlement: ${x.name} (left ${x.lastDay}, before the books)`, sourceType: "final_settlement", sourceId: s.id,
      postKey: `final_settlement:${s.id}`, userId: null,
      lines: [
        debit(A.gratuity_provision.id, x.gratuityHeldFils),
        debit(A.opening_clearing.id, salary + amt("leave") + amt("gratuity") - x.gratuityHeldFils + forgiven),
        credit(A.staff_advances.id, x.advancesOwedFils ?? -amt("advances")), credit(A.salaries_payable.id, x.totalFils),
      ],
    })) { n++; continue; }
    if (before) continue;
    if (c.post({
      date: x.lastDay, narration: `Final settlement: ${x.name}`, sourceType: "final_settlement", sourceId: s.id, postKey: `final_settlement:${s.id}`, userId: null,
      lines: [
        debit(A.salaries.id, x.salaryBasicFils), debit(A.allowances.id, salary - x.salaryBasicFils), debit(A.salaries.id, amt("leave")),
        debit(A.gratuity_provision.id, x.gratuityHeldFils), debit(A.gratuity_expense.id, amt("gratuity") - x.gratuityHeldFils),
        // All advances still owed are cleared: what wasn't taken back is forgiven, a cost of pay.
        debit(A.salaries.id, forgiven),
        credit(A.staff_advances.id, x.advancesOwedFils ?? -amt("advances")), credit(A.salaries_payable.id, x.totalFils),
      ],
    })) n++;
  }
  for (const p of c.db.all<{ settlement_id: string; paid_on: string; account_id: string; amount_fils: number; name: string }>(
    `SELECT p.settlement_id, p.paid_on, p.account_id, p.amount_fils, e.name FROM settlement_payments p JOIN final_settlements f ON f.id = p.settlement_id
     JOIN employees e ON e.id = f.employee_id WHERE p.paid_on >= ? AND ${unposted("'settlement_paid:' || p.settlement_id")} ORDER BY p.created_at`,
    [c.start],
  )) {
    if (c.full()) break;
    if (c.post({
      date: p.paid_on, narration: `Final settlement paid: ${p.name}`, sourceType: "settlement_paid", sourceId: p.settlement_id, postKey: `settlement_paid:${p.settlement_id}`,
      userId: null, lines: [debit(A.salaries_payable.id, p.amount_fils), credit(p.account_id, p.amount_fils)],
    })) n++;
  }
  return n;
}

const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};

/** Depreciation posted so far per asset (with what was taken before the books), in one query. */
function postedByAsset(c: PostCtx, assets: AssetRow[]): Map<string, number> {
  const posted = new Map(assets.map((a) => [a.id, a.opening_depreciation_fils]));
  for (const r of c.db.all<{ asset_id: string; v: number }>(
    `SELECT l.asset_id, SUM(l.credit_fils - l.debit_fils) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.source_type = 'depreciation' AND l.account_id = ? AND l.asset_id IS NOT NULL GROUP BY l.asset_id`, [A.accumulated_depreciation.id])) {
    if (posted.has(r.asset_id)) posted.set(r.asset_id, posted.get(r.asset_id)! + r.v);
  }
  return posted;
}

/**
 * What an asset should stand at through `month`: its straight-line total, never below the depreciation taken before
 * the books (that's in the opening balances, the app doesn't reverse it).
 */
const targetThrough = (r: AssetRow, month: string) => Math.max(dueThrough(r, month), r.opening_depreciation_fils);

/** Dr Depreciation / Cr Accumulated depreciation for each asset short of its target (a negative difference reverses). */
function depreciationLines(assets: AssetRow[], posted: Map<string, number>, month: string): PostLine[] {
  return assets.flatMap((r) => {
    const diff = targetThrough(r, month) - (posted.get(r.id) ?? 0);
    return diff ? [debit(A.depreciation.id, diff, { assetId: r.id, memo: r.name }), credit(A.accumulated_depreciation.id, diff, { assetId: r.id, memo: r.name })] : [];
  });
}

/** Assets the books depreciate: not sold before the books started, and not yet taken off the books by a disposal entry. */
const assetsInBooks = (c: PostCtx) =>
  c.db.all<AssetRow>(
    `SELECT * FROM fixed_assets f WHERE (f.disposed_on IS NULL OR f.disposed_on >= ?) AND ${unposted("'asset_disposal:' || f.id")} ORDER BY in_use_from, created_at`,
    [c.start],
  );

/**
 * Monthly depreciation, straight line. Months after the last one posted each get one entry when they end, for every
 * asset due; earlier months are never revisited. Assets added or changed after their months were posted catch up in an
 * extra entry for the latest ended month.
 */
export function postDepreciation(c: PostCtx): number {
  const assets = assetsInBooks(c);
  if (!assets.length) return 0;
  // The month before this one: the latest that has ended.
  const [ty, tm] = dubaiDate(new Date().toISOString()).split("-").map(Number) as [number, number];
  const lastEnded = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
  const startMonth = c.start.slice(0, 7);
  if (lastEnded < startMonth) return 0;
  const months = new Map(c.db.all<{ month: string; n: number }>(
    `SELECT source_id AS month, COUNT(*) AS n FROM journal_entries WHERE source_type = 'depreciation' AND post_key LIKE 'depreciation:%' GROUP BY source_id`,
  ).map((r) => [r.month, r.n]));
  const lastPosted = [...months.keys()].sort().at(-1) ?? null;
  const earliest = assets.reduce((m, a) => (a.in_use_from.slice(0, 7) < m ? a.in_use_from.slice(0, 7) : m), lastEnded);
  const first = lastPosted ? nextMonth(lastPosted) : earliest < startMonth ? startMonth : earliest;
  const posted = postedByAsset(c, assets);
  let n = 0;
  const postMonth = (month: string, k: number) => {
    const lines = depreciationLines(assets, posted, month);
    if (!lines.length) return;
    const name = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
    if (c.post({
      date: monthEnd(month), narration: k ? `Depreciation ${name} (catch-up)` : `Depreciation ${name}`, sourceType: "depreciation", sourceId: month,
      postKey: `depreciation:${month}:${k + 1}`, userId: null, lines,
    })) {
      n++;
      for (const a of assets) posted.set(a.id, targetThrough(a, month));
    }
  };
  for (let month = first; month <= lastEnded && !c.full(); month = nextMonth(month)) postMonth(month, months.get(month) ?? 0);
  // Catch-ups (an asset added or changed after its months were posted) go in one entry for the latest ended month.
  if (lastPosted && first > lastEnded && !c.full()) postMonth(lastEnded, months.get(lastEnded) ?? 0);
  return n;
}

/**
 * An asset sold or written off: depreciation is brought up to the disposal month, then its cost and accumulated
 * depreciation leave the books against the proceeds, with the gain or loss.
 */
export function postDisposals(c: PostCtx): number {
  let n = 0;
  // A sale before the books started was never in them (nor its cash): nothing to post.
  for (const r of c.db.all<AssetRow>(`SELECT * FROM fixed_assets WHERE disposed_on IS NOT NULL AND disposed_on >= ? AND ${unposted("'asset_disposal:' || fixed_assets.id")}`, [c.start])) {
    if (c.full()) break;
    const date = r.disposed_on!;
    const catchUp = depreciationLines([r], postedByAsset(c, [r]), r.disposed_on!.slice(0, 7));
    if (catchUp.length) {
      const ok = c.post({ date, narration: `Depreciation to disposal: ${r.name}`, sourceType: "depreciation", sourceId: r.id, postKey: `depreciation_disposal:${r.id}`, userId: null, lines: catchUp });
      // Without its depreciation to date the disposal would leave a balance on accumulated depreciation: wait.
      if (!ok && !c.db.get("SELECT 1 FROM journal_entries WHERE post_key = ?", [`depreciation_disposal:${r.id}`])) continue;
    }
    const accumulated = postedDepreciation(c.db, r);
    const proceeds = r.proceeds_fils ?? 0;
    const gain = proceeds - (r.cost_fils - accumulated);
    if (c.post({
      date, narration: `${proceeds ? "Sold" : "Written off"}: ${r.name}`, sourceType: "asset_disposal", sourceId: r.id, postKey: `asset_disposal:${r.id}`, userId: null,
      lines: [
        debit(A.accumulated_depreciation.id, accumulated, { assetId: r.id }), ...(proceeds ? [debit(r.proceeds_account_id!, proceeds, { assetId: r.id })] : []),
        credit(r.account_id, r.cost_fils, { assetId: r.id }),
        gain >= 0 ? credit(A.disposal_gain.id, gain, { assetId: r.id }) : debit(A.disposal_loss.id, -gain, { assetId: r.id }),
      ],
    })) n++;
  }
  return n;
}

