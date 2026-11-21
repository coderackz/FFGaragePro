import { oldestFirst, parseDot, warrantyEnds, type Tracking } from "@ffgp/shared";
import { newId, now, type Db } from "./db";
import { badRequest, conflict } from "./errors";

// Tyres tracked by DOT and batteries by serial (inventory v2, Part 2): one `stock_units` row per unit. Units are a
// record of *which* tyre or battery, kept in step with the shelf count; stock itself only moves in stock.ts.

export interface UnitRow {
  id: string; part_id: string; code: string; unit_cost_fils: number; po_line_id: string | null; received_at: string;
  status: "in_stock" | "fitted" | "returned" | "written_off"; document_id: string | null; fitted_at: string | null; warranty_ends: string | null;
  created_at: string; updated_at: string;
}
interface TrackedPart { id: string; part_no: string; tracking: Tracking; warranty_months: number; stocked: number }

const getPart = (db: Db, id: string) => db.get<TrackedPart>("SELECT id, part_no, tracking, warranty_months, stocked FROM parts WHERE id = ?", [id]);
const getUnit = (db: Db, id: string) => db.get<UnitRow>("SELECT * FROM stock_units WHERE id = ?", [id]);
const isTracked = (p: TrackedPart | undefined | null): p is TrackedPart => !!p && !!p.stocked && p.tracking !== "none";
const today = () => now().slice(0, 10);
const what = (p: TrackedPart, n = 2) => (p.tracking === "dot" ? (n === 1 ? "DOT code" : "DOT codes") : n === 1 ? "serial number" : "serial numbers");

/** A unit as the screens show it; its cost only for those who may see costs. */
export function unitOut(db: Db, u: UnitRow, showCost: boolean) {
  const doc = u.document_id ? db.get<{ number: string | null; type: string }>("SELECT number, type FROM documents WHERE id = ?", [u.document_id]) : null;
  return {
    id: u.id, partId: u.part_id, code: u.code, status: u.status, receivedAt: u.received_at, fittedAt: u.fitted_at, warrantyEnds: u.warranty_ends,
    documentId: u.document_id, documentNumber: doc?.number ?? null,
    ...(showCost ? { unitCostFils: u.unit_cost_fils } : {}),
  };
}

/** A part's units with a status, oldest DOT (or delivery) first. */
export function unitsOf(db: Db, partId: string, status: string): UnitRow[] {
  const rows = db.all<UnitRow>("SELECT * FROM stock_units WHERE part_id = ? AND status = ?", [partId, status]);
  return oldestFirst(rows.map((r) => ({ ...r, receivedAt: r.received_at })), today());
}

/**
 * Checks the codes for `qty` units of a tracked part coming in (a delivery or opening stock) and returns them as
 * stored: DOTs as "WWYY", serials in capitals. A part that isn't tracked takes none.
 */
export function checkIncomingCodes(db: Db, partId: string, qty: number, codes: string[], label: string, seen: Set<string> = new Set()): string[] {
  const p = getPart(db, partId);
  if (!isTracked(p)) {
    if (codes.length) throw badRequest(`${label}: this part isn't tracked one by one`);
    return [];
  }
  if (!Number.isInteger(qty)) throw badRequest(`${label}: tyres and batteries come in whole units`);
  if (codes.length !== qty) throw badRequest(`${label}: enter ${qty} ${what(p, qty)}, one for each`);
  if (p.tracking === "dot") {
    return codes.map((c) => {
      const d = parseDot(c, today());
      if (!d) throw badRequest(`${label}: "${c.trim()}" isn't a DOT code (week and year, like 2524)`);
      return d.code;
    });
  }
  // `seen`: serials already on other lines of the same delivery.
  const serials = codes.map((c) => c.trim().toUpperCase());
  const twice = serials.find((s, i) => serials.indexOf(s) !== i || seen.has(`${partId}:${s}`));
  if (twice) throw badRequest(`${label}: ${twice} twice`);
  for (const s of serials) seen.add(`${partId}:${s}`);
  for (const s of serials) {
    const held = db.get("SELECT 1 FROM stock_units WHERE part_id = ? AND code = ? COLLATE NOCASE AND status IN ('in_stock','fitted')", [partId, s]);
    if (held) throw conflict(`${label}: ${s} is already in stock or fitted`);
  }
  return serials;
}

