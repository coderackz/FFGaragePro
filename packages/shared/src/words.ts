/**
 * An amount in words for printed documents, e.g. 1,234.50 →
 * "One thousand two hundred thirty-four dirhams and fifty fils only" /
 * "فقط ألف ومائتان وأربعة وثلاثون درهماً وخمسون فلساً لا غير". Negative amounts use the absolute value.
 */
export function amountInWords(fils: number, lang: "en" | "ar"): string {
  const abs = Math.abs(Math.round(fils));
  const dirhams = Math.floor(abs / 100);
  const rest = abs % 100;
  return lang === "en" ? english(dirhams, rest) : arabic(dirhams, rest);
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

// ── Arabic (dirham and fils are masculine) ─────────────────────────────────────────────────────────────────────────────
const AR_ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة"];
const AR_TENS = ["", "عشرة", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const AR_HUNDREDS = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];

function arUnder100(r: number): string {
  if (r <= 10) return AR_ONES[r]!;
  if (r === 11) return "أحد عشر";
  if (r === 12) return "اثنا عشر";
  if (r < 20) return `${AR_ONES[r - 10]} عشر`;
  return r % 10 ? `${AR_ONES[r % 10]} و${AR_TENS[Math.floor(r / 10)]}` : AR_TENS[r / 10]!;
}

function arUnder1000(n: number): string {
  return [AR_HUNDREDS[Math.floor(n / 100)], n % 100 ? arUnder100(n % 100) : ""].filter(Boolean).join(" و");
}

interface Noun { one: string; two: string; few: string; many: string }
const ALF: Noun = { one: "ألف", two: "ألفان", few: "آلاف", many: "ألفاً" };
const MILYUN: Noun = { one: "مليون", two: "مليونان", few: "ملايين", many: "مليوناً" };
const MILYAR: Noun = { one: "مليار", two: "ملياران", few: "مليارات", many: "ملياراً" };
const DIRHAM: Noun = { one: "درهم", two: "درهمان", few: "دراهم", many: "درهماً" };
const FILS: Noun = { one: "فلس", two: "فلسان", few: "فلوس", many: "فلساً" };

/** A count of a scale word (thousand, million); `last` = nothing follows but the currency noun. */
function arScale(c: number, noun: Noun, last: boolean): string {
  if (c === 1) return noun.one;
  if (c === 2) return noun.two;
  const k = c % 100;
  const word = k >= 3 && k <= 10 ? noun.few : k >= 11 ? (last ? noun.one : noun.many) : noun.one;
  // "مائتا ألف", "مائتا مليون": two hundred right before the scale word loses its final nun.
  return `${arUnder1000(c).replace(/مائتان$/, "مائتا")} ${word}`;
}

/** n of a currency noun: "درهم واحد", "درهمان", "ثلاثة دراهم", "أحد عشر درهماً", "مائتا درهم", "صفر درهم". */
function arCounted(n: number, noun: Noun): string {
  if (n === 0) return `صفر ${noun.one}`;
  if (n === 1) return `${noun.one} واحد`;
  if (n === 2) return noun.two;
  const groups: { c: number; noun: Noun | null }[] = [
    { c: Math.floor(n / 1_000_000_000) % 1000, noun: MILYAR },
    { c: Math.floor(n / 1_000_000) % 1000, noun: MILYUN },
    { c: Math.floor(n / 1000) % 1000, noun: ALF },
    { c: n % 1000, noun: null },
  ].filter((g) => g.c > 0);
  let words = groups
    .map((g, i) => (g.noun ? arScale(g.c, g.noun, i === groups.length - 1) : arUnder1000(g.c)))
    .join(" و");
  // A dual right before the noun loses its final nun: مائتا درهم, ألفا درهم.
  words = words.replace(/(مائت|ألف|مليون|مليار)ان$/, "$1ا");
  const k = n % 100;
  return `${words} ${k >= 3 && k <= 10 ? noun.few : k >= 11 ? noun.many : noun.one}`;
}

function arabic(dirhams: number, fils: number): string {
  const parts: string[] = [];
  if (dirhams || !fils) parts.push(arCounted(dirhams, DIRHAM));
  if (fils) parts.push(arCounted(fils, FILS));
  return `فقط ${parts.join(" و")} لا غير`;
}
