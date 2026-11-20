import { z } from "zod";

// ── Pay rules the garage chooses (Settings → Payroll); no hidden defaults ─────────────────────────────────────────
export type SalaryDayRate = "gross_30" | "gross_365";
export type GratuityDayRate = "basic_30" | "basic_365";
export type DayRateRule = SalaryDayRate | GratuityDayRate;

/** A real calendar date (2026-02-31 is refused). */
export const isRealDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31").refine(isRealDate, "That isn't a real date");

/** IBAN check digits (ISO 13616, mod 97). */
export function ibanValid(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}
const noSpaces = (v: unknown) => (typeof v === "string" ? v.replace(/\s/g, "") : v);
const fils = z.number().int().min(0).max(10_000_000_00);
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const optDate = ymd.nullable().optional().transform((v) => v ?? null);

export const employeeSchema = z
  .object({
    name: z.string().trim().min(1, "Enter the name").max(120),
    nameAr: optText(120),
    job: z.string().trim().min(1, "Enter the job").max(80),
    nationality: optText(60),
    joinDate: ymd,
    leftDate: optDate,
    basicFils: fils,
    housingFils: fils.default(0),
    transportFils: fils.default(0),
    otherAllowanceFils: fils.default(0),
    payMethod: z.enum(["bank", "salary_card"]).default("bank"),
    iban: z.preprocess(noSpaces, z.string().toUpperCase().regex(/^AE\d{21}$/, "Use a UAE IBAN like AE07 0331 2345 6789 0123 456")
      .refine(ibanValid, "That IBAN's check digits are wrong: check it against the bank's letter").nullable().optional()).transform((v) => v ?? null),
    cardNumber: optText(30),
    routingCode: z.preprocess(noSpaces, z.string().regex(/^\d{9}$/, "The bank routing code has 9 digits").nullable().optional()).transform((v) => v ?? null),
    personId: z.preprocess(noSpaces, z.string().regex(/^\d{14}$/, "The MOHRE person ID has 14 digits").nullable().optional()).transform((v) => v ?? null),
    emiratesId: optText(30), emiratesIdExpiry: optDate,
    labourCard: optText(30), labourCardExpiry: optDate,
    passport: optText(30), passportExpiry: optDate,
    visa: optText(30), visaExpiry: optDate,
    language: z.enum(["en", "en_ar"]).default("en"),
    /** Annual leave days owed on a date (from before the app): leave builds up from there instead of from joining. */
    leaveBalanceDays: z.number().min(-365).max(1000).nullable().optional().transform((v) => v ?? null),
    leaveBalanceDate: optDate,
    phone: optText(30),
    email: optText(120),
  })
  .refine((e) => !e.leftDate || e.leftDate >= e.joinDate, { message: "The leaving date is before the joining date", path: ["leftDate"] });
export type EmployeeInput = z.infer<typeof employeeSchema>;

export const leaveSchema = z
  .object({ kind: z.enum(["annual", "sick", "unpaid"]), from: ymd, to: ymd, note: optText(200) })
  .refine((l) => l.to >= l.from, { message: "The leave ends before it starts", path: ["to"] });
export const advanceSchema = z.object({
  amountFils: fils.refine((v) => v > 0, "Enter an amount"),
  paidOn: ymd,
  paidFromAccountId: z.string().min(1),
  instalmentFils: fils.refine((v) => v > 0, "Enter the monthly instalment"),
  note: optText(200),
});
export const runLineEditSchema = z.object({
  bonusFils: fils.optional(),
  extrasFils: z.number().int().min(-10_000_000_00).max(10_000_000_00).optional(),
  // Left out, the note stays as it is; sent empty, it's cleared.
  extrasNote: z.string().trim().max(120).nullable().optional().transform((v) => (v === undefined ? undefined : v || null)),
  advanceRepaymentFils: fils.optional(),
});

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromT = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function monthDays(month: string): { from: string; to: string; days: number } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const from = `${month}-01`;
  const to = fromT(Date.UTC(y, m, 0));
  return { from, to, days: Number(to.slice(8)) };
}

/** Days of `range` inside `within`, both inclusive (0 when they don't meet). */
export function daysIn(range: { from: string; to: string }, within: { from: string; to: string }): number {
  const from = Math.max(t(range.from), t(within.from));
  const to = Math.min(t(range.to), t(within.to));
  return to < from ? 0 : Math.round((to - from) / DAY) + 1;
}

/** A day's pay: ÷ 30, or × 12 ÷ 365 (the garage's choice), in fractional fils. */
export const dayRate = (monthlyFils: number, rule: DayRateRule) => (rule.endsWith("_30") ? monthlyFils / 30 : (monthlyFils * 12) / 365);