/**
 * Tyres and batteries going back to the supplier: the units chosen (exactly `qty`, on the shelf) become `returned`.
 * A part that isn't tracked takes none.
 */
export function returnUnitsToSupplier(db: Db, partId: string, qty: number, unitIds: string[]): void {
  const p = getPart(db, partId);
  if (!isTracked(p)) {
    if (unitIds.length) throw badRequest("This part isn't tracked one by one");
    return;
  }
  if (!Number.isInteger(qty)) throw badRequest(`${p.part_no}: tyres and batteries go back in whole units`);
  if (unitIds.length !== qty || new Set(unitIds).size !== qty) throw badRequest(`${p.part_no}: choose which ${qty === 1 ? "one goes" : `${qty} go`} back`);
  const t = now();
  for (const id of unitIds) {
    const u = getUnit(db, id);
    if (!u || u.part_id !== partId || u.status !== "in_stock") throw badRequest(`${p.part_no}: that one isn't on the shelf`);
    db.run("UPDATE stock_units SET status = 'returned', updated_at = ? WHERE id = ?", [t, id]);
  }
}

/** Puts checked codes on the shelf as units (call inside db.tx). */
export function addUnits(db: Db, partId: string, codes: string[], unitCostFils: number, poLineId: string | null): void {
  const t = now();
  for (const code of codes) {
    db.run(
      `INSERT INTO stock_units (id, part_id, code, unit_cost_fils, po_line_id, received_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_stock', ?, ?)`,
      [newId(), partId, code, unitCostFils, poLineId, t, t, t],
    );
  }
}

/**
 * Stock going down by `qty` on a tracked part: the units named go out as written off. Without names it's allowed
 * only while the units left still fit in the count (stock from before tracking had no units).
 */
export function writeOffUnits(db: Db, partId: string, qty: number, unitIds: string[], onHandAfter: number): void {
  const p = getPart(db, partId);
  if (!isTracked(p)) {
    if (unitIds.length) throw badRequest("This part isn't tracked one by one");
    return;
  }
  if (!unitIds.length) {
    const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stock_units WHERE part_id = ? AND status = 'in_stock'", [partId])!.n;
    if (n > onHandAfter) throw badRequest(`Choose which ${qty === 1 ? "one" : qty} went (${what(p)})`);
    return;
  }
  if (unitIds.length !== qty || new Set(unitIds).size !== unitIds.length) throw badRequest(`Choose ${qty} of them`);
  const t = now();
  for (const id of unitIds) {
    const u = getUnit(db, id);
    if (!u || u.part_id !== partId || u.status !== "in_stock") throw badRequest("That one isn't on the shelf");
    db.run("UPDATE stock_units SET status = 'written_off', updated_at = ? WHERE id = ?", [t, id]);
  }
}

interface ChainDoc { id: string; type: string; status: string; source_id: string | null; number: string | null; created_at: string }
const getDoc = (db: Db, id: string) => db.get<ChainDoc>("SELECT id, type, status, source_id, number, created_at FROM documents WHERE id = ?", [id]);

/** The document and the job card it was made from: units fitted to either belong to this work. */
export function chainOf(db: Db, docId: string): string[] {
  const d = getDoc(db, docId);
  if (!d) return [docId];
  const src = d.source_id ? getDoc(db, d.source_id) : null;
  return src?.type === "jobcard" ? [d.id, src.id] : [d.id];
}

/**
 * Checks the units on a document's part lines before they're saved: only tracked parts, whole quantities, no more
 * units than the quantity, each a unit of that part, once, and on the shelf or already fitted to this work.
 * `chain`: the document and its job card (empty for a new document, plus its source when it has one).
 */
