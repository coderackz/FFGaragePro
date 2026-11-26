/**
 * An amount in words for printed documents, e.g. 1,234.50 → "One thousand two hundred thirty-four dirhams and fifty
 * fils only". Negative amounts use the absolute value.
 */
export function amountInWords(fils: number): string {
  const abs = Math.abs(Math.round(fils));
  return english(Math.floor(abs / 100), abs % 100);
}

// ── English ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const EN_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function enUnder1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${EN_ONES[h]} hundred`);
  if (r) parts.push(r < 20 ? EN_ONES[r]! : `${EN_TENS[Math.floor(r / 10)]}${r % 10 ? `-${EN_ONES[r % 10]}` : ""}`);
  return parts.join(" ");
}

function enNumber(n: number): string {
  if (n === 0) return "zero";
  const parts: string[] = [];
  for (const [size, name] of [[1_000_000_000, "billion"], [1_000_000, "million"], [1000, "thousand"]] as const) {
    const c = Math.floor(n / size) % 1000;
    if (c) parts.push(`${enUnder1000(c)} ${name}`);
  }
  if (n % 1000) parts.push(enUnder1000(n % 1000));
  return parts.join(" ");
}

function english(dirhams: number, fils: number): string {
  const parts: string[] = [];
  if (dirhams || !fils) parts.push(`${enNumber(dirhams)} ${dirhams === 1 ? "dirham" : "dirhams"}`);
  if (fils) parts.push(`${enNumber(fils)} fils`);
  const s = `${parts.join(" and ")} only`;
  return s[0]!.toUpperCase() + s.slice(1);
}
