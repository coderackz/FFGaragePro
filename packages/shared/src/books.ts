import { z } from "zod";

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "cost_of_sales", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Debit-balance account types (assets, costs); the rest are credit-balance. */
export const DEBIT_TYPES: readonly AccountType[] = ["asset", "cost_of_sales", "expense"];

export interface ChartAccount { id: string; code: string; name: string; type: AccountType; systemKey: SystemKey | null }

/** Every garage shares these ids, so accounts are the same rows on every PC and the cloud. */
const accountIdOf = (code: string) => `00000000-0000-4000-8000-0000000a${code}`;
const typeOf = (code: string): AccountType => ACCOUNT_TYPES[Number(code[0]) - 1]!;

const SYSTEM = {
  cash: ["1000", "Cash on hand"],
  card_clearing: ["1010", "Card receipts clearing"],
  bank: ["1020", "Bank"],
  cheques_in_hand: ["1030", "Cheques in hand"],
  receivables: ["1100", "Accounts receivable"],
  inventory: ["1200", "Inventory"],
  wip: ["1210", "Work in progress"],
  vat_input: ["1300", "Input VAT"],
  payables: ["2000", "Accounts payable"],
  vat_output: ["2100", "Output VAT"],
  vat_payable: ["2110", "VAT payable"],
  opening_clearing: ["2900", "Opening balance clearing"],
  retained_earnings: ["3200", "Retained earnings"],
  opening_equity: ["3300", "Opening balance equity"],
  sales_labour: ["4000", "Labour sales"],
  sales_parts: ["4010", "Parts sales"],
  sales_other: ["4020", "Other income"],
  cogs_parts: ["5000", "Cost of parts sold"],
  stock_adjustments: ["5010", "Stock adjustments"],
  stock_revaluation: ["5020", "Stock revaluation"],
  purchases_other: ["5030", "Other purchases"],
} as const;
export type SystemKey = keyof typeof SYSTEM;

/** Accounts the automatic entries post to: they can be renamed, not retyped or removed. */
export const SYSTEM_ACCOUNTS = Object.fromEntries(
  Object.entries(SYSTEM).map(([key, [code, name]]) => [key, { id: accountIdOf(code), code, name, type: typeOf(code) }]),
) as Record<SystemKey, { id: string; code: string; name: string; type: AccountType }>;

const OTHER: [string, string][] = [
  ["1400", "Prepayments"], ["1500", "Tools and equipment"], ["1510", "Vehicles"], ["1590", "Accumulated depreciation"],
  ["2200", "Salaries payable"],
  ["3000", "Owner's capital"], ["3100", "Owner's drawings"],
  ["6000", "Salaries"], ["6010", "Rent"], ["6020", "Utilities"], ["6030", "Bank charges"], ["6040", "Fuel"],
  ["6050", "Repairs and maintenance"], ["6060", "Office and admin"], ["6090", "Other expenses"],
];

/** The default chart of accounts for a UAE garage, by code: 1 assets, 2 liabilities, 3 equity, 4 income, 5 cost of sales, 6 expenses. */
export const DEFAULT_CHART: ChartAccount[] = [
  ...Object.entries(SYSTEM_ACCOUNTS).map(([key, a]) => ({ ...a, systemKey: key as SystemKey })),
  ...OTHER.map(([code, name]) => ({ id: accountIdOf(code), code, name, type: typeOf(code), systemKey: null })),
].sort((a, b) => a.code.localeCompare(b.code));

export const accountSchema = z.object({
  code: z.string().trim().regex(/^\d{4}$/, "Use a 4-digit code"),
  name: z.string().trim().min(1, "Name is required").max(80),
  type: z.enum(ACCOUNT_TYPES),
});
export type AccountInput = z.infer<typeof accountSchema>;

const fils = z.number().int().min(0).max(10_000_000_000_00);
const optionalId = z.string().nullable().optional().transform((v) => v ?? null);

export const journalLineSchema = z
  .object({
    accountId: z.string().min(1),
    debitFils: fils.default(0),
    creditFils: fils.default(0),
    customerId: optionalId,
    supplierId: optionalId,
    /** Work in progress lines: the job card (opening balances carry it so the job's invoice clears it). */
    documentId: optionalId,
    memo: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
  })
  .refine((l) => (l.debitFils > 0) !== (l.creditFils > 0), { message: "Each line is either a debit or a credit", path: ["debitFils"] });
export type JournalLineInput = z.infer<typeof journalLineSchema>;

export const journalDraftSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31"),
    narration: z.string().trim().min(1, "Say what the journal is for").max(300),
    lines: z.array(journalLineSchema).min(2, "A journal needs at least two lines").max(200),
  })
  .refine((j) => j.lines.reduce((s, l) => s + l.debitFils, 0) === j.lines.reduce((s, l) => s + l.creditFils, 0), {
    message: "Debits and credits must be equal",
    path: ["lines"],
  });
export type JournalDraftInput = z.infer<typeof journalDraftSchema>;
