// ── VAT return (VAT201) ────────────────────────────────────────────────────────────────────────────────────────────
export const EMIRATES = ["abu_dhabi", "dubai", "sharjah", "ajman", "umm_al_quwain", "ras_al_khaimah", "fujairah"] as const;
export type Emirate = (typeof EMIRATES)[number];
export const EMIRATE_NAMES: Record<Emirate, string> = {
  abu_dhabi: "Abu Dhabi", dubai: "Dubai", sharjah: "Sharjah", ajman: "Ajman", umm_al_quwain: "Umm Al Quwain", ras_al_khaimah: "Ras Al Khaimah", fujairah: "Fujairah",
};
export const EMIRATE_BOX = {
  abu_dhabi: "1a", dubai: "1b", sharjah: "1c", ajman: "1d", umm_al_quwain: "1e", ras_al_khaimah: "1f", fujairah: "1g",
} as const satisfies Record<Emirate, string>;

/** What a manual journal line can be tagged with: the return box it belongs to. */
export const VAT_TAGS = ["1", "1adj", "2", "3", "4", "5", "6", "7", "9", "9adj", "10"] as const;
export type VatTag = (typeof VAT_TAGS)[number];
export const VAT_TAG_INFO: Record<VatTag, { side: "sales" | "expenses"; label: string; vatOnly: boolean }> = {
  "1": { side: "sales", label: "1 Standard rated supplies", vatOnly: false },
  "1adj": { side: "sales", label: "1 Adjustment (sales VAT)", vatOnly: true },
  "2": { side: "sales", label: "2 Tax refunds to tourists", vatOnly: false },
  "3": { side: "sales", label: "3 Reverse charge (VAT due)", vatOnly: false },
  "4": { side: "sales", label: "4 Zero rated supplies", vatOnly: false },
  "5": { side: "sales", label: "5 Exempt supplies", vatOnly: false },
  "6": { side: "sales", label: "6 Goods imported", vatOnly: false },
  "7": { side: "sales", label: "7 Adjustments to goods imported", vatOnly: false },
  "9": { side: "expenses", label: "9 Standard rated expenses", vatOnly: false },
  "9adj": { side: "expenses", label: "9 Adjustment (input VAT)", vatOnly: true },
  "10": { side: "expenses", label: "10 Reverse charge (recoverable)", vatOnly: false },
};

export const VAT_BOX_KEYS = ["1a", "1b", "1c", "1d", "1e", "1f", "1g", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] as const;
export type VatBoxKey = (typeof VAT_BOX_KEYS)[number];
const emirateKey = Object.fromEntries(EMIRATES.map((e) => [EMIRATE_BOX[e], e])) as Record<string, Emirate>;
export const VAT_BOXES: { key: VatBoxKey; label: string }[] = VAT_BOX_KEYS.map((key) => ({
  key,
  label: emirateKey[key] ? `Standard rated supplies in ${EMIRATE_NAMES[emirateKey[key]!]}` : ({
    "2": "Tax refunds provided to tourists", "3": "Supplies subject to the reverse charge", "4": "Zero rated supplies", "5": "Exempt supplies",
    "6": "Goods imported into the UAE", "7": "Adjustments to goods imported", "8": "Totals", "9": "Standard rated expenses",
    "10": "Supplies subject to the reverse charge", "11": "Totals",
  } as Record<string, string>)[key]!,
}));

const addMonths = (ymd: string, n: number) => {
  const [y, m] = ymd.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, Number(ymd.slice(8))));
  return d.toISOString().slice(0, 10);
};
const dayBefore = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** VAT periods from the first one in Settings → Tax, newest first, up to the one containing `today`. */
export function vatPeriods(tax: { returnPeriod: "monthly" | "quarterly"; firstPeriodStart: string | null }, today: string): { from: string; to: string }[] {
  if (!tax.firstPeriodStart) return [];
  const step = tax.returnPeriod === "monthly" ? 1 : 3;
  const out: { from: string; to: string }[] = [];
  // Each step moves forward by whole months from a 1st, so the loop always ends.
  for (let from = tax.firstPeriodStart; from <= today; ) {
    const next = addMonths(from, step);
    out.push({ from, to: dayBefore(next) });
    from = next;
  }
  return out.reverse();
}
