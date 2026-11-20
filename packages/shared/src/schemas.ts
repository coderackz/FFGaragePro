import { z } from "zod";
import { DOC_TYPES, ROLES } from "./rules";

const text = (max = 200) => z.string().trim().max(max);
const optionalText = (max = 200) => text(max).optional().nullable().transform((v) => (v ? v : null));
/** For PATCH bodies: a missing field stays undefined (leave it alone); empty clears it. */
const patchText = (max = 200) => text(max).optional().nullable().transform((v) => (v === undefined ? undefined : v || null));

export const garageSchema = z.object({
  name: text().min(1, "Garage name is required"),
  trn: optionalText(20),
  address: optionalText(500),
  phone: optionalText(40),
  email: optionalText(120),
});
export type GarageInput = z.infer<typeof garageSchema>;

export const passwordSchema = z.string().min(8, "Use at least 8 characters").max(200);

export const setupSchema = z.object({
  garage: garageSchema,
  owner: z.object({
    name: text().min(1, "Name is required"),
    username: text(60).min(3).regex(/^[a-z0-9._-]+$/i, "Letters, numbers, dot, dash or underscore"),
    password: passwordSchema,
  }),
});
export type SetupInput = z.infer<typeof setupSchema>;

export const loginSchema = z.object({ username: text(60).min(1), password: z.string().min(1).max(200) });

export const userCreateSchema = z.object({
  name: text().min(1),
  username: text(60).min(3).regex(/^[a-z0-9._-]+$/i),
  role: z.enum(ROLES),
  password: passwordSchema,
});
export const userUpdateSchema = z.object({
  name: text().min(1).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional(),
});

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31");

/** What a customer's documents are printed in: English, or English and Arabic side by side. */
export const DOC_LANGUAGES = ["en", "en_ar"] as const;
export type DocLanguage = (typeof DOC_LANGUAGES)[number];

