import { fitmentMatches, normalizeNumber, PART_NUMBER_KIND_LABELS, specText, type AttributeDef, type PartInput, type PartNumberKind } from "@ffgp/shared";
import { newId, now, type Db } from "./db";
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

/** Checks a part's specs against its category: only the category's attributes, choices from its list, numbers as numbers. */
export function checkAttributes(db: Db, categoryId: string | null, attrs: Record<string, string | number>): { defs: AttributeDef[]; attrs: Record<string, string | number> } {
  const cat = getCategory(db, categoryId);
  if (categoryId && !cat) throw badRequest("That category doesn't exist");
  const defs = cat ? (JSON.parse(cat.attributes_json) as AttributeDef[]) : [];
  const clean: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === "" || v === null || v === undefined) continue;
    const d = defs.find((x) => x.key === k);
    if (!d) throw badRequest(cat ? `${cat.name} has no "${k}"` : "Pick a category before filling in specs");
    if (d.type === "number") {
      const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
      if (!Number.isFinite(n)) throw badRequest(`${d.label} must be a number`);
      clean[k] = n;
    } else {
      const s = String(v).trim();
      if (d.type === "choice" && d.options?.length && !d.options.includes(s)) throw badRequest(`${d.label}: choose one of ${d.options.join(", ")}`);
      clean[k] = s;
    }
  }
  return { defs, attrs: clean };
}

/**
 * Saves a part's catalogue: category, specs (and their searchable text), and, when given, its other numbers,
 * fitment and packs (each replaced as a whole set). `present`: which of those the caller sent (an older screen or a
 * CSV without those columns leaves them as they are).
 */
export function saveCatalogue(db: Db, partId: string, input: PartInput, present: (k: "category" | "numbers" | "fitments" | "packs") => boolean): void {
  const t = now();
  if (present("category")) {
    const { defs, attrs } = checkAttributes(db, input.categoryId, input.attributes as Record<string, string | number>);
    db.run("UPDATE parts SET category_id = ?, attributes_json = ?, spec_text = ? WHERE id = ?", [input.categoryId, JSON.stringify(attrs), specText(attrs, defs), partId]);
  }
  if (present("numbers")) {
    db.run("DELETE FROM part_numbers WHERE part_id = ?", [partId]);
    for (const n of input.numbers) {
      db.run("INSERT INTO part_numbers (id, part_id, number, normalized, kind, brand, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        newId(), partId, n.number, normalizeNumber(n.number), n.kind, n.brand, t,
      ]);
    }
  }
  if (present("fitments")) {
    db.run("DELETE FROM part_fitments WHERE part_id = ?", [partId]);
    for (const f of input.fitments) addFitment(db, partId, f, t);
  }
  if (present("packs")) {
    db.run("DELETE FROM part_packs WHERE part_id = ?", [partId]);
    for (const p of input.packs) db.run("INSERT INTO part_packs (id, part_id, name, size, created_at) VALUES (?, ?, ?, ?, ?)", [newId(), partId, p.name, p.size, t]);
  }
}

type Fit = { make: string; model?: string | null; yearFrom?: number | null; yearTo?: number | null; engine?: string | null; note?: string | null };
/** Adds a fitment row unless the same one is there. Returns whether it was added. */
export function addFitment(db: Db, partId: string, f: Fit, t = now()): boolean {
  const same = db.get(
    `SELECT 1 FROM part_fitments WHERE part_id = ? AND make = ? COLLATE NOCASE AND COALESCE(model, '') = ? COLLATE NOCASE
     AND COALESCE(year_from, 0) = ? AND COALESCE(year_to, 0) = ? AND COALESCE(engine, '') = ? COLLATE NOCASE`,
    [partId, f.make, f.model ?? "", f.yearFrom ?? 0, f.yearTo ?? 0, f.engine ?? ""],
  );
  if (same) return false;
  db.run("INSERT INTO part_fitments (id, part_id, make, model, year_from, year_to, engine, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    newId(), partId, f.make, f.model ?? null, f.yearFrom ?? null, f.yearTo ?? null, f.engine ?? null, f.note ?? null, t,
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
/** 0: fits this vehicle; 1: no fitment known (may fit); 2: fits other vehicles. */
export function fitRank(db: Db, partId: string, v: VehicleFit): 0 | 1 | 2 {
  const rows = db.all<FitmentRow>("SELECT * FROM part_fitments WHERE part_id = ?", [partId]);
  if (!rows.length) return 1;
  return rows.some((f) => fitmentMatches({ make: f.make, model: f.model, yearFrom: f.year_from, yearTo: f.year_to, engine: f.engine }, v)) ? 0 : 2;
}