export function checkLineUnits(db: Db, chain: string[], lines: { kind: string; partId?: string | null; qty: number; suppliedBy?: string; unitIds?: string[] }[]): void {
  const seen = new Set<string>();
  for (const l of lines) {
    const ids = l.unitIds ?? [];
    const p = l.kind === "part" && l.partId ? getPart(db, l.partId) : null;
    if (!isTracked(p) || (l.suppliedBy ?? "garage") !== "garage") {
      if (ids.length) throw badRequest("Only tyres and batteries tracked one by one take units");
      continue;
    }
    if (!Number.isInteger(l.qty)) throw badRequest(`${p.part_no}: tyres and batteries come in whole units`);
    if (ids.length > l.qty) throw badRequest(`${p.part_no}: ${ids.length} chosen for a quantity of ${l.qty}`);
    for (const id of ids) {
      const u = getUnit(db, id);
      if (!u || u.part_id !== p.id) throw badRequest(`${p.part_no}: that unit isn't one of this part's`);
      if (seen.has(id)) throw badRequest(`${p.part_no}: ${u.code} is chosen twice`);
      seen.add(id);
      const ours = u.status === "fitted" && u.document_id !== null && chain.includes(u.document_id);
      if (u.status === "fitted" && !ours) {
        const on = u.document_id ? getDoc(db, u.document_id)?.number : null;
        throw conflict(`${p.part_no}: ${u.code} is already fitted${on ? ` on ${on}` : ""}`);
      }
      if (u.status !== "in_stock" && !ours) throw conflict(`${p.part_no}: ${u.code} isn't on the shelf`);
    }
  }
}

/** A unit another document holds, met while reconciling (two computers fitted it offline). */
export interface UnitConflict { unitId: string; code: string; partNo: string; loserDocId: string; winnerDocId: string }

const earlier = (a: ChainDoc, b: ChainDoc) => a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);

/** A document that lost a unit stops naming it, so it can be saved again with another one (and isn't told twice). */
function dropFromLines(db: Db, docId: string, unitId: string): void {
  for (const l of db.all<{ id: string; unit_ids_json: string }>("SELECT id, unit_ids_json FROM document_lines WHERE document_id = ? AND unit_ids_json LIKE ?", [docId, `%${unitId}%`])) {
    const ids = (JSON.parse(l.unit_ids_json || "[]") as string[]).filter((x) => x !== unitId);
    db.run("UPDATE document_lines SET unit_ids_json = ? WHERE id = ?", [JSON.stringify(ids), l.id]);
  }
}

/**
 * Makes the units fitted to a document's work exactly the ones its lines name: named units become fitted to it
 * (keeping the day first fitted, and the warranty from it), units it held that are no longer named go back on the
 * shelf. Units a credit note took back stay back. A unit another document already holds stays with the earlier of
 * the two; the later one stops naming it, and it's returned as a conflict (once). Deterministic, so every computer reaches the same answer. Runs where stock
 * does (reconcileDocumentStock: a job card when saved, an invoice when issued). Call inside db.tx.
 */
