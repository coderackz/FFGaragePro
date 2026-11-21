import { abcClasses, STOCK_AGE_BUCKETS, stockAgeBucket, suggestLevels, type StockAgeBucket } from "@ffgp/shared";
import type { Db } from "../db";

// Inventory v2, Part 3: what parts are used, what to order, and the stock reports. Read-only over the stock data.

const DAY = 86400000;
const since = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** Parts that are planned and reported: stocked, active, not kits. */
interface PlannedPart {
  id: string; part_no: string; name: string; unit: string; on_hand: number; avg_cost_fils: number; reorder_level: number; max_level: number;
  preferred_supplier_id: string | null; lead_time_days: number; category_id: string | null;
}
const plannedParts = (db: Db) =>
  db.all<PlannedPart>(
    `SELECT id, part_no, name, unit, on_hand, avg_cost_fils, reorder_level, max_level, preferred_supplier_id, lead_time_days, category_id
     FROM parts WHERE stocked = 1 AND active = 1 AND is_kit = 0 ORDER BY part_no COLLATE NOCASE`,
  );

/**
 * What each part was used since `from`: stock that left for jobs and invoices, less what credit notes put back.
 * Quantity and value (at the cost it left at).
 */
export function usageSince(db: Db, from: string): Map<string, { qty: number; valueFils: number; lastUsed: string | null }> {
  const rows = db.all<{ part_id: string; qty: number; value: number; last: string | null }>(
    `SELECT m.part_id, -SUM(m.qty) AS qty, -SUM(m.qty * m.unit_cost_fils) AS value, MAX(CASE WHEN m.qty < 0 THEN m.created_at END) AS last
     FROM stock_movements m LEFT JOIN documents d ON d.id = m.document_id
     WHERE m.created_at >= ? AND (m.reason IN ('job', 'invoice') OR (m.reason = 'adjust' AND d.type = 'credit_note'))
     GROUP BY m.part_id`,
    [from],
  );
  return new Map(rows.map((r) => [r.part_id, { qty: Math.round(r.qty * 1000) / 1000 + 0, valueFils: Math.round(r.value), lastUsed: r.last }]));
}

/** The last time each part was used for a job or invoice (ever). */
const lastUsed = (db: Db) =>
  new Map(db.all<{ part_id: string; last: string }>("SELECT part_id, MAX(created_at) AS last FROM stock_movements WHERE reason IN ('job', 'invoice') AND qty < 0 GROUP BY part_id").map((r) => [r.part_id, r.last]));

/**
 * The last time stock of each part arrived: deliveries, opening stock, and stock added by hand (a count, a warranty
 * replacement). Not parts coming back from jobs or invoices.
 */
const lastArrived = (db: Db) =>
  new Map(db.all<{ part_id: string; last: string }>(
    "SELECT part_id, MAX(created_at) AS last FROM stock_movements WHERE qty > 0 AND reason IN ('receive', 'opening', 'adjust') AND supplier_return_id IS NULL GROUP BY part_id",
  ).map((r) => [r.part_id, r.last]));

/** Stock still to come on purchase orders that aren't cancelled (drafts count: they're about to be sent). */
export function onOrder(db: Db): Map<string, number> {
  const rows = db.all<{ part_id: string; q: number }>(
    `SELECT pl.part_id, SUM(MAX(pl.qty - pl.received_qty, 0)) AS q FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
     WHERE pl.part_id IS NOT NULL AND po.status IN ('draft', 'sent', 'part_received') GROUP BY pl.part_id`,
  );
  return new Map(rows.map((r) => [r.part_id, r.q]));
}

/** The supplier a part was last ordered from, and at what price (not cancelled POs). */
function lastBought(db: Db, partId: string, supplierId?: string | null) {
  return db.get<{ supplier_id: string; unit_cost_fils: number }>(
    `SELECT po.supplier_id, pl.unit_cost_fils FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
     WHERE pl.part_id = ? AND (? IS NULL OR po.supplier_id = ?) AND pl.unit_cost_fils > 0
     ORDER BY CASE WHEN po.status = 'cancelled' THEN 1 ELSE 0 END, po.created_at DESC, pl.rowid DESC LIMIT 1`,
    [partId, supplierId ?? null, supplierId ?? null],
  ) ?? null;
}

