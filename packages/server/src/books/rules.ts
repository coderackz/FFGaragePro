import { SYSTEM_ACCOUNTS as A, type Settings } from "@ffgp/shared";
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

