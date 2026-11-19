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

export const customerSchema = z.object({
  kind: z.enum(["individual", "company"]).default("individual"),
  name: text().min(1, "Name is required"),
  phone: optionalText(40),
  email: optionalText(120),
  trn: optionalText(20),
  address: optionalText(500),
  notes: optionalText(2000),
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

export const documentCreateSchema = z.object({
  type: z.enum(DOC_TYPES),
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid().optional().nullable(),
  odometer: z.number().int().min(0).optional().nullable(),
  notes: optionalText(4000),
  lines: z.array(lineSchema).max(500).default([]),
  approval: approvalSchema.optional(),
});
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

export const documentUpdateSchema = z.object({
  vehicleId: z.string().uuid().optional().nullable(),
  odometer: z.number().int().min(0).optional().nullable(),
  notes: patchText(4000),
  status: z.string().optional(),
  lines: z.array(lineSchema).max(500).optional(),
  approval: approvalSchema.optional(),
});

export const PAYMENT_METHODS = ["cash", "card", "bank_transfer", "cheque"] as const;
export const paymentSchema = z.object({
  amountFils: z.number().int().positive("Amount must be more than zero"),
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(120),
  paidAt: z.string().datetime().optional(),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

// ---- Inventory ----

const money = z.number().int().min(0).max(10_000_000_00);

export const partSchema = z.object({
  partNo: text(60).min(1, "Part number is required"),
  name: text().min(1, "Name is required"),
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
