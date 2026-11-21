import { EMIRATE_BOX, EMIRATE_NAMES, SYSTEM_ACCOUNTS as A, VAT_BOXES, VAT_RATE_BP, VAT_TAG_INFO, type Emirate, type VatBoxKey, type VatTag } from "@ffgp/shared";
import type { Db } from "../db";
import { getSettings } from "../settings";

export interface VatRow {
  entryId: string; number: string; date: string; narration: string; amountFils: number; vatFils: number; adjustmentFils: number;
  /** Set when the entry belongs to an earlier date that was locked (or filed) when it reached the books. */
  originalDate: string | null;
}
/** VAT no box counts, per entry and VAT account. */
export interface VatLooseRow extends VatRow { account: "output" | "input" }
/** "1" appears only while the garage's emirate isn't set: box 1's figures, waiting for their row. */
export type VatFigureKey = VatBoxKey | "1";
export interface VatBox { key: VatFigureKey; label: string; amountFils: number; vatFils: number; adjustmentFils: number; rows: VatRow[] }
export interface VatAdvance { customerId: string; name: string; creditFils: number; vatInsideFils: number }
export interface VatFigures {
  from: string; to: string; emirate: Emirate | null;
  /** The later of `from` and the day the books start: nothing before the books can be counted. */
  countedFrom: string;
  boxes: VatBox[];
  /** Box 12 (total tax due), box 13 (recoverable tax), box 14 (payable; negative = refundable). */
  dueFils: number; recoverableFils: number; payableFils: number;
  /** Entries in the period that move Output or Input VAT but that no box counts (untagged journals and the like). */
  notInBox: VatLooseRow[];
  /** Customer credit unused at the period end: VAT may be due on these advances. */
  advances: VatAdvance[];
}

const SALES_DOCS = new Set(["invoice", "credit_note"]);
const EXPENSE_DOCS = new Set(["goods_receipt", "supplier_bill", "bill_cancel", "expense", "supplier_return"]);

interface LineRow {
  entry_id: string; number: string; date: string; original_date: string | null; narration: string; source_type: string; source_id: string | null;
  account_id: string; type: string; debit_fils: number; credit_fils: number; vat_box: VatTag | null;
}

/**
 * The VAT201 figures for [from, to], read from the posted entries. VAT always comes from the VAT accounts; the net of
 * box 1 from the income lines of invoices and credit notes, the net of box 9 from the VAT-bearing part of each goods
 * receipt, bill and expense. Manual journal lines tagged with a box fill the rest. Settlements (vat_return) aren't counted.
 */