export function reconcileDocumentUnits(db: Db, docId: string): UnitConflict[] {
  const doc = getDoc(db, docId);
  if (!doc || doc.type === "estimate" || doc.type === "credit_note" || doc.status === "converted") return [];
  const chain = chainOf(db, docId);
  const returned = new Set(
    db.all<{ unit_ids_json: string }>(
      `SELECT cl.unit_ids_json FROM document_lines cl JOIN documents c ON c.id = cl.document_id
       WHERE c.type = 'credit_note' AND c.source_id = ? AND c.status = 'issued'`, [docId],
    ).flatMap((r) => JSON.parse(r.unit_ids_json || "[]") as string[]),
  );
  const named = new Set(
    db.all<{ unit_ids_json: string; part_id: string | null; supplied_by: string }>("SELECT unit_ids_json, part_id, supplied_by FROM document_lines WHERE document_id = ?", [docId])
      .filter((l) => l.supplied_by === "garage")
      .flatMap((l) => JSON.parse(l.unit_ids_json || "[]") as string[])
      .filter((id) => !returned.has(id)),
  );
  const t = now();
  const marks = chain.map(() => "?").join(", ");
  for (const u of db.all<UnitRow>(`SELECT * FROM stock_units WHERE status = 'fitted' AND document_id IN (${marks})`, chain)) {
    if (!named.has(u.id)) db.run("UPDATE stock_units SET status = 'in_stock', document_id = NULL, fitted_at = NULL, warranty_ends = NULL, updated_at = ? WHERE id = ?", [t, u.id]);
  }
  const conflicts: UnitConflict[] = [];
  for (const id of named) {
    const u = getUnit(db, id);
    if (!u) continue;
    const p = getPart(db, u.part_id)!;
    const ours = u.document_id !== null && chain.includes(u.document_id);
    if (u.status === "fitted" && !ours && u.document_id) {
      const other = getDoc(db, u.document_id);
      if (other && earlier(other, doc)) {
        conflicts.push({ unitId: u.id, code: u.code, partNo: p.part_no, loserDocId: doc.id, winnerDocId: other.id });
        dropFromLines(db, doc.id, u.id);
        continue;
      }
      if (other) {
        conflicts.push({ unitId: u.id, code: u.code, partNo: p.part_no, loserDocId: other.id, winnerDocId: doc.id });
        dropFromLines(db, other.id, u.id);
      }
    } else if (u.status !== "fitted" && u.status !== "in_stock") continue;
    const fittedAt = ours && u.fitted_at ? u.fitted_at : today();
    const ends = warrantyEnds(fittedAt, p.warranty_months);
    if (u.status !== "fitted" || u.document_id !== doc.id || u.fitted_at !== fittedAt || u.warranty_ends !== ends) {
      db.run("UPDATE stock_units SET status = 'fitted', document_id = ?, fitted_at = ?, warranty_ends = ?, updated_at = ? WHERE id = ?", [doc.id, fittedAt, ends, t, u.id]);
    }
  }
  return conflicts;
}

/**
 * A credit note taking back `qty` of an invoice line's tracked part: the units named (or, not named, the line's
 * last ones still fitted) go back on the shelf. Returns the units taken back (stored on the credit note's line).
 */
export function returnUnits(db: Db, invoiceId: string, lineUnitIds: string[], qty: number, chosen: string[], partNo: string): string[] {
  const fitted = lineUnitIds.filter((id) => {
    const u = getUnit(db, id);
    return u?.status === "fitted" && u.document_id === invoiceId;
  });
  let ids = chosen;
  if (ids.length) {
    if (ids.length > qty) throw badRequest(`${partNo}: ${ids.length} chosen for a quantity of ${qty}`);
    for (const id of ids) if (!fitted.includes(id)) throw badRequest(`${partNo}: that unit isn't fitted on this invoice line`);
  } else ids = Math.floor(qty) > 0 ? fitted.slice(-Math.min(Math.floor(qty), fitted.length)) : [];
  if (!Number.isInteger(qty) && ids.length) throw badRequest(`${partNo}: tyres and batteries come back in whole units`);
  const t = now();
  for (const id of ids) db.run("UPDATE stock_units SET status = 'in_stock', document_id = NULL, fitted_at = NULL, warranty_ends = NULL, updated_at = ? WHERE id = ?", [t, id]);
  return ids;
}

/** The units a line names, for screens and prints: DOT or serial, and a battery's warranty end. */
export function lineUnits(db: Db, unitIdsJson: string | null | undefined): { id: string; code: string; kind: "dot" | "serial"; warrantyEnds: string | null }[] {
  const ids = JSON.parse(unitIdsJson || "[]") as string[];
  return ids.map((id) => getUnit(db, id)).filter((u): u is UnitRow => !!u).map((u) => ({
    id: u.id, code: u.code, kind: getPart(db, u.part_id)?.tracking === "serial" ? "serial" as const : "dot" as const, warrantyEnds: u.warranty_ends,
  }));
}
