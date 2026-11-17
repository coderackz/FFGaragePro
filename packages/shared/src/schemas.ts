import { z } from "zod";
import { DOC_TYPES, ROLES } from "./rules";

const text = (max = 200) => z.string().trim().max(max);
const optionalText = (max = 200) => text(max).optional().nullable().transform((v) => (v ? v : null));

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
export type LineKind = (typeof LINE_KINDS)[number];

export const lineSchema = z.object({
  kind: z.enum(LINE_KINDS),
  description: text(500).min(1, "Description is required"),
  qty: z.number().min(0).max(100000),
  unitPriceFils: z.number().int().min(0).max(10_000_000_00),
  discountPct: z.number().min(0).max(100).default(0),
});
export type LineInput = z.infer<typeof lineSchema>;

export const documentCreateSchema = z.object({
  type: z.enum(DOC_TYPES),
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid().optional().nullable(),
  odometer: z.number().int().min(0).optional().nullable(),
  notes: optionalText(4000),
  lines: z.array(lineSchema).max(500).default([]),
});
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

export const documentUpdateSchema = z.object({
  vehicleId: z.string().uuid().optional().nullable(),
  odometer: z.number().int().min(0).optional().nullable(),
  notes: optionalText(4000),
  status: z.string().optional(),
  lines: z.array(lineSchema).max(500).optional(),
});

export const PAYMENT_METHODS = ["cash", "card", "bank_transfer", "cheque"] as const;
export const paymentSchema = z.object({
  amountFils: z.number().int().positive("Amount must be more than zero"),
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(120),
  paidAt: z.string().datetime().optional(),
});
export type PaymentInput = z.infer<typeof paymentSchema>;