export function vatFigures(db: Db, from: string, to: string): VatFigures {
  const settings = getSettings(db);
  const emirate = settings.garage.emirate;
  const startDate = settings.books.startDate;
  const countedFrom = startDate && startDate > from ? startDate : from;
  const box1: VatFigureKey = emirate ? EMIRATE_BOX[emirate] : "1";

  const boxes = new Map<VatFigureKey, VatBox>();
  for (const b of VAT_BOXES) boxes.set(b.key, { key: b.key, label: b.label, amountFils: 0, vatFils: 0, adjustmentFils: 0, rows: [] });
  if (!emirate) boxes.set("1", { key: "1", label: "Standard rated supplies (choose the garage's emirate)", amountFils: 0, vatFils: 0, adjustmentFils: 0, rows: [] });
  const notInBox = new Map<string, VatLooseRow>();

  const lines = db.all<LineRow>(
    `SELECT e.id AS entry_id, e.number, e.date, e.original_date, e.narration, e.source_type, e.source_id, l.account_id, a.type, l.debit_fils, l.credit_fils, l.vat_box
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.date >= ? AND e.date <= ? AND e.source_type <> 'vat_return' ORDER BY e.date, e.seq, l.position`,
    [countedFrom, to],
  );
  const add = (key: VatFigureKey, l: LineRow, part: { amountFils?: number; vatFils?: number; adjustmentFils?: number }) => {
    const b = boxes.get(key)!;
    let row = b.rows.find((r) => r.entryId === l.entry_id);
    if (!row) {
      row = { entryId: l.entry_id, number: l.number, date: l.date, narration: l.narration, amountFils: 0, vatFils: 0, adjustmentFils: 0, originalDate: l.original_date };
      b.rows.push(row);
    }
    for (const k of ["amountFils", "vatFils", "adjustmentFils"] as const) {
      row[k] += part[k] ?? 0;
      b[k] += part[k] ?? 0;
    }
  };

  // The net of box 9 from each document: only what carries VAT.
  const expenseNet = (sourceType: string, id: string | null): number => {
    if (!id) return 0;
    if (sourceType === "goods_receipt") {
      const g = db.get<{ net_fils: number; vat_fils: number }>("SELECT net_fils, vat_fils FROM goods_receipts WHERE id = ?", [id]);
      return g && g.vat_fils !== 0 ? g.net_fils : 0;
    }
    if (sourceType === "supplier_return") {
      // A debit note takes its VAT-bearing net off box 9.
      const r = db.get<{ net_fils: number; vat_fils: number }>("SELECT net_fils, vat_fils FROM supplier_returns WHERE id = ?", [id]);
      return r && r.vat_fils !== 0 ? -r.net_fils : 0;
    }
    if (sourceType === "expense") {
      const x = db.get<{ net_fils: number; vat: string }>("SELECT net_fils, vat FROM expenses WHERE id = ?", [id]);
      return x?.vat === "standard" ? x.net_fils : 0;
    }
    const net = db.get<{ n: number | null }>("SELECT SUM(net_fils) AS n FROM supplier_bill_lines WHERE bill_id = ? AND vat = 'standard'", [id])!.n ?? 0;
    return sourceType === "bill_cancel" ? -net : net;
  };
  const counted = new Set<string>();

  for (const l of lines) {
    const credit = l.credit_fils - l.debit_fils;
    const isOutput = l.account_id === A.vat_output.id;
    const isInput = l.account_id === A.vat_input.id;
    if (l.vat_box) {
      const info = VAT_TAG_INFO[l.vat_box];
      const signed = info.side === "sales" ? credit : -credit;
      const key: VatFigureKey = l.vat_box === "1" || l.vat_box === "1adj" ? box1 : l.vat_box === "9adj" ? "9" : (l.vat_box as VatFigureKey);
      if (isOutput || isInput) add(key, l, info.vatOnly ? { adjustmentFils: signed } : { vatFils: signed });
      else add(key, l, { amountFils: signed });
      continue;
    }
    if (SALES_DOCS.has(l.source_type)) {
      if (isOutput) add(box1, l, { vatFils: credit });
      else if (l.type === "income") add(box1, l, { amountFils: credit });
      continue;
    }
    if (EXPENSE_DOCS.has(l.source_type)) {
      if (isInput) add("9", l, { vatFils: -credit });
      if (!counted.has(l.entry_id)) {
        counted.add(l.entry_id);
        const net = expenseNet(l.source_type, l.source_id);
        if (net) add("9", l, { amountFils: net });
      }
      continue;
    }
    if (isOutput || isInput) {
      const account = isOutput ? "output" : "input";
      const key = `${l.entry_id}:${account}`;
      const row = notInBox.get(key) ?? {
        entryId: l.entry_id, number: l.number, date: l.date, narration: l.narration, amountFils: 0, vatFils: 0, adjustmentFils: 0, originalDate: l.original_date, account,
      };
      // Output VAT as VAT due (credit), Input VAT as VAT recoverable (debit).
      row.vatFils += isOutput ? credit : -credit;
      notInBox.set(key, row);
    }
  }
  // An expense document whose VAT was zero and net nothing to count leaves an empty row: drop those.
  for (const b of boxes.values()) b.rows = b.rows.filter((r) => r.amountFils || r.vatFils || r.adjustmentFils);

  const total = (key: VatFigureKey, keys: VatFigureKey[]) => {
    const t = boxes.get(key)!;
    for (const k of keys) {
      const b = boxes.get(k);
      if (!b) continue;
      t.amountFils += b.amountFils;
      t.vatFils += b.vatFils;
      t.adjustmentFils += b.adjustmentFils;
    }
  };
  total("8", ["1", "1a", "1b", "1c", "1d", "1e", "1f", "1g", "2", "3", "4", "5", "6", "7"]);
  total("11", ["9", "10"]);
  const b8 = boxes.get("8")!;
  const b11 = boxes.get("11")!;
  const dueFils = b8.vatFils + b8.adjustmentFils;
  const recoverableFils = b11.vatFils + b11.adjustmentFils;

  const advances = advancesAt(db, to);

  const ordered = [...(emirate ? [] : [boxes.get("1")!]), ...VAT_BOXES.map((b) => boxes.get(b.key)!)];
  if (emirate) ordered.find((b) => b.key === box1)!.label = `Standard rated supplies in ${EMIRATE_NAMES[emirate]}`;
  return {
    from, to, emirate, countedFrom, boxes: ordered,
    dueFils, recoverableFils, payableFils: dueFils - recoverableFils,
    notInBox: [...notInBox.values()].filter((r) => r.vatFils),
    advances,
  };
}

const D = (col: string) => `date(${col}, '+4 hours')`;

/**
 * Money customers paid beyond everything invoiced to them by `to` (and their opening balance): advances, on which VAT
 * may be due. Credit that comes from credit notes isn't money received, so it isn't counted. One query for all customers.
 */
function advancesAt(db: Db, to: string): VatAdvance[] {
  return db.all<{ id: string; name: string; opening: number; invoiced: number; credited: number; received: number }>(
    `SELECT c.id, c.name,
       CASE WHEN c.opening_balance_date IS NULL OR c.opening_balance_date <= :to THEN c.opening_balance_fils ELSE 0 END AS opening,
       COALESCE((SELECT SUM(gross_fils) FROM documents d WHERE d.customer_id = c.id AND d.type = 'invoice' AND d.status <> 'draft' AND ${D("d.issued_at")} <= :to), 0) AS invoiced,
       COALESCE((SELECT SUM(gross_fils) FROM documents d WHERE d.customer_id = c.id AND d.type = 'credit_note' AND d.status = 'issued' AND ${D("d.issued_at")} <= :to), 0) AS credited,
       COALESCE((SELECT SUM(amount_fils) FROM receipts r WHERE r.customer_id = c.id AND ${D("r.received_at")} <= :to), 0) AS received
     FROM customers c ORDER BY c.name COLLATE NOCASE`,
    { to },
  ).flatMap((c) => {
    const inCredit = -(c.opening + c.invoiced - c.credited - c.received);
    const paidAhead = c.received - c.invoiced - Math.max(c.opening, 0);
    const creditFils = Math.min(inCredit, paidAhead);
    if (creditFils <= 0) return [];
    return [{ customerId: c.id, name: c.name, creditFils, vatInsideFils: Math.round((creditFils * VAT_RATE_BP) / (10_000 + VAT_RATE_BP)) }];
  });
}

