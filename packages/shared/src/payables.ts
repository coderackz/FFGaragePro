import { z } from "zod";
import { roundFils } from "./money";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");
const fils = z.number().int().min(0).max(10_000_000_000_00);
const positive = z.number().int().positive("Enter an amount").max(10_000_000_000_00);
const id = z.string().min(1);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);

// ── Supplier bills ─────────────────────────────────────────────────────────────────────────────────────────────────
/** A bill line's VAT: standard (5% of net, rounded per line) or none. */
export const BILL_VAT = ["standard", "none"] as const;
export type BillVat = (typeof BILL_VAT)[number];
export const VAT_RATE = 0.05;

export const billLineSchema = z.object({
  accountId: id,
  description: z.string().trim().min(1, "Say what the line is for").max(200),
  netFils: fils,
  vat: z.enum(BILL_VAT).default("standard"),
});
export type BillLineInput = z.infer<typeof billLineSchema>;

export const lineVat = (l: { netFils: number; vat: BillVat }) => (l.vat === "standard" ? roundFils(l.netFils * VAT_RATE) : 0);

export function billTotals(lines: { netFils: number; vat: BillVat }[]): { netFils: number; vatFils: number; grossFils: number } {
  const netFils = lines.reduce((s, l) => s + l.netFils, 0);
  const vatFils = lines.reduce((s, l) => s + lineVat(l), 0);
  return { netFils, vatFils, grossFils: netFils + vatFils };
}

export const supplierBillSchema = z.object({
  supplierId: z.string().uuid(),
  supplierInvoiceNo: z.string().trim().min(1, "Enter the supplier's invoice number").max(60),
  billDate: ymd,
  dueDate: ymd.nullable().optional().transform((v) => v ?? null),
  notes: optionalText(1000),
  lines: z.array(billLineSchema).min(1, "A bill needs at least one line").max(100),
});
export type SupplierBillInput = z.infer<typeof supplierBillSchema>;

// ── Paying suppliers ───────────────────────────────────────────────────────────────────────────────────────────────
export const SUPPLIER_PAYMENT_METHODS = ["cash", "bank_transfer", "card", "cheque"] as const;
export const payableTargetSchema = z.object({ target: z.enum(["bill", "goods_receipt", "opening"]), id, amountFils: positive });
export type PayableTarget = z.infer<typeof payableTargetSchema>;

export const supplierPaymentSchema = z.object({
  supplierId: z.string().uuid(),
  amountFils: positive,
  method: z.enum(SUPPLIER_PAYMENT_METHODS),
  paidFromAccountId: id,
  reference: optionalText(120),
  chequeNo: optionalText(40),
  chequeDate: ymd.nullable().optional().transform((v) => v ?? null),
  paidAt: ymd.optional(),
  allocations: z.array(payableTargetSchema).max(200).optional(),
});
export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>;

// ── Expenses paid on the spot ──────────────────────────────────────────────────────────────────────────────────────
const MAX_PHOTO_BYTES = 1024 * 1024;
function isPhoto(v: string): boolean {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m || m[2]!.length % 4 !== 0) return false;
  const b64 = m[2]!;
  const bytes = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return bytes > 0 && bytes <= MAX_PHOTO_BYTES;
}
export const photoSchema = z
  .preprocess((v) => (v === "" || v === undefined ? null : v), z.string().refine(isPhoto, "Use a PNG or JPG photo under 1 MB").nullable())
  .default(null);

export const expenseSchema = z.object({
  date: ymd,
  accountId: id,
  description: z.string().trim().min(1, "Say what it was for").max(200),
  netFils: positive,
  vat: z.enum(BILL_VAT).default("standard"),
  paidFromAccountId: id,
  payee: optionalText(120),
  reference: optionalText(120),
  photo: photoSchema,
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

// ── Moving money ───────────────────────────────────────────────────────────────────────────────────────────────────
export const transferSchema = z
  .object({ date: ymd, fromAccountId: id, toAccountId: id, amountFils: positive, reference: optionalText(120) })
  .refine((t) => t.fromAccountId !== t.toAccountId, { message: "Choose two different accounts", path: ["toAccountId"] });

export const chequeDepositSchema = z.object({ receiptIds: z.array(id).min(1).max(100), bankAccountId: id, date: ymd });
export const chequeClearSchema = z.object({ paymentIds: z.array(id).min(1).max(100), date: ymd });

// ── Bank statements ────────────────────────────────────────────────────────────────────────────────────────────────
export const DATE_FORMATS = ["dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd"] as const;
const col = z.number().int().min(0).max(50);
export const bankMappingSchema = z
  .object({
    date: col,
    description: col,
    amount: col.optional(),
    debit: col.optional(),
    credit: col.optional(),
    reference: col.optional(),
    dateFormat: z.enum(DATE_FORMATS),
    hasHeader: z.boolean().default(true),
  })
  .refine((m) => m.amount !== undefined || (m.debit !== undefined && m.credit !== undefined), {
    message: "Choose an amount column, or both a debit and a credit column",
    path: ["amount"],
  });
export type BankMapping = z.infer<typeof bankMappingSchema>;

export interface StatementLine { date: string; description: string; amountFils: number; reference: string | null }

function parseDate(text: string, format: (typeof DATE_FORMATS)[number]): string {
  const t = text.trim();
  const m = format === "yyyy-mm-dd" ? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t) : /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (!m) throw new Error(`"${t}" isn't a date like ${format}`);
  const [y, mo, d] = format === "yyyy-mm-dd" ? [m[1], m[2], m[3]] : format === "dd/mm/yyyy" ? [m[3], m[2], m[1]] : [m[3], m[1], m[2]];
  const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  const back = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso) throw new Error(`"${t}" isn't a real date`);
  return iso;
}

/** "1,234.50" → 123450; "(12.00)" or "-12.00" → -1200; blank → 0. */
function parseMoney(text: string | undefined): number {
  const t = (text ?? "").trim().replace(/[,\s]/g, "").replace(/^AED/i, "");
  if (!t) return 0;
  const negative = /^\(.*\)$/.test(t) || t.startsWith("-");
  const n = Number(t.replace(/[()]/g, "").replace(/^-/, ""));
  if (!Number.isFinite(n)) throw new Error(`"${text}" isn't an amount`);
  return (negative ? -1 : 1) * roundFils(n * 100);
}

/** A bank's CSV rows as statement lines, by the account's column mapping. Money out is negative. */
export function parseStatement(rows: string[][], m: BankMapping): StatementLine[] {
  const out: StatementLine[] = [];
  rows.forEach((row, i) => {
    if (i === 0 && m.hasHeader) return;
    if (row.every((c) => !c.trim())) return;
    try {
      const amountFils = m.amount !== undefined ? parseMoney(row[m.amount]) : parseMoney(row[m.credit!]) - Math.abs(parseMoney(row[m.debit!]));
      out.push({
        date: parseDate(row[m.date] ?? "", m.dateFormat),
        description: (row[m.description] ?? "").trim(),
        amountFils,
        reference: m.reference !== undefined ? (row[m.reference] ?? "").trim() || null : null,
      });
    } catch (error) {
      throw new Error(`Row ${i + 1}: ${(error as Error).message}`);
    }
  });
  return out;
}
