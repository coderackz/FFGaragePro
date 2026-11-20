import { z } from "zod";

// ── Fixed assets ───────────────────────────────────────────────────────────────────────────────────────────────────
export const ASSET_CATEGORIES = ["tools", "equipment", "vehicle", "fit_out"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];
export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = { tools: "Tools", equipment: "Equipment", vehicle: "Vehicle", fit_out: "Fit-out and furniture" };

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");
const fils = z.number().int().min(0).max(10_000_000_00);
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);

export const assetSchema = z
  .object({
    name: z.string().trim().min(1, "Name the asset").max(120),
    category: z.enum(ASSET_CATEGORIES),
    accountId: z.string().min(1, "Choose the account it sits in"),
    costFils: fils.refine((v) => v > 0, "Enter the cost"),
    inUseFrom: ymd,
    lifeMonths: z.number().int().min(1, "Life is at least a month").max(600),
    residualFils: fils.default(0),
    /** Depreciation already taken before the books started (it's in the opening balances). */
    openingDepreciationFils: fils.default(0),
    serial: optText(80),
    note: optText(300),
  })
  .refine((a) => a.residualFils < a.costFils, { message: "The residual value must be less than the cost", path: ["residualFils"] })
  .refine((a) => a.openingDepreciationFils <= a.costFils - a.residualFils, { message: "That's more than the asset can be depreciated", path: ["openingDepreciationFils"] });
export type AssetInput = z.infer<typeof assetSchema>;

export const disposeSchema = z
  .object({
    date: ymd,
    proceedsFils: fils,
    proceedsAccountId: z.string().nullable().optional().transform((v) => v ?? null),
    note: optText(300),
  })
  .refine((d) => d.proceedsFils === 0 || !!d.proceedsAccountId, { message: "Choose where the money went", path: ["proceedsAccountId"] });

/** Months from `from` to `to` (YYYY-MM), both counted: Jan–Jan is 1. */
export function monthsBetween(from: string, to: string): number {
  const n = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  return n(to) - n(from) + 1;
}

/** The monthly charge: (cost − residual) ÷ life, rounded to the fil (the last month takes the rounding). */
export const monthlyDepreciation = (a: { costFils: number; residualFils: number; lifeMonths: number }) => Math.round((a.costFils - a.residualFils) / a.lifeMonths);

/**
 * Depreciation due on an asset from when it went into use through `month` (YYYY-MM), straight line: a full month's
 * charge from the month it goes into use, never beyond cost − residual (so the last month takes the rounding).
 */
export function depreciationThrough(a: { costFils: number; residualFils: number; lifeMonths: number; inUseFrom: string }, month: string): number {
  const months = monthsBetween(a.inUseFrom.slice(0, 7), month);
  if (months <= 0) return 0;
  const depreciable = a.costFils - a.residualFils;
  return months >= a.lifeMonths ? depreciable : Math.min(months * monthlyDepreciation(a), depreciable);
}