// ── A month's pay ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface PayEmployee { basicFils: number; housingFils: number; transportFils: number; otherAllowanceFils: number; joinDate: string; leftDate: string | null }
export interface PayLine {
  workedDays: number; basicFils: number; allowancesFils: number; unpaidDays: number; unpaidDeductionFils: number;
  advanceRepaymentFils: number; extrasFils: number; bonusFils: number; netFils: number;
}

/**
 * What someone is paid for a month: basic and allowances (a part month by the salary day rate), less unpaid leave inside
 * the days worked, less the advance instalment. Extras and the bonus are typed in by the accountant afterwards.
 */
export function proposeLine(input: { month: string; employee: PayEmployee; unpaidLeave: { from: string; to: string }[]; salaryDayRate: SalaryDayRate; advanceDueFils: number }): PayLine {
  const m = monthDays(input.month);
  const e = input.employee;
  const worked = { from: e.joinDate > m.from ? e.joinDate : m.from, to: e.leftDate && e.leftDate < m.to ? e.leftDate : m.to };
  const workedDays = daysIn(worked, m);
  const allowances = e.housingFils + e.transportFils + e.otherAllowanceFils;
  const gross = e.basicFils + allowances;
  let basicFils = e.basicFils;
  let allowancesFils = allowances;
  if (workedDays < m.days) {
    const total = Math.round(dayRate(gross, input.salaryDayRate) * workedDays);
    basicFils = gross ? Math.round((total * e.basicFils) / gross) : 0;
    allowancesFils = total - basicFils;
  }
  const unpaidDays = workedDays ? input.unpaidLeave.reduce((s, l) => s + daysIn(l, worked), 0) : 0;
  // A whole month unpaid takes everything; otherwise the day rate, never more than the pay itself.
  const unpaidDeductionFils = unpaidDays >= workedDays && workedDays > 0
    ? basicFils + allowancesFils
    : Math.min(Math.round(dayRate(gross, input.salaryDayRate) * unpaidDays), basicFils + allowancesFils);
  const advanceRepaymentFils = input.advanceDueFils;
  return {
    workedDays, basicFils, allowancesFils, unpaidDays, unpaidDeductionFils, advanceRepaymentFils, extrasFils: 0, bonusFils: 0,
    netFils: basicFils + allowancesFils - unpaidDeductionFils - advanceRepaymentFils,
  };
}

/** Calendar days of service from joining up to `asOf` (inclusive), less unpaid leave (it doesn't count as service). */
export function serviceDays(joinDate: string, asOf: string, unpaidLeave: { from: string; to: string }[]): number {
  const span = { from: joinDate, to: asOf };
  return Math.max(daysIn(span, span) - mergeRanges(unpaidLeave).reduce((s, l) => s + daysIn(l, span), 0), 0);
}

/** Date ranges as one set: overlapping or touching ranges merge (leave entered twice counts once). */
export function mergeRanges(ranges: { from: string; to: string }[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const r of [...ranges].sort((a, b) => a.from.localeCompare(b.from))) {
    const last = out.at(-1);
    if (last && t(r.from) <= t(last.to) + DAY) { if (r.to > last.to) last.to = r.to; } else out.push({ ...r });
  }
  return out;
}

const addYears = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y + n, m - 1, d)).toISOString().slice(0, 10);
};

/**
 * Years of service by anniversary: from joining (moved on by the unpaid days, which don't count) through `asOf`
 * inclusive. Whole years, plus the part of the year after the last anniversary.
 */
export function serviceYears(joinDate: string, asOf: string, unpaidLeave: { from: string; to: string }[]): number {
  const span = { from: joinDate, to: asOf };
  const unpaid = mergeRanges(unpaidLeave).reduce((s, l) => s + daysIn(l, span), 0);
  const start = fromT(t(joinDate) + unpaid * DAY);
  const end = fromT(t(asOf) + DAY);
  if (end <= start) return 0;
  let full = 0;
  while (addYears(start, full + 1) <= end) full++;
  const from = addYears(start, full);
  return full + (t(end) - t(from)) / (t(addYears(start, full + 1)) - t(from));
}

/**
 * End-of-service gratuity (Decree-Law 33 of 2021): 21 days of basic for each of the first five years, 30 days for each
 * year after, pro rata, capped at two years of basic or gross (the garage's choice).
 */
export function gratuityOwed(i: { basicFils: number; grossFils: number; serviceDays?: number; serviceYears?: number; dayRate: GratuityDayRate; cap: "basic" | "gross" }): number {
  const years = i.serviceYears ?? (i.serviceDays ?? 0) / 365;
  const days = 21 * Math.min(years, 5) + 30 * Math.max(years - 5, 0);
  const owed = Math.round(dayRate(i.basicFils, i.dayRate) * days);
  return Math.min(owed, 24 * (i.cap === "basic" ? i.basicFils : i.grossFils));
}

