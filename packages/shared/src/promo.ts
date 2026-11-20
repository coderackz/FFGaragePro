import { z } from "zod";
import { lineTotals, type LineAmounts } from "./money";

// ── Promo / coupon codes ──────────────────────────────────────────────────────────────────────────────────────────
export const PROMO_APPLIES = ["all", "labour", "parts"] as const;
export type PromoApplies = (typeof PROMO_APPLIES)[number];
const realDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31")
  .refine((d) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, "That isn't a real date");

export const promoSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,30}$/, "Use 2–30 letters, numbers, - or _"),
    description: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
    kind: z.enum(["percent", "amount"]),
    /** Percent (0.01–100), or fils for a fixed amount. */
    value: z.number().positive("Enter the discount"),
    appliesTo: z.enum(PROMO_APPLIES).default("all"),
    validFrom: realDate.nullable().optional().transform((v) => v ?? null),
    validTo: realDate.nullable().optional().transform((v) => v ?? null),
    minNetFils: z.number().int().min(0).nullable().optional().transform((v) => v || null),
    maxUses: z.number().int().min(1).nullable().optional().transform((v) => v ?? null),
    oncePerCustomer: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .refine((p) => p.kind !== "percent" || p.value <= 100, { message: "A percentage is at most 100", path: ["value"] })
  .refine((p) => p.kind !== "amount" || Number.isInteger(p.value), { message: "Enter the amount in fils", path: ["value"] })
  .refine((p) => !p.validFrom || !p.validTo || p.validFrom <= p.validTo, { message: "It ends before it starts", path: ["validTo"] });
export type PromoInput = z.infer<typeof promoSchema>;

export interface PromoTerms { kind: "percent" | "amount"; value: number; appliesTo: PromoApplies }
type PromoLine = LineAmounts & { kind: "labour" | "part" | "other"; suppliedBy?: string | null };

const matches = (l: PromoLine, applies: PromoApplies) =>
  l.suppliedBy !== "fleetfix" && (applies === "all" || (applies === "labour" && l.kind === "labour") || (applies === "parts" && l.kind === "part"));

/**
 * A promo's discount and each line's share. The base is the matching lines after their own discount (net, or gross
 * when prices include VAT). Percent of the base, or the fixed amount up to the base. Spread over the matching lines in
 * proportion, rounded per line; the last matching line takes the remainder.
 */
export function promoShares(lines: PromoLine[], promo: PromoTerms, includeVat: boolean): { shares: number[]; discountFils: number; baseFils: number } {
  const amounts = lines.map((l) => {
    if (!matches(l, promo.appliesTo)) return 0;
    const t = lineTotals({ ...l, promoFils: 0 }, 500, includeVat);
    return includeVat ? t.grossFils : t.netFils;
  });
  const baseFils = amounts.reduce((a, b) => a + b, 0);
  const discountFils = Math.min(promo.kind === "percent" ? Math.round((baseFils * promo.value) / 100) : Math.round(promo.value), baseFils);
  const shares = amounts.map(() => 0);
  const last = amounts.reduce((idx, a, i) => (a > 0 ? i : idx), -1);
  let given = 0;
  amounts.forEach((a, i) => {
    if (!a || i === last) return;
    shares[i] = Math.min(Math.round((discountFils * a) / baseFils), a);
    given += shares[i]!;
  });
  if (last >= 0) shares[last] = Math.min(discountFils - given, amounts[last]!);
  return { shares, discountFils: shares.reduce((a, b) => a + b, 0), baseFils };
}

const dayText = (ymd: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));

/** Why a code can't be used now (null when it can). `uses`: issued invoices that used it (not fully credited). */
export function promoProblem(
  p: Pick<PromoInput, "active" | "validFrom" | "validTo" | "minNetFils" | "maxUses" | "oncePerCustomer">,
  ctx: { today: string; baseFils: number; uses: number; usedByCustomer: boolean },
): string | null {
  if (!p.active) return "Not active";
  if (p.validFrom && ctx.today < p.validFrom) return `Starts on ${dayText(p.validFrom)}`;
  if (p.validTo && ctx.today > p.validTo) return `Ended on ${dayText(p.validTo)}`;
  if (p.minNetFils && ctx.baseFils < p.minNetFils) return `Needs a bill of at least AED ${(p.minNetFils / 100).toFixed(2)}`;
  if (p.maxUses && ctx.uses >= p.maxUses) return "Used up";
  if (p.oncePerCustomer && ctx.usedByCustomer) return "Already used by this customer";
  return null;
}
