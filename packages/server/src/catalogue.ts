import { fitmentMatches, normalizeNumber, PART_NUMBER_KIND_LABELS, specText, type AttributeDef, type PartInput, type PartNumberKind } from "@ffgp/shared";
import { createHash } from "node:crypto";
import { now, type Db } from "./db";
import { badRequest } from "./errors";

// The spare-parts catalogue around a part: categories and specs, other numbers, fitment, packs, supersession.

export interface CategoryRow { id: string; name: string; parent_id: string | null; position: number; attributes_json: string; created_at: string; updated_at: string }
export const categoryOut = (c: CategoryRow) => ({ id: c.id, name: c.name, parentId: c.parent_id, position: c.position, attributes: JSON.parse(c.attributes_json) as AttributeDef[] });
export const getCategory = (db: Db, id: string | null) => (id ? db.get<CategoryRow>("SELECT * FROM part_categories WHERE id = ?", [id]) ?? null : null);

interface NumberRow { id: string; number: string; kind: PartNumberKind; brand: string | null }
interface FitmentRow { id: string; make: string; model: string | null; year_from: number | null; year_to: number | null; engine: string | null; note: string | null }
interface PackRow { id: string; name: string; size: number }
const fitmentOut = (f: FitmentRow) => ({ id: f.id, make: f.make, model: f.model, yearFrom: f.year_from, yearTo: f.year_to, engine: f.engine, note: f.note });

export const numbersOf = (db: Db, partId: string) =>
  db.all<NumberRow>("SELECT id, number, kind, brand FROM part_numbers WHERE part_id = ? ORDER BY rowid", [partId]).map((n) => ({ id: n.id, number: n.number, kind: n.kind, brand: n.brand }));
export const fitmentsOf = (db: Db, partId: string) =>
  db.all<FitmentRow>("SELECT * FROM part_fitments WHERE part_id = ? ORDER BY make COLLATE NOCASE, model COLLATE NOCASE, year_from", [partId]).map(fitmentOut);
export const packsOf = (db: Db, partId: string) =>
  db.all<PackRow>("SELECT id, name, size FROM part_packs WHERE part_id = ? ORDER BY rowid", [partId]).map((p) => ({ id: p.id, name: p.name, size: p.size }));

/**
 * Checks a part's specs against its category: only the category's attributes, choices from its list, numbers as
 * numbers. `stored`: the part's specs as saved. After the category is edited, a spec it no longer has is dropped and a
 * choice no longer on its list is kept as it was, so the part can still be saved; anything new must fit the category.
 */
export function checkAttributes(
  db: Db, categoryId: string | null, attrs: Record<string, string | number>, stored: Record<string, string | number> = {},
): { defs: AttributeDef[]; attrs: Record<string, string | number> } {
  const cat = getCategory(db, categoryId);
  if (categoryId && !cat) throw badRequest("That category doesn't exist");
  const defs = cat ? (JSON.parse(cat.attributes_json) as AttributeDef[]) : [];
  const clean: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === "" || v === null || v === undefined) continue;
    const d = defs.find((x) => x.key === k);
    if (!d && k in stored) continue;
    if (!d) throw badRequest(cat ? `${cat.name} has no "${k}"` : "Pick a category before filling in specs");
    if (d.type === "number") {
      const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
      if (!Number.isFinite(n)) throw badRequest(`${d.label} must be a number`);
      clean[k] = n;
    } else {
      const s = String(v).trim();
      if (d.type === "choice" && d.options?.length && !d.options.includes(s) && String(stored[k] ?? "") !== s) throw badRequest(`${d.label}: choose one of ${d.options.join(", ")}`);
      clean[k] = s;
    }
  }
  return { defs, attrs: clean };
}

/**
 * The id of a part's number, fitment or pack row, made from what the row is (its natural key). The same number
 * added on two computers gets one id, so sync merges them into one row instead of keeping both; saving a part
 * unchanged writes nothing.
 */
export function childId(table: "part_numbers" | "part_fitments" | "part_packs", partId: string, key: string): string {
  const h = createHash("sha256").update(`${table}\n${partId}\n${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
type Val = string | number | null;
/** Case and spacing ignored, as fitmentMatches does. */
const squashKey = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
type Fit = { make: string; model?: string | null; yearFrom?: number | null; yearTo?: number | null; engine?: string | null; note?: string | null };
const numberKey = (n: { number: string; kind: string }) => `${n.kind}:${normalizeNumber(n.number)}`;
const fitmentKey = (f: Fit) => [squashKey(f.make), squashKey(f.model), f.yearFrom ?? "", f.yearTo ?? "", normalizeNumber(f.engine ?? "")].join("|");
const packKey = (p: { name: string }) => p.name.trim().toLowerCase();

/**
 * Makes a part's rows in `table` exactly `rows` (keyed by `childId`): unchanged rows are left alone, changed ones
 * updated, new ones inserted and the rest deleted. Each statement is one sync change, so only real changes travel.
 */
function syncChildren(db: Db, table: "part_numbers" | "part_fitments" | "part_packs", partId: string, rows: { key: string; values: Record<string, Val> }[], t: string): void {
  const wanted = new Map<string, Record<string, Val>>();
  for (const r of rows) wanted.set(childId(table, partId, r.key), r.values);
  const cols = Object.keys(rows[0]?.values ?? {});
  const existing = new Map(db.all<Record<string, Val>>(`SELECT * FROM ${table} WHERE part_id = ?`, [partId]).map((r) => [String(r.id), r]));
  for (const id of existing.keys()) if (!wanted.has(id)) db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  for (const [id, values] of wanted) {
    const cur = existing.get(id);
    if (!cur) {
      const names = ["id", "part_id", ...cols, "created_at"];
      db.run(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, [id, partId, ...cols.map((c) => values[c] ?? null), t]);
    } else {
      const changed = cols.filter((c) => (cur[c] ?? null) !== (values[c] ?? null));
      if (changed.length) db.run(`UPDATE ${table} SET ${changed.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...changed.map((c) => values[c] ?? null), id]);
    }
  }
}