/**
 * Annual leave: 2.5 days for each whole month of service, less annual leave taken. With an opening balance (days owed
 * on a date, from before the app), it builds from that date instead, and only leave taken from then counts.
 */
export function annualLeaveBalance(joinDate: string, asOf: string, annualTaken: { from: string; to: string }[], opening?: { days: number; date: string } | null): number {
  if (opening) {
    return opening.days + annualLeaveBalance(opening.date, asOf, annualTaken.filter((l) => l.from >= opening.date));
  }
  const [y1, m1, d1] = joinDate.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = asOf.split("-").map(Number) as [number, number, number];
  const months = Math.max((y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0), 0);
  return 2.5 * months - annualTaken.reduce((s, l) => s + daysIn(l, l), 0);
}

// ── The WPS salary information file (SIF) ──────────────────────────────────────────────────────────────────────────
export interface SifLine { name: string; personId: string | null; routingCode: string | null; account: string | null; from: string; to: string; days: number; fixedFils: number; variableFils: number; leaveDays: number }
export interface SifInput { establishmentId: string | null; employerRoutingCode: string | null; month: string; createdAt: Date; reference: string; lines: SifLine[] }

const aed = (f: number) => (f / 100).toFixed(2);

/**
 * The MOHRE SIF: one EDR line per employee, then the employer's SCR line, CRLF; named <employer ID><YYMMDDHHMMSS>.SIF
 * (Dubai time). One real file accepted by the garage's bank confirms the layout (spec open question 1).
 */
export function buildSif(i: SifInput): { fileName: string; text: string } {
  if (!/^\d{13}$/.test(i.establishmentId ?? "")) throw new Error("The MOHRE establishment ID (13 digits) is missing in Settings → Payroll");
  if (!/^\d{9}$/.test(i.employerRoutingCode ?? "")) throw new Error("The employer's bank routing code (9 digits) is missing in Settings → Payroll");
  const edr = i.lines.map((l) => {
    if (!/^\d{14}$/.test(l.personId ?? "")) throw new Error(`${l.name}: the MOHRE person ID (14 digits) is missing`);
    if (!/^\d{9}$/.test(l.routingCode ?? "")) throw new Error(`${l.name}: the bank routing code (9 digits) is missing`);
    if (!l.account) throw new Error(`${l.name}: the IBAN or salary card number is missing`);
    return ["EDR", l.personId, l.routingCode, l.account, l.from, l.to, l.days, aed(l.fixedFils), aed(l.variableFils), l.leaveDays].join(",");
  });
  const dubai = new Date(i.createdAt.getTime() + 4 * 3_600_000).toISOString();
  const date = dubai.slice(0, 10);
  const time = dubai.slice(11, 19).replace(/:/g, "");
  const total = i.lines.reduce((s, l) => s + l.fixedFils + l.variableFils, 0);
  const scr = ["SCR", i.establishmentId, i.employerRoutingCode, date, time.slice(0, 4), `${i.month.slice(5)}${i.month.slice(0, 4)}`, i.lines.length, aed(total), "AED", i.reference].join(",");
  return { fileName: `${i.establishmentId}${date.slice(2).replace(/-/g, "")}${time}.SIF`, text: [...edr, scr, ""].join("\r\n") };
}

// ── A leaver's final settlement ────────────────────────────────────────────────────────────────────────────────────
export type SettlementKey = "salary" | "leave" | "gratuity" | "advances";
export interface SettlementItem { key: SettlementKey; label: string; proposedFils: number; amountFils: number; how: string; reason: string | null }
export interface SettlementRules { salaryDayRate: SalaryDayRate; gratuityDayRate: GratuityDayRate; gratuityCap: "basic" | "gross"; leaveBasis: "basic" | "gross" }

const aedText = (fils: number) => (fils / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RATE_TEXT: Record<DayRateRule, string> = { gross_30: "Gross ÷ 30", gross_365: "Gross × 12 ÷ 365", basic_30: "Basic ÷ 30", basic_365: "Basic × 12 ÷ 365" };
const monthText = (ymd: string) => new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));

/**
 * What a leaver is owed, item by item, each with how it was worked out: salary to the last day (unless that month's
 * payroll already paid it), leave not taken (or taken ahead, deducted), gratuity (after one year of service), less
 * advances still owed. The accountant may change an amount, with a reason, before the owner approves.
 */
