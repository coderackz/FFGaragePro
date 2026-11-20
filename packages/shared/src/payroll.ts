import { z } from "zod";

// ── Pay rules the garage chooses (Settings → Payroll); no hidden defaults ─────────────────────────────────────────
export type SalaryDayRate = "gross_30" | "gross_365";
export type GratuityDayRate = "basic_30" | "basic_365";
export type DayRateRule = SalaryDayRate | GratuityDayRate;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");
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
    iban: z.string().trim().toUpperCase().regex(/^AE\d{21}$/, "Use a UAE IBAN like AE07 0331 2345 6789 0123 456").nullable().optional().transform((v) => v ?? null),
    cardNumber: optText(30),
    routingCode: z.string().trim().regex(/^\d{9}$/, "The bank routing code has 9 digits").nullable().optional().transform((v) => v ?? null),
    personId: z.string().trim().regex(/^\d{14}$/, "The MOHRE person ID has 14 digits").nullable().optional().transform((v) => v ?? null),
    emiratesId: optText(30), emiratesIdExpiry: optDate,
    labourCard: optText(30), labourCardExpiry: optDate,
    passport: optText(30), passportExpiry: optDate,
    visa: optText(30), visaExpiry: optDate,
    language: z.enum(["en", "en_ar"]).default("en"),
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
  extrasNote: optText(120),
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
  const unpaidDeductionFils = Math.round(dayRate(gross, input.salaryDayRate) * unpaidDays);
  const advanceRepaymentFils = input.advanceDueFils;
  return {
    workedDays, basicFils, allowancesFils, unpaidDays, unpaidDeductionFils, advanceRepaymentFils, extrasFils: 0, bonusFils: 0,
    netFils: basicFils + allowancesFils - unpaidDeductionFils - advanceRepaymentFils,
  };
}

/** Calendar days of service from joining up to `asOf` (inclusive), less unpaid leave (it doesn't count as service). */
export function serviceDays(joinDate: string, asOf: string, unpaidLeave: { from: string; to: string }[]): number {
  const span = { from: joinDate, to: asOf };
  return Math.max(daysIn(span, span) - unpaidLeave.reduce((s, l) => s + daysIn(l, span), 0), 0);
}

/**
 * End-of-service gratuity (Decree-Law 33 of 2021): 21 days of basic for each of the first five years, 30 days for each
 * year after, pro rata, capped at two years of basic or gross (the garage's choice).
 */
export function gratuityOwed(i: { basicFils: number; grossFils: number; serviceDays: number; dayRate: GratuityDayRate; cap: "basic" | "gross" }): number {
  const years = i.serviceDays / 365;
  const days = 21 * Math.min(years, 5) + 30 * Math.max(years - 5, 0);
  const owed = Math.round(dayRate(i.basicFils, i.dayRate) * days);
  return Math.min(owed, 24 * (i.cap === "basic" ? i.basicFils : i.grossFils));
}

/** Annual leave: 2.5 days for each whole month of service, less annual leave taken. */
export function annualLeaveBalance(joinDate: string, asOf: string, annualTaken: { from: string; to: string }[]): number {
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
