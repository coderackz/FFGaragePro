import { ibanValid } from "./payroll";
import type { Emirate } from "./vat";

// ── What the form boxes hold: reading, writing and checking phones, plates and official numbers ───────────────────
// The checks return what's wrong in words for the person typing, or null. An empty box is always fine.

type Check = (v: string) => string | null;

/** A value that was already there doesn't block a save, however wrong, until it's changed. */
export function changedProblem(before: string | null | undefined, now: string | null | undefined, check: Check): string | null {
  return (before ?? "") === (now ?? "") ? null : check(now ?? "");
}

// ── Phones ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const COUNTRIES: readonly { iso: string; name: string; dial: string }[] = [
  { iso: "AE", name: "United Arab Emirates", dial: "971" }, { iso: "SA", name: "Saudi Arabia", dial: "966" }, { iso: "OM", name: "Oman", dial: "968" },
  { iso: "QA", name: "Qatar", dial: "974" }, { iso: "KW", name: "Kuwait", dial: "965" }, { iso: "BH", name: "Bahrain", dial: "973" },
  { iso: "IN", name: "India", dial: "91" }, { iso: "PK", name: "Pakistan", dial: "92" }, { iso: "BD", name: "Bangladesh", dial: "880" },
  { iso: "LK", name: "Sri Lanka", dial: "94" }, { iso: "NP", name: "Nepal", dial: "977" }, { iso: "PH", name: "Philippines", dial: "63" },
  { iso: "EG", name: "Egypt", dial: "20" }, { iso: "JO", name: "Jordan", dial: "962" }, { iso: "LB", name: "Lebanon", dial: "961" },
  { iso: "SY", name: "Syria", dial: "963" }, { iso: "YE", name: "Yemen", dial: "967" }, { iso: "IQ", name: "Iraq", dial: "964" },
  { iso: "IR", name: "Iran", dial: "98" }, { iso: "TR", name: "Türkiye", dial: "90" }, { iso: "GB", name: "United Kingdom", dial: "44" },
  { iso: "US", name: "United States", dial: "1" }, { iso: "DE", name: "Germany", dial: "49" }, { iso: "FR", name: "France", dial: "33" },
  { iso: "IT", name: "Italy", dial: "39" }, { iso: "CN", name: "China", dial: "86" }, { iso: "JP", name: "Japan", dial: "81" },
  { iso: "KR", name: "South Korea", dial: "82" }, { iso: "ZA", name: "South Africa", dial: "27" }, { iso: "KE", name: "Kenya", dial: "254" },
  { iso: "NG", name: "Nigeria", dial: "234" }, { iso: "RU", name: "Russia", dial: "7" }, { iso: "SD", name: "Sudan", dial: "249" },
  { iso: "ET", name: "Ethiopia", dial: "251" }, { iso: "AF", name: "Afghanistan", dial: "93" }, { iso: "MA", name: "Morocco", dial: "212" },
  { iso: "UG", name: "Uganda", dial: "256" },
];

/** `national`: the digits after the country code, without a leading 0. */
export interface Phone { iso: string; national: string }

const UAE_NUMBER = /^(5\d{8}|[234679]\d{7}|800\d{4,7}|600\d{6})$/;

/** A phone number, or null when the text isn't exactly one (two numbers, words, too short). No country code: UAE. */
export function parsePhone(text: string): Phone | null {
  const t = text.trim().replace(/\(0\)/g, "").replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(t)) return null;
  const abroad = t.startsWith("+") ? t.slice(1) : t.startsWith("00") ? t.slice(2) : null;
  if (abroad === null) {
    const digits = /^971\d{8,9}$/.test(t) ? t.slice(3) : t;
    const national = digits.replace(/^0/, "");
    return UAE_NUMBER.test(national) ? { iso: "AE", national } : null;
  }
  const country = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length).find((c) => abroad.startsWith(c.dial));
  if (!country) return null;
  // Italian landlines keep their leading 0 after the code; elsewhere it's dropped.
  const national = country.iso === "IT" ? abroad.slice(country.dial.length) : abroad.slice(country.dial.length).replace(/^0/, "");
  if (country.iso === "AE") return UAE_NUMBER.test(national) ? { iso: "AE", national } : null;
  return /^\d{6,14}$/.test(national) ? { iso: country.iso, national } : null;
}

/** The part after the country code, spaced for reading. */
export function nationalText(p: Phone): string {
  const n = p.national;
  if (p.iso !== "AE") return n;
  if (/^[68]00/.test(n)) return `${n.slice(0, 3)} ${n.slice(3)}`;
  return n.length === 9 ? `${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}` : `${n.slice(0, 1)} ${n.slice(1, 4)} ${n.slice(4)}`;
}

/** How a phone is kept and printed: +971 50 123 4567 (800 and 600 numbers have no country code). */
export function formatPhone(p: Phone): string {
  if (p.iso === "AE" && /^[68]00/.test(p.national)) return nationalText(p);
  return `+${COUNTRIES.find((c) => c.iso === p.iso)!.dial} ${nationalText(p)}`;
}

/** What a phone is searched by: its digits without the UAE code or leading 0. Words give "". */
export const phoneDigits = (q: string): string => (/[a-z]/i.test(q) ? "" : q.replace(/\D/g, "").replace(/^00/, "").replace(/^971/, "").replace(/^0/, ""));

