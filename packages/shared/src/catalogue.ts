import { roundFils } from "./money";
import { z } from "zod";

// ── Spare-parts catalogue: alternate numbers, fitment, categories with attributes, purchase packs ─────────────────

/** A part number as compared: upper case, without spaces, dashes, dots or slashes (`04152-yzza1` = `04152YZZA1`). */
export const normalizeNumber = (s: string) => s.toUpperCase().replace(/[\s\-./]/g, "");

export const PART_NUMBER_KINDS = ["oem", "aftermarket", "supplier", "old"] as const;
export type PartNumberKind = (typeof PART_NUMBER_KINDS)[number];
export const PART_NUMBER_KIND_LABELS: Record<PartNumberKind, string> = { oem: "OEM", aftermarket: "Aftermarket", supplier: "Supplier code", old: "Old number" };

const opt = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const year = z.number().int().min(1950).max(2100).nullable().optional().transform((v) => v ?? null);

export const partNumberSchema = z.object({
  number: z.string().trim().min(1, "Enter the number").max(60),
  kind: z.enum(PART_NUMBER_KINDS).default("oem"),
  brand: opt(80),
});
export const fitmentSchema = z
  .object({
    make: z.string().trim().min(1, "Enter the make").max(60),
    model: opt(80),
    yearFrom: year,
    yearTo: year,
    engine: opt(60),
    note: opt(200),
  })
  .refine((f) => !f.yearFrom || !f.yearTo || f.yearFrom <= f.yearTo, { message: "The years run backwards", path: ["yearTo"] });
export const packSchema = z.object({
  name: z.string().trim().min(1, "Name the pack").max(60),
  /** How many of the part's unit it holds. */
  size: z.number().positive("A pack holds more than zero").max(100_000),
});
export type PartNumberInput = z.infer<typeof partNumberSchema>;
export type FitmentInput = z.infer<typeof fitmentSchema>;
export type PackInput = z.infer<typeof packSchema>;

export const ATTRIBUTE_TYPES = ["text", "number", "choice"] as const;
export const attributeDefSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,30}$/, "Use lower-case letters, numbers and _"),
  label: z.string().trim().min(1).max(60),
  type: z.enum(ATTRIBUTE_TYPES),
  unit: opt(12),
  options: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
});
export type AttributeDef = z.input<typeof attributeDefSchema>;
export const categorySchema = z.object({
  name: z.string().trim().min(1, "Name the category").max(60),
  parentId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  attributes: z.array(attributeDefSchema).max(20).default([]),
});
export type CategoryInput = z.infer<typeof categorySchema>;

/** Attribute values on a part: text or numbers, by the category's keys. */
export const attributesSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), z.union([z.string().trim().max(60), z.number()])).default({});

const squash = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

/**
 * Does a fitment row cover this vehicle? Make must match; model, years and engine only count when set on the
 * fitment (blank = any); the vehicle's year and engine only count when the vehicle has them.
 */
export function fitmentMatches(
  f: { make: string; model?: string | null; yearFrom?: number | null; yearTo?: number | null; engine?: string | null },
  v: { make: string | null; model: string | null; year: number | null; engine: string | null },
): boolean {
  if (!v.make || squash(f.make) !== squash(v.make)) return false;
  if (f.model && squash(f.model) !== squash(v.model)) return false;
  if (v.year) {
    if (f.yearFrom && v.year < f.yearFrom) return false;
    if (f.yearTo && v.year > f.yearTo) return false;
  }
  if (f.engine && v.engine && normalizeNumber(f.engine) !== normalizeNumber(v.engine)) return false;
  return true;
}

/**
 * A part's specs as searchable text, in the category's order. Tyres (width, profile and rim) also read as
 * `265/65R17` and `2656517`; values with dashes or dots also appear without them (`5W-30 5W30`).
 */
export function specText(attrs: Record<string, string | number | undefined>, defs: { key: string; label?: string; type?: string }[]): string {
  const out: string[] = [];
  const w = attrs.width, p = attrs.profile, r = attrs.rim;
  if (w !== undefined && p !== undefined && r !== undefined && `${w}${p}${r}` !== "") out.push(`${w}/${p}R${r}`, `${w}${p}${r}`);
  for (const d of defs) {
    const v = attrs[d.key];
    if (v === undefined || v === "") continue;
    const s = String(v);
    out.push(s);
    const n = normalizeNumber(s);
    if (n !== s.toUpperCase()) out.push(n);
  }
  return out.join(" ");
}

/**
 * A purchase order line's (or a delivery of it) amount before VAT. A line priced per pack is packs × the pack price,
 * so a box of 12 at AED 10.00 is exactly AED 10.00 a box, although its unit cost is rounded to 83 fils. That holds
 * while the quantity is whole packs at the line's own unit cost; anything else is priced per unit.
 */
export function poLineNetFils(l: { qty: number; unitCostFils: number; packSize?: number | null; packCostFils?: number | null }): number {
  if (l.packSize && l.packCostFils != null && l.unitCostFils === Math.round(l.packCostFils / l.packSize)) {
    const packs = l.qty / l.packSize;
    if (Math.abs(packs - Math.round(packs)) < 1e-6) return Math.round(packs) * l.packCostFils;
  }
  return roundFils(l.qty * l.unitCostFils);
}

/** Packs bought → the part's own unit: quantity, and cost per unit to the fil. */
export function packToBase(packs: number, size: number, costPerPackFils: number): { qty: number; unitCostFils: number } {
  return { qty: Math.round(packs * size * 1000) / 1000, unitCostFils: Math.round(costPerPackFils / size) };
}
