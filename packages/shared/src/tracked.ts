// Inventory v2, Part 2: tyres tracked one by one by DOT, batteries by serial, and kits made of other parts.

export const TRACKING = ["none", "dot", "serial"] as const;
export type Tracking = (typeof TRACKING)[number];

const todayYmd = () => new Date().toISOString().slice(0, 10);
/** The Monday-ish start of a DOT week: 1 January plus (week − 1) weeks (as tyre makers count). */
const dotDate = (week: number, year: number) => new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));

/**
 * A tyre's DOT date code: the week and year it was made, "2524" (or "25/24") = week 25 of 2024. Null when it isn't
 * one: week 1–53, made in 2000 or later and not after `today`.
 */
export function parseDot(input: string, today = todayYmd()): { week: number; year: number; code: string } | null {
  const m = /^(\d{2})\s*\/?\s*(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const week = Number(m[1]), year = 2000 + Number(m[2]);
  if (week < 1 || week > 53) return null;
  if (dotDate(week, year).toISOString().slice(0, 10) > today) return null;
  return { week, year, code: `${m[1]}${m[2]}` };
}

/**
 * Codes typed or pasted for units coming in: one per line, or separated by commas, semicolons or spaces. DOTs may be
 * written "25 24" or "25/24", so for tyres a pair of 2-digit numbers is one code.
 */
export function splitUnitCodes(text: string, tracking: Tracking): string[] {
  const joined = tracking === "dot" ? text.replace(/\b(\d{2})\s*\/?\s+(\d{2})\b|\b(\d{2})\s*\/\s*(\d{2})\b/g, (_m, a, b, c, d) => `${a ?? c}${b ?? d}`) : text;
  return joined.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Whole months from when a tyre was made to `today`. */
export function dotAgeMonths(code: string, today = todayYmd()): number | null {
  const d = parseDot(code, today);
  if (!d) return null;
  const made = dotDate(d.week, d.year);
  const [y, mo, day] = today.split("-").map(Number) as [number, number, number];
  let months = (y - made.getUTCFullYear()) * 12 + (mo - 1 - made.getUTCMonth());
  if (day < made.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** The order units are offered in: the oldest DOT first (then the earlier delivery); others by delivery, after them. */
export function oldestFirst<T extends { code: string; receivedAt: string }>(units: T[], today = todayYmd()): T[] {
  const key = (u: T) => {
    const d = parseDot(u.code, today);
    return d ? d.year * 100 + d.week : Number.MAX_SAFE_INTEGER;
  };
  return [...units].sort((a, b) => key(a) - key(b) || a.receivedAt.localeCompare(b.receivedAt));
}

/** The last day of a warranty of `months` from `fittedOn` (same day of the month, or the month's last day). */
export function warrantyEnds(fittedOn: string, months: number): string | null {
  if (!months || months <= 0) return null;
  const [y, m, d] = fittedOn.slice(0, 10).split("-").map(Number) as [number, number, number];
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12), month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Whole kits that can be made from the shelf: the fewest any one component allows. */
export function kitAvailable(components: { partId: string; qty: number }[], onHand: Map<string, number>): number {
  if (!components.length) return 0;
  return Math.max(0, Math.min(...components.map((c) => Math.floor(((onHand.get(c.partId) ?? 0) + 1e-9) / c.qty))));
}