export const checkPhone: Check = (v) => {
  if (!v.trim() || parsePhone(v)) return null;
  // A full number from a country that isn't in the list is kept as typed.
  const full = /^(?:\+|00)(\d{7,15})$/.exec(v.trim().replace(/[\s\-().]/g, ""))?.[1];
  if (full && !COUNTRIES.some((c) => full.startsWith(c.dial))) return null;
  return /^(\+971|00971|971|0)?5[\d ]*$/.test(v.trim().replace(/[\-().]/g, "").replace(/^(\+971|00971|971) ?0?/, "0")) ? "A UAE mobile has 10 digits, like 050 123 4567" : "That isn't a phone number";
};

// ── Plates ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const PLATE_EMIRATES: readonly { code: string; emirate: Emirate }[] = [
  { code: "DXB", emirate: "dubai" }, { code: "AUH", emirate: "abu_dhabi" }, { code: "SHJ", emirate: "sharjah" }, { code: "AJM", emirate: "ajman" },
  { code: "UAQ", emirate: "umm_al_quwain" }, { code: "RAK", emirate: "ras_al_khaimah" }, { code: "FUJ", emirate: "fujairah" },
];
const PLATE_NAMES: [RegExp, string][] = [
  [/^(DXB|DUBAI)\b/, "DXB"], [/^(AUH|AD|ABU ?DHABI)\b/, "AUH"], [/^(SHJ|SHARJAH)\b/, "SHJ"], [/^(AJM|AJMAN)\b/, "AJM"],
  [/^(UAQ|UMM AL QUWAIN)\b/, "UAQ"], [/^(RAK|RAS AL KHAIMAH)\b/, "RAK"], [/^(FUJ|FUJAIRAH)\b/, "FUJ"],
];

export interface Plate { emirate: string; code: string; number: string }

const plateName = (text: string) => {
  const t = text.trim().toUpperCase().replace(/[\s\-]+/g, " ");
  const found = PLATE_NAMES.find(([re]) => re.test(t));
  return found ? { emirate: found[1], rest: t.replace(found[0], "").trim() } : null;
};

/** A UAE plate (emirate, code, number), or null. */
export function parsePlate(text: string): Plate | null {
  const p = plateName(text);
  if (!p) return null;
  const m = /^(?:([A-Z]{1,2}) ?|(\d{1,2}) )?(\d{1,5})$/.exec(p.rest);
  return m ? { emirate: p.emirate, code: m[1] ?? m[2] ?? "", number: m[3]! } : null;
}

export const formatPlate = (p: Plate): string => [p.emirate, p.code, p.number].filter(Boolean).join(" ");

/** A plate that names an emirate is checked; one from elsewhere is as typed. */
export const checkPlate: Check = (v) => (!plateName(v) || parsePlate(v) ? null : "A UAE plate is a code (like K or 12) and up to 5 digits");

// ── Official numbers ──────────────────────────────────────────────────────────────────────────────────────────────
const noSpaces = (v: string) => v.replace(/\s/g, "");
const groups = (v: string, sizes: number[]) => {
  const out: string[] = [];
  let at = 0;
  for (const n of sizes) {
    if (at < v.length) out.push(v.slice(at, at + n));
    at += n;
  }
  return out.join(" ");
};

export const checkTrn: Check = (v) => {
  const t = noSpaces(v);
  if (!t) return null;
  if (!/^\d+$/.test(t)) return "A UAE TRN has digits only";
  return t.length === 15 ? null : `A UAE TRN has 15 digits (this has ${t.length})`;
};
export const formatTrn = (v: string): string => groups(noSpaces(v), [3, 4, 4, 4]);

export const checkIban: Check = (v) => {
  const t = noSpaces(v).toUpperCase();
  if (!t) return null;
  if (!/^AE\d{21}$/.test(t)) return "A UAE IBAN is AE followed by 21 digits";
  return ibanValid(t) ? null : "That IBAN's check digits are wrong: check it against the bank's letter";
};
export const formatIban = (v: string): string => groups(noSpaces(v).toUpperCase(), [4, 4, 4, 4, 4, 4]);

/** Only a note: imported vehicles can have shorter chassis numbers. */
export const vinNote: Check = (v) => {
  const t = noSpaces(v).toUpperCase();
  if (!t) return null;
  if (t.length !== 17) return `A VIN usually has 17 characters (this has ${t.length})`;
  return /[IOQ]/.test(t) ? "A VIN doesn't use the letters I, O or Q" : null;
};

export const checkYear: Check = (v) => {
  const t = v.trim();
  const latest = new Date().getFullYear() + 1;
  return !t || (/^\d{4}$/.test(t) && Number(t) >= 1900 && Number(t) <= latest) ? null : `Enter a year from 1900 to ${latest}`;
};
export const checkOdometer: Check = (v) => (/^\d{0,7}$/.test(v.replace(/[,\s]/g, "")) ? null : "Enter the kilometres in digits");

export const checkEmiratesId: Check = (v) => {
  const t = v.replace(/[\s-]/g, "");
  return !t || /^784\d{12}$/.test(t) ? null : "An Emirates ID has 15 digits starting 784";
};
export const formatEmiratesId = (v: string): string => {
  const t = v.replace(/[\s-]/g, "");
  return /^784\d{12}$/.test(t) ? `${t.slice(0, 3)}-${t.slice(3, 7)}-${t.slice(7, 14)}-${t.slice(14)}` : v;
};

export const checkEmail: Check = (v) => (!v.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : "Enter an email like name@company.ae");
