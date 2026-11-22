import { z } from "zod";

/**
 * An overall discount on a document: a percentage or an amount (fils), spread over the lines like a promo code.
 * Above the garage's limit it needs a tick and a remark from whoever gives it.
 */
export const discountSchema = z
  .object({
    kind: z.enum(["percent", "amount"]),
    value: z.number().positive("Enter the discount"),
    confirmed: z.boolean().optional(),
    remark: z.string().trim().min(3, "Write a remark of at least 3 characters").max(300).optional(),
  })
  .refine((d) => d.kind !== "percent" || d.value <= 100, { message: "A percentage is at most 100", path: ["value"] })
  .refine((d) => d.kind !== "amount" || Number.isInteger(d.value), { message: "Enter the amount in fils", path: ["value"] });
export type DiscountInput = z.infer<typeof discountSchema>;

/** The discount's share of the bill it applies to, in percent to two decimals (0 for an empty bill). */
export function discountPct(discountFils: number, baseFils: number): number {
  return baseFils > 0 ? Math.round((discountFils * 10000) / baseFils) / 100 : 0;
}

/** Strictly above the limit needs a confirmation; exactly at it doesn't. */
export const needsConfirmation = (pct: number, limitPct: number): boolean => pct > limitPct;