/** Each planned part's usage over 90 days, its suggested and current levels. */
export function levels(db: Db) {
  const used = usageSince(db, since(90));
  return plannedParts(db).map((p) => {
    const usage90 = used.get(p.id)?.qty ?? 0;
    const s = suggestLevels(usage90, p.lead_time_days);
    return {
      partId: p.id, partNo: p.part_no, name: p.name, unit: p.unit, onHand: p.on_hand, usage90, leadTimeDays: p.lead_time_days,
      reorderLevel: p.reorder_level, maxLevel: p.max_level, suggestedMin: s.min, suggestedMax: s.max, preferredSupplierId: p.preferred_supplier_id,
    };
  });
}

/**
 * What to order: parts at or below their reorder level counting stock on order, topped up to their maximum (or the
 * reorder level when there's no maximum), grouped by the preferred supplier, else the one last bought from.
 */
export function suggestedOrders(db: Db, showCost: boolean) {
  const ordered = onOrder(db);
  const groups = new Map<string, { supplierId: string | null; supplierName: string; lines: object[] }>();
  for (const p of plannedParts(db)) {
    if (p.reorder_level <= 0 && p.max_level <= 0) continue;
    const coming = ordered.get(p.id) ?? 0;
    const have = p.on_hand + coming;
    if (have > p.reorder_level) continue;
    const target = Math.max(p.max_level, p.reorder_level);
    const qty = Math.ceil(target - have - 1e-9);
    if (qty <= 0) continue;
    const last = lastBought(db, p.id);
    const supplierId = p.preferred_supplier_id ?? last?.supplier_id ?? null;
    const price = (supplierId ? lastBought(db, p.id, supplierId)?.unit_cost_fils : null) ?? p.avg_cost_fils;
    const key = supplierId ?? "";
    if (!groups.has(key)) {
      const name = supplierId ? db.get<{ name: string }>("SELECT name FROM suppliers WHERE id = ?", [supplierId])?.name ?? "?" : "No supplier yet";
      groups.set(key, { supplierId, supplierName: name, lines: [] });
    }
    groups.get(key)!.lines.push({
      partId: p.id, partNo: p.part_no, name: p.name, unit: p.unit, qty, onHand: p.on_hand, onOrder: coming, reorderLevel: p.reorder_level, maxLevel: p.max_level,
      ...(showCost ? { unitCostFils: price } : {}),
    });
  }
  // Suppliers in name order; parts without one last.
  return [...groups.values()].sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || a.supplierName.localeCompare(b.supplierName));
}

/** The price a suggested line is ordered at: the supplier's last price for the part, else its average cost. */
export const orderPrice = (db: Db, partId: string, supplierId: string) =>
  lastBought(db, partId, supplierId)?.unit_cost_fils ?? db.get<{ c: number }>("SELECT avg_cost_fils AS c FROM parts WHERE id = ?", [partId])?.c ?? 0;

const stockValue = (p: PlannedPart) => Math.round(Math.max(0, p.on_hand) * p.avg_cost_fils);

/** ABC by usage value over `months`. */
export function abcReport(db: Db, months = 12) {
  const used = usageSince(db, since(months * 30.4375));
  const parts = plannedParts(db).map((p) => ({ p, u: used.get(p.id) ?? { qty: 0, valueFils: 0 } }));
  const classes = abcClasses(parts.map(({ p, u }) => ({ id: p.id, value: u.valueFils })));
  const total = parts.reduce((s, x) => s + Math.max(0, x.u.valueFils), 0);
  return {
    months, totalFils: total,
    parts: parts
      .map(({ p, u }) => ({ partId: p.id, partNo: p.part_no, name: p.name, usageQty: u.qty, usageValueFils: u.valueFils, sharePct: total ? Math.round((u.valueFils / total) * 1000) / 10 : 0, abc: classes.get(p.id)! }))
      .sort((a, b) => b.usageValueFils - a.usageValueFils || a.partNo.localeCompare(b.partNo)),
  };
}