export function settlementProposal(i: {
  employee: PayEmployee; lastDay: string; unpaidLeave: { from: string; to: string }[]; annualTaken: { from: string; to: string }[];
  rules: SettlementRules; salaryAlreadyPaid: boolean; gratuityHeldFils: number; advancesOwedFils: number;
  /** Annual leave owed on a date from before the app; without it, leave builds from joining (flagged when that's before the books). */
  leaveOpening?: { days: number; date: string } | null; booksStart?: string | null;
}): SettlementItem[] {
  const e = i.employee;
  const gross = e.basicFils + e.housingFils + e.transportFils + e.otherAllowanceFils;
  const item = (key: SettlementKey, label: string, fils: number, how: string): SettlementItem => ({ key, label, proposedFils: fils, amountFils: fils, how, reason: null });

  const month = i.lastDay.slice(0, 7);
  const pay = proposeLine({ month, employee: { ...e, leftDate: i.lastDay }, unpaidLeave: i.unpaidLeave, salaryDayRate: i.rules.salaryDayRate, advanceDueFils: 0 });
  const fullMonth = pay.workedDays === monthDays(month).days;
  const unpaidText = pay.unpaidDays ? `, less ${pay.unpaidDays} unpaid day${pay.unpaidDays === 1 ? "" : "s"} at ${RATE_TEXT[i.rules.salaryDayRate]}` : "";
  const salary = i.salaryAlreadyPaid
    ? item("salary", "Salary to the last day", 0, `Paid in the ${monthText(i.lastDay)} payroll`)
    : item("salary", "Salary to the last day", pay.basicFils + pay.allowancesFils - pay.unpaidDeductionFils,
      fullMonth ? `Full month (${pay.workedDays} days) of ${aedText(gross)}${unpaidText}`
        : `${pay.workedDays} days of ${aedText(gross)} a month at ${RATE_TEXT[i.rules.salaryDayRate]}${unpaidText}`);

  // Leave booked past the last day isn't taken.
  const taken = i.annualTaken.filter((l) => l.from <= i.lastDay).map((l) => ({ from: l.from, to: l.to > i.lastDay ? i.lastDay : l.to }));
  const days = annualLeaveBalance(e.joinDate, i.lastDay, mergeRanges(taken), i.leaveOpening);
  const unknownBefore = !i.leaveOpening && !!i.booksStart && e.joinDate < i.booksStart;
  const leaveBase = i.rules.leaveBasis === "basic" ? e.basicFils : gross;
  const leaveRule = (i.rules.salaryDayRate.endsWith("_30") ? `${i.rules.leaveBasis}_30` : `${i.rules.leaveBasis}_365`) as DayRateRule;
  const perDay = dayRate(leaveBase, leaveRule);
  const leave = item("leave", days >= 0 ? "Leave not taken" : "Leave taken ahead", Math.round(days * perDay),
    `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days >= 0 ? "not taken" : "taken ahead"} × (${aedText(leaveBase)} ${leaveRule.endsWith("_30") ? "÷ 30" : "× 12 ÷ 365"}) a day`
      + (unknownBefore ? `. Counted from joining: no leave balance was entered for before ${monthText(i.booksStart!)}, so leave taken then isn't known: check the days` : ""));

  const service = serviceDays(e.joinDate, i.lastDay, mergeRanges(i.unpaidLeave));
  const yearsOfService = serviceYears(e.joinDate, i.lastDay, i.unpaidLeave);
  const years = Math.floor(yearsOfService);
  const rest = Math.round((yearsOfService - years) * 365);
  const gratuity = yearsOfService < 1
    ? item("gratuity", "End-of-service gratuity", 0, `Under one year of service (${service} days): no gratuity`)
    : item("gratuity", "End-of-service gratuity",
      gratuityOwed({ basicFils: e.basicFils, grossFils: gross, serviceYears: yearsOfService, dayRate: i.rules.gratuityDayRate, cap: i.rules.gratuityCap }),
      `${years} year${years === 1 ? "" : "s"} ${rest} days: 21 days of basic a year (30 after five), at ${RATE_TEXT[i.rules.gratuityDayRate]}, capped at 2 years of ${i.rules.gratuityCap}`);

  const advances = item("advances", "Advances still owed", -i.advancesOwedFils, i.advancesOwedFils ? "Taken from the settlement" : "None owed");
  return [salary, leave, gratuity, advances];
}

export const settlementTotal = (items: { amountFils: number }[]) => items.reduce((s, x) => s + x.amountFils, 0);

export const settlementEditSchema = z.object({
  key: z.enum(["salary", "leave", "gratuity", "advances"]),
  amountFils: z.number().int().min(-10_000_000_00).max(10_000_000_00),
  reason: z.string().trim().min(3, "Say why the amount is changed").max(200),
});