export const customerSchema = z.object({
  kind: z.enum(["individual", "company"]).default("individual"),
  name: text().min(1, "Name is required"),
  phone: optionalText(40),
  email: optionalText(120),
  trn: optionalText(20),
  address: optionalText(500),
  notes: optionalText(2000),
  nameAr: optionalText(200),
  addressAr: optionalText(500),
  docLanguage: z.enum(DOC_LANGUAGES).default("en"),
  /** The language of messages to the customer's own phone/email (contacts have their own). */
  messageLanguage: z.enum(["en", "ar"]).default("en"),
  // Credit (Part 2): cash customers by default.
  creditAllowed: z.boolean().default(false),
  creditLimitFils: z.number().int().min(0).max(10_000_000_00).default(0),
  /** Payment terms in days; null = the garage's default (Settings → Customers & credit). */
  termsDays: z.number().int().min(0).max(365).nullable().default(null),
  discountPct: z.number().min(0).max(100).default(0),
  lpoRequired: z.boolean().default(false),
  /** Owed before using the app (negative = the customer is in credit). */
  openingBalanceFils: z.number().int().min(-10_000_000_00).max(10_000_000_00).default(0),
  openingBalanceDate: ymd.nullable().default(null),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export const vehicleSchema = z.object({
  customerId: z.string().uuid(),
  plate: text(20).min(1, "Plate is required").transform((v) => v.toUpperCase().replace(/\s+/g, " ")),
  make: optionalText(60),
  model: optionalText(60),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  vin: optionalText(40),
  colour: optionalText(40),
  odometer: z.number().int().min(0).optional().nullable(),
});
export type VehicleInput = z.infer<typeof vehicleSchema>;

export const LINE_KINDS = ["labour", "part", "other"] as const;
export const SUPPLIED_BY = ["garage", "fleetfix"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const lineSchema = z.object({
  kind: z.enum(LINE_KINDS),
  description: text(500).min(1, "Description is required"),
  qty: z.number().min(0).max(100000),
  unitPriceFils: z.number().int().min(0).max(10_000_000_00),
  discountPct: z.number().min(0).max(100).default(0),
  partId: z.string().uuid().nullable().optional(),
  suppliedBy: z.enum(SUPPLIED_BY).default("garage"),
  poLineId: z.string().uuid().nullable().optional(),
}).refine((l) => l.suppliedBy === "garage" || l.kind === "part", { message: "Only parts can be supplied by Fleet Fix", path: ["suppliedBy"] });
export type LineInput = z.infer<typeof lineSchema>;

/** The Owner's username and password, typed on the spot to approve something beyond the user's limit. */
export const approvalSchema = z.object({ username: text(60).min(1), password: z.string().min(1).max(200) });
export type ApprovalInput = z.infer<typeof approvalSchema>;

/** What can be started from scratch; a credit note is only ever made from an issued invoice. */
export const CREATABLE_DOC_TYPES = ["estimate", "jobcard", "invoice"] as const;

export const documentCreateSchema = z.object({
  type: z.enum(CREATABLE_DOC_TYPES),
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid().optional().nullable(),
  odometer: z.number().int().min(0).optional().nullable(),
  notes: optionalText(4000),
  lines: z.array(lineSchema).max(500).default([]),
  approval: approvalSchema.optional(),
  /** Job cards: the driver who gets "vehicle received/ready" messages. */
  driverName: optionalText(120),
  driverPhone: optionalText(40),
});
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

export const documentUpdateSchema = z.object({
  vehicleId: z.string().uuid().optional().nullable(),
  odometer: z.number().int().min(0).optional().nullable(),
  notes: patchText(4000),
  status: z.string().optional(),
  lines: z.array(lineSchema).max(500).optional(),
  approval: approvalSchema.optional(),
  lpoNumber: patchText(60),
  language: z.enum(DOC_LANGUAGES).optional(),
  /** Job cards: the driver who gets "vehicle received/ready" messages. */
  driverName: patchText(120),
  driverPhone: patchText(40),
});

/** Issuing an invoice: the customer's LPO number, and the Owner's approval when over the credit limit. */
export const issueSchema = z.object({
  lpoNumber: optionalText(60),
  approval: approvalSchema.optional(),
  /** The owner issues it with a promo code that has expired or been used up (recorded in the activity log). */
  promoOverride: z.boolean().optional(),
});

export const PAYMENT_METHODS = ["cash", "card", "bank_transfer", "cheque"] as const;
export const paymentSchema = z.object({
  amountFils: z.number().int().positive("Amount must be more than zero"),
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(120),
  paidAt: z.string().datetime().optional(),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

/** A payment from a customer, split across invoices (oldest first when not given). Negative = a refund of credit. */
export const receiptSchema = z.object({
  customerId: z.string().uuid(),
  amountFils: z.number().int().min(-10_000_000_00).max(10_000_000_00).refine((n) => n !== 0, "Amount can't be zero"),
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(120),
  chequeDate: ymd.nullable().optional(),
  receivedAt: z.string().datetime().optional(),
  allocations: z.array(z.object({ documentId: z.string().uuid(), amountFils: z.number().int().positive("Allocate more than zero") })).max(500).optional(),
});
export type ReceiptInput = z.infer<typeof receiptSchema>;

/** More allocations for a receipt: positive from what's left of it, negative to undo one. */
export const allocationSchema = z.object({
  allocations: z.array(z.object({ documentId: z.string().uuid(), amountFils: z.number().int().refine((n) => n !== 0, "Amount can't be zero") }))
    .min(1, "Choose at least one invoice").max(500),
});

/** A tax credit note against an issued invoice: chosen lines (or everything still uncredited) and why. */
export const creditNoteSchema = z.object({
  reason: z.string().trim().min(3, "Give a reason").max(500),
  lines: z.array(z.object({ lineId: z.string(), qty: z.number().positive().max(100000) })).max(500).optional(),
  returnToStock: z.boolean().default(true),
  approval: approvalSchema.optional(),
});

// ---- Inventory ----

const money = z.number().int().min(0).max(10_000_000_00);

export const partSchema = z.object({
  partNo: text(60).min(1, "Part number is required"),
  name: text().min(1, "Name is required"),
  nameAr: optionalText(200),
  brand: optionalText(80),
  unit: text(20).min(1).default("each"),
  stocked: z.boolean(),
  sellPriceFils: money,
  reorderLevel: z.number().min(0).max(1_000_000).default(0),
  location: optionalText(60),
  fits: optionalText(500),
  active: z.boolean().default(true),
});
export type PartInput = z.infer<typeof partSchema>;

export const supplierSchema = z.object({
  name: text().min(1, "Name is required"),
  /** Payment terms in days: a goods receipt is due this long after the supplier's invoice date. */
  termsDays: z.number().int().min(0).max(365).default(30),
  /** Owed to the supplier before using the app (negative = they owe us / an advance). */
  openingBalanceFils: z.number().int().min(-10_000_000_00).max(10_000_000_00).default(0),
  openingBalanceDate: ymd.nullable().default(null),
  trn: optionalText(20),
  phone: optionalText(40),
  email: optionalText(120),
  address: optionalText(500),
  notes: optionalText(2000),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

export const ADJUSTMENT_REASONS = ["count", "damaged", "lost", "opening", "other"] as const;
export const adjustmentSchema = z.object({
  qty: z.number().min(-1_000_000).max(1_000_000).refine((q) => q !== 0, "Quantity can't be zero"),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: optionalText(500),
  unitCostFils: money.optional(),
});

export const poLineSchema = z.object({
  partId: z.string().uuid().nullable().optional(),
  description: text(500).min(1, "Description is required"),
  qty: z.number().positive().max(100000),
  unitCostFils: money.default(0),
  jobDocumentId: z.string().uuid().nullable().optional(),
});
export const poSchema = z.object({
  supplierId: z.string().uuid(),
  notes: optionalText(4000),
  lines: z.array(poLineSchema).max(200).default([]),
});
export const poUpdateSchema = z.object({
  /** The version the editor loaded; a different current version means another PC changed it. */
  version: z.number().int().min(0).optional(),
  notes: patchText(4000),
  status: z.enum(["sent", "cancelled"]).optional(),
  lines: z.array(poLineSchema.extend({ id: z.string().uuid().optional() })).max(200).optional(),
});

export const receiveSchema = z.object({
  supplierInvoiceNo: optionalText(60),
  supplierInvoiceDate: optionalText(10),
  vatFils: money.default(0),
  lines: z.array(z.object({ poLineId: z.string().uuid(), qty: z.number().positive().max(100000), unitCostFils: money })).min(1, "Receive at least one line"),
});

export const requestPartSchema = z.object({
  documentId: z.string().uuid(),
  position: z.number().int().min(0),
  supplierId: z.string().uuid(),
  qty: z.number().positive().max(100000),
  /** The line's description as the requesting screen sees it; a mismatch means the job card changed meanwhile. */
  description: text(500).optional(),
  alreadyBought: z.boolean().default(false),
  unitCostFils: money.optional(),
  supplierInvoiceNo: optionalText(60),
});