/** Fast and slow movers: usage over `days`, most used first, with days of stock left at that rate. */
export function moversReport(db: Db, days = 90) {
  const used = usageSince(db, since(days));
  return {
    days,
    parts: plannedParts(db)
      .map((p) => {
        const q = used.get(p.id)?.qty ?? 0;
        return { partId: p.id, partNo: p.part_no, name: p.name, unit: p.unit, onHand: p.on_hand, usageQty: q, daysOfStock: q > 0 ? Math.round((Math.max(0, p.on_hand) / q) * days) : null };
      })
      .sort((a, b) => b.usageQty - a.usageQty || a.partNo.localeCompare(b.partNo)),
  };
}

/**
 * Dead stock: parts with stock not used for a job or invoice in `months`, and what they're worth. Stock that only
 * arrived within the period isn't dead yet.
 */
export function deadStockReport(db: Db, months = 6) {
  const cutoff = since(months * 30.4375);
  const last = lastUsed(db);
  const arrived = lastArrived(db);
  const parts = plannedParts(db)
    .filter((p) => p.on_hand > 0 && (last.get(p.id) ?? "") < cutoff && (arrived.get(p.id) ?? "") < cutoff)
    .map((p) => ({ partId: p.id, partNo: p.part_no, name: p.name, onHand: p.on_hand, lastUsed: last.get(p.id) ?? null, valueFils: stockValue(p) }));
  return { months, parts, totalFils: parts.reduce((s, p) => s + p.valueFils, 0) };
}

/** Stock value by category (the total is the stock value). */
export function valuationReport(db: Db) {
  const byCat = new Map<string | null, { qty: number; valueFils: number; parts: number }>();
  for (const p of plannedParts(db)) {
    if (p.on_hand <= 0) continue;
    const c = byCat.get(p.category_id) ?? { qty: 0, valueFils: 0, parts: 0 };
    c.qty = Math.round((c.qty + p.on_hand) * 1000) / 1000;
    c.valueFils += stockValue(p);
    c.parts += 1;
    byCat.set(p.category_id, c);
  }
  const name = (id: string | null) => (id ? db.get<{ name: string }>("SELECT name FROM part_categories WHERE id = ?", [id])?.name ?? "?" : "No category");
  const categories = [...byCat.entries()]
    .map(([id, c]) => ({ categoryId: id, name: name(id), ...c }))
    .sort((a, b) => (a.categoryId ? 0 : 1) - (b.categoryId ? 0 : 1) || a.name.localeCompare(b.name));
  return { categories, totalFils: categories.reduce((s, c) => s + c.valueFils, 0) };
}

/** Stock aging by the last time each part arrived (deliveries, opening stock, or stock added by hand). */
export function agingReport(db: Db) {
  const received = lastArrived(db);
  const buckets = Object.fromEntries(STOCK_AGE_BUCKETS.map((b) => [b, 0])) as Record<StockAgeBucket, number>;
  const parts = plannedParts(db)
    .filter((p) => p.on_hand > 0)
    .map((p) => {
      const last = received.get(p.id) ?? null;
      const days = last ? Math.floor((Date.now() - Date.parse(last)) / DAY) : null;
      const bucket = stockAgeBucket(days ?? 9999);
      buckets[bucket] += stockValue(p);
      return { partId: p.id, partNo: p.part_no, name: p.name, onHand: p.on_hand, lastReceived: last, days, bucket, valueFils: stockValue(p) };
    })
    .sort((a, b) => (b.days ?? 1e9) - (a.days ?? 1e9));
  return { parts, buckets };
}