const numberRow = (n: { number: string; kind: string; brand?: string | null }) => ({ key: numberKey(n), values: { number: n.number, normalized: normalizeNumber(n.number), kind: n.kind, brand: n.brand ?? null } });
const fitmentRow = (f: Fit) => ({ key: fitmentKey(f), values: { make: f.make, model: f.model ?? null, year_from: f.yearFrom ?? null, year_to: f.yearTo ?? null, engine: f.engine ?? null, note: f.note ?? null } });
const packRow = (p: { name: string; size: number }) => ({ key: packKey(p), values: { name: p.name, size: p.size } });

/**
 * Saves a part's catalogue: category, specs (and their searchable text), and, when given, its other numbers,
 * fitment and packs (each set made exactly what was sent). `present`: which of those the caller sent (an older
 * screen or a CSV without those columns leaves them as they are). Specs sent without a category keep the part's.
 */
export function saveCatalogue(db: Db, partId: string, input: PartInput, present: (k: "category" | "categoryId" | "numbers" | "fitments" | "packs") => boolean): void {
  const t = now();
  if (present("category")) {
    const cur = db.get<{ category_id: string | null; attributes_json: string }>("SELECT category_id, attributes_json FROM parts WHERE id = ?", [partId]);
    const categoryId = present("categoryId") ? input.categoryId : cur?.category_id ?? null;
    const stored = categoryId === (cur?.category_id ?? null) ? (JSON.parse(cur?.attributes_json ?? "{}") as Record<string, string | number>) : {};
    const { defs, attrs } = checkAttributes(db, categoryId, input.attributes as Record<string, string | number>, stored);
    db.run("UPDATE parts SET category_id = ?, attributes_json = ?, spec_text = ? WHERE id = ?", [categoryId, JSON.stringify(attrs), specText(attrs, defs), partId]);
  }
  if (present("numbers")) syncChildren(db, "part_numbers", partId, input.numbers.map(numberRow), t);
  if (present("fitments")) syncChildren(db, "part_fitments", partId, input.fitments.map(fitmentRow), t);
  if (present("packs")) syncChildren(db, "part_packs", partId, input.packs.map(packRow), t);
}

/** Adds a fitment row unless the same one is there. Returns whether it was added. */
export function addFitment(db: Db, partId: string, f: Fit, t = now()): boolean {
  const row = fitmentRow(f);
  const id = childId("part_fitments", partId, row.key);
  if (db.get("SELECT 1 FROM part_fitments WHERE id = ?", [id])) return false;
  const v = row.values;
  db.run("INSERT INTO part_fitments (id, part_id, make, model, year_from, year_to, engine, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    id, partId, v.make, v.model, v.year_from, v.year_to, v.engine, v.note, t,
  ]);
  return true;
}

/** The chain a part is in: itself, what replaced it, what replaced that… (stops at a loop or after 20). */
export function chainFrom(db: Db, partId: string): { id: string; partNo: string; name: string; onHand: number; stocked: boolean }[] {
  const out: { id: string; partNo: string; name: string; onHand: number; stocked: boolean }[] = [];
  const seen = new Set<string>();
  let id: string | null = partId;
  while (id && !seen.has(id) && out.length < 20) {
    seen.add(id);
    const p: { id: string; part_no: string; name: string; on_hand: number; stocked: number; superseded_by: string | null } | undefined =
      db.get("SELECT id, part_no, name, on_hand, stocked, superseded_by FROM parts WHERE id = ?", [id]);
    if (!p) break;
    out.push({ id: p.id, partNo: p.part_no, name: p.name, onHand: p.on_hand, stocked: !!p.stocked });
    id = p.superseded_by;
  }
  return out;
}

/** Marks `partId` as replaced by `byPartId` (null: not replaced). A loop (A → B → A) is refused. */
export function supersede(db: Db, partId: string, byPartId: string | null): void {
  if (byPartId) {
    if (byPartId === partId) throw badRequest("A part can't replace itself");
    if (!db.get("SELECT 1 FROM parts WHERE id = ?", [byPartId])) throw badRequest("That replacement part doesn't exist");
    if (chainFrom(db, byPartId).some((p) => p.id === partId)) throw badRequest("That would make a loop: the replacement is already replaced by this part");
  }
  db.run("UPDATE parts SET superseded_by = ?, updated_at = ? WHERE id = ?", [byPartId, now(), partId]);
}

/** Why a search found a part when it wasn't by its own number, name, brand or specs: "OEM 04152-YZZA1". */
export function matchedBy(db: Db, partId: string, q: string, own: string): string | null {
  const nq = normalizeNumber(q);
  if (!nq || own.toUpperCase().includes(q.toUpperCase()) || normalizeNumber(own).includes(nq)) return null;
  const n = db.all<NumberRow & { normalized: string }>("SELECT number, kind, brand, normalized FROM part_numbers WHERE part_id = ? ORDER BY rowid", [partId])
    .find((x) => x.normalized.includes(nq));
  return n ? `${PART_NUMBER_KIND_LABELS[n.kind]} ${n.number}${n.brand ? ` (${n.brand})` : ""}` : null;
}

export type VehicleFit = { make: string | null; model: string | null; year: number | null; engine: string | null };
