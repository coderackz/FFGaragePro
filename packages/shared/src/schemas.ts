import { z } from "zod";
import { addressPartsSchema } from "./address";
import { TRACKING } from "./tracked";
import { attributesSchema, fitmentSchema, packSchema, partNumberSchema } from "./catalogue";
import { DOC_TYPES, ROLES } from "./rules";
import { LINE_CONDITIONS } from "./used";
import { EMIRATES } from "./vat";

const text = (max = 200) => z.string().trim().max(max);
const optionalText = (max = 200) => text(max).optional().nullable().transform((v) => (v ? v : null));
/** For PATCH bodies: a missing field stays undefined (leave it alone); empty clears it. */
const patchText = (max = 200) => text(max).optional().nullable().transform((v) => (v === undefined ? undefined : v || null));

export const garageSchema = z.object({
  name: text().min(1, "Garage name is required"),
  trn: optionalText(20),
  /** As printed; made from the parts when there are any. */
  address: optionalText(1500),
  /** Left out by an older screen. */
  addressParts: addressPartsSchema.optional(),
  phone: optionalText(40),
  email: optionalText(120),
});
export type GarageInput = z.infer<typeof garageSchema>;

export const passwordSchema = z.string().min(8, "Use at least 8 characters").max(200);

export const setupSchema = z.object({
  /** The emirate is the garage's for the VAT return too (Settings → Garage details). */
  garage: garageSchema.extend({ emirate: z.enum(EMIRATES).nullable().optional() }),
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

export const customerSchema = z.object({
  kind: z.enum(["individual", "company"]).default("individual"),
  name: text().min(1, "Name is required"),
  phone: optionalText(40),
  email: optionalText(120),
  trn: optionalText(20),
  /** As printed; made from the parts when there are any. */
  address: optionalText(1500),
  /** Left out by an older screen. */
  addressParts: addressPartsSchema.optional(),
  notes: optionalText(2000),
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
  /** e.g. 1GR-FE or 2.7L: matched against parts' fitment. */
  engine: optionalText(40),
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
  /** Tyres and batteries tracked one by one: the units this line fits. */
  unitIds: z.array(z.string().uuid()).max(1000).default([]),
  /** Labour and other lines: the work in detail, printed under the title. Left out = keep what's stored. */
  details: z.string().max(2000).nullable().optional()
    .transform((v) => (v === undefined ? undefined : v?.trim() ? v.replace(/\s+$/, "") : null)),
  /** What the quantity counts (Pc, Box, Hr…). Left out = keep what's stored. */
  unit: z.string().trim().max(12).nullable().optional().transform((v) => (v === undefined ? undefined : v || null)),
  /** New or used (bought for this job, never stocked). Left out = keep what's stored. */
  condition: z.enum(LINE_CONDITIONS).optional(),
}).refine((l) => l.suppliedBy === "garage" || l.kind === "part", { message: "Only parts can be supplied by Fleet Fix", path: ["suppliedBy"] })
  .refine((l) => l.condition !== "used" || l.kind === "part", { message: "Only parts can be used", path: ["condition"] })
  .refine((l) => l.condition !== "used" || (!l.partId && !l.unitIds.length), { message: "A used part isn't linked to the parts list", path: ["partId"] })
  .refine((l) => l.condition !== "used" || l.suppliedBy === "garage", { message: "A used part can't be supplied by Fleet Fix", path: ["suppliedBy"] });
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
  /** Job cards: the driver who gets "vehicle received/ready" messages. */
  driverName: patchText(120),
  driverPhone: patchText(40),
  /** The version (updatedAt) the screen started from: a save over someone else's newer change is refused. */
  baseUpdatedAt: z.string().max(40).optional(),
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
  lines: z.array(z.object({ lineId: z.string(), qty: z.number().positive().max(100000), unitIds: z.array(z.string().uuid()).max(1000).default([]) })).max(500).optional(),
  returnToStock: z.boolean().default(true),
  approval: approvalSchema.optional(),
});

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
  // The catalogue (inventory v2): category and its specs, other numbers, the vehicles it fits, purchase packs.
  categoryId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  attributes: attributesSchema,
  numbers: z.array(partNumberSchema).max(50).default([]),
  fitments: z.array(fitmentSchema).max(200).default([]),
  packs: z.array(packSchema).max(10).default([]),
  // Tracked stock and kits (inventory v2, Part 2).
  tracking: z.enum(TRACKING).default("none"),
  warrantyMonths: z.number().int().min(0).max(120).default(0),
  isKit: z.boolean().default(false),
  components: z.array(z.object({ partId: z.string().uuid(), qty: z.number().positive().max(100000) })).max(50).default([]),
  // Planning (Part 3): reorder at `reorderLevel` (the minimum), order up to `maxLevel`; who from, and how long it takes.
  maxLevel: z.number().min(0).max(1_000_000).default(0),
  preferredSupplierId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  leadTimeDays: z.number().int().min(0).max(365).default(7),
  /** Part 4: the core deposit the supplier charges per unit, owed back until the old unit is returned. */
  coreFils: money.default(0),
}).superRefine((p, ctx) => {
  if (p.maxLevel > 0 && p.maxLevel < p.reorderLevel) ctx.addIssue({ code: "custom", path: ["maxLevel"], message: "Order up to can't be below the reorder level" });
  if (p.isKit && p.stocked) ctx.addIssue({ code: "custom", path: ["stocked"], message: "A kit isn't stocked itself: its parts are" });
  if (p.isKit && p.tracking !== "none") ctx.addIssue({ code: "custom", path: ["tracking"], message: "A kit can't be tracked one by one" });
  if (p.isKit && !p.components.length) ctx.addIssue({ code: "custom", path: ["components"], message: "Add the parts the kit is made of" });
  if (p.tracking !== "none" && !p.stocked) ctx.addIssue({ code: "custom", path: ["tracking"], message: "Only stocked parts can be tracked one by one" });
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
  /** As printed; made from the parts when there are any. */
  address: optionalText(1500),
  /** Left out by an older screen. */
  addressParts: addressPartsSchema.optional(),
  notes: optionalText(2000),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

export const ADJUSTMENT_REASONS = ["count", "damaged", "lost", "opening", "other"] as const;
export const adjustmentSchema = z.object({
  qty: z.number().min(-1_000_000).max(1_000_000).refine((q) => q !== 0, "Quantity can't be zero"),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: optionalText(500),
  unitCostFils: money.optional(),
  /** A tracked part: the DOT codes or serials coming in (count up), or the unit ids going out (count down). */
  units: z.array(text(60).min(1)).max(1000).default([]),
  unitIds: z.array(z.string().uuid()).max(1000).default([]),
});

export const poLineSchema = z
  .object({
    partId: z.string().uuid().nullable().optional(),
    description: text(500).min(1, "Description is required"),
    /** Always in the part's own unit (litres, each…), even when bought in packs. */
    qty: z.number().positive().max(100000),
    unitCostFils: money.default(0),
    jobDocumentId: z.string().uuid().nullable().optional(),
    /** Bought in packs ("Drum 208 L" holding 208): kept so the PO prints "2 × Drum 208 L". */
    packName: optionalText(60),
    packSize: z.number().positive().max(100000).nullable().optional().transform((v) => v ?? null),
    /** The price per pack as typed (the supplier's price). The line is then packs × this, and the unit cost follows from it. */
    packCostFils: money.nullable().optional().transform((v) => v ?? null),
  })
  .refine((l) => !l.packName === !l.packSize, { message: "A pack needs its name and size", path: ["packSize"] })
  .refine((l) => l.packCostFils === null || !!l.packSize, { message: "A pack price needs a pack", path: ["packCostFils"] })
  .refine((l) => !l.packSize || Math.abs(l.qty / l.packSize - Math.round(l.qty / l.packSize)) < 1e-6, {
    message: "The quantity must be a whole number of packs", path: ["qty"],
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
  lines: z.array(z.object({
    poLineId: z.string().uuid(), qty: z.number().positive().max(100000), unitCostFils: money,
    /** A tracked part: each unit's DOT code or serial, one per unit received. */
    units: z.array(text(60).min(1)).max(1000).default([]),
    /** The core deposit per unit on this delivery (defaults to the part's). */
    coreFils: money.optional(),
  })).min(1, "Receive at least one line"),
});

// ---- Returns, cores and warranty claims (inventory v2, Part 4) ----

/** A return to the supplier (parts off the shelf) or cores going back: both make a debit note. */
export const supplierReturnSchema = z.object({
  supplierId: z.string().uuid(),
  kind: z.enum(["return", "core"]),
  reason: z.string().trim().min(3, "Give a reason").max(500),
  /** The supplier's own reference (their credit note or return number). */
  supplierRef: optionalText(60),
  /** VAT on the debit note; by default the garage's rate on the net. */
  vatFils: money.optional(),
  lines: z.array(z.object({
    partId: z.string().uuid(), qty: z.number().positive().max(100000), unitCreditFils: money,
    /** Tyres and batteries: the units going back. */
    unitIds: z.array(z.string().uuid()).max(1000).default([]),
  })).min(1, "Add at least one part").max(200),
});
export const coreWriteoffSchema = z.object({
  supplierId: z.string().uuid(), partId: z.string().uuid(), qty: z.number().int().positive().max(100000),
  reason: z.string().trim().min(3, "Give a reason").max(500),
});
export const warrantyClaimSchema = z.object({
  supplierId: z.string().uuid(), partId: z.string().uuid(),
  /** A battery (or tyre) claimed by its serial. */
  unitId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  qty: z.number().int().positive().max(1000).default(1),
  reason: z.string().trim().min(3, "Say what failed").max(500),
  /** The job the part failed on, if any. */
  documentId: z.string().uuid().nullable().optional().transform((v) => v ?? null),
});
export const warrantyResolveSchema = z.object({
  outcome: z.enum(["replaced", "credited", "rejected"]),
  note: optionalText(500),
  /** Replaced, a tracked part: the replacement's serial or DOT, one per unit. */
  replacementCodes: z.array(text(60).min(1)).max(1000).default([]),
  /** Credited: the amount before VAT, and the VAT (by default the garage's rate). */
  creditFils: money.optional(),
  vatFils: money.optional(),
}).refine((r) => r.outcome !== "credited" || (r.creditFils ?? 0) > 0, { message: "Enter what the supplier credited", path: ["creditFils"] });

const realDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};
/** A day that exists (2026-02-30 doesn't). */
const day = ymd.refine(realDate, "That isn't a real date");

/** "Buy used part": a used line of an open job card, bought from a saved or a new seller. */
export const usedPurchaseSchema = z.object({
  documentId: z.string().uuid(),
  position: z.number().int().min(0),
  /** The line's description as the screen sees it; a mismatch means the job card changed meanwhile. */
  description: text(500),
  qty: z.number().positive().max(100000),
  seller: z.union([
    /** A phone typed for a saved seller is saved on one without a phone. */
    z.object({ supplierId: z.string().uuid(), phone: optionalText(40).optional() }),
    z.object({ name: text().min(1, "Enter the seller's name"), phone: optionalText(40) }),
  ]),
  unitCostFils: money,
  purchasedOn: day,
  /** The seller's VAT bill; null = none, so no VAT is claimed. */
  bill: z.object({
    trn: z.string().transform((v) => v.replace(/\s+/g, "")).pipe(z.string().regex(/^\d{15}$/, "A UAE TRN has 15 digits")),
    invoiceNo: text(60).min(1, "Enter the invoice number"),
    vatFils: money,
  }).nullable(),
  /** Days from the purchase date; null = no warranty. Always chosen, never assumed. */
  warrantyDays: z.number().int().min(1).max(365).nullable(),
});
export type UsedPurchaseInput = z.infer<typeof usedPurchaseSchema>;

export const requestPartSchema = z.object({
  documentId: z.string().uuid(),
  position: z.number().int().min(0),
  /** Already bought: the shop it came from. A request has no vendor (it's chosen later); one sent anyway is ignored. */
  supplierId: z.string().uuid().optional(),
  qty: z.number().positive().max(100000),
  /** The line's description as the requesting screen sees it; a mismatch means the job card changed meanwhile. */
  description: text(500).optional(),
  alreadyBought: z.boolean().default(false),
  unitCostFils: money.optional(),
  supplierInvoiceNo: optionalText(60),
  /** Bought now: the VAT on the shop's receipt (none from a shop that isn't VAT-registered); left out = the garage's rate. */
  vatFils: money.optional(),
  /** Bought now: the day it was bought (left out = today in Dubai). */
  purchasedOn: day.optional(),
  /** Bought now, a tracked part: each unit's DOT code or serial. */
  units: z.array(text(60).min(1)).max(1000).default([]),
}).refine((r) => !r.alreadyBought || !!r.supplierId, { message: "Choose the supplier", path: ["supplierId"] });

/** "Request parts" on a job card: every part line that can be requested, at once. */
export const requestPartsSchema = z.object({ documentId: z.string().uuid() });

/** A vendor to ask for prices: a saved one, or a new one saved now. */
export const vendorSchema = z.union([
  z.object({ supplierId: z.string().uuid() }),
  z.object({ name: text().min(1, "Enter the vendor's name"), phone: optionalText(40), email: optionalText(120) }),
]);
export const askVendorsSchema = z.object({ vendors: z.array(vendorSchema).min(1, "Choose at least one vendor").max(10) });

/** Vendors' prices on a request, per part; null = they don't have it. */
export const quotePricesSchema = z.object({
  prices: z.array(z.object({ supplierId: z.string().uuid(), poLineId: z.string().uuid(), unitCostFils: money.nullable() })).max(2000),
});

/** Ordering a request: the vendor chosen for each part (parts left out stay on a new request). */
export const orderRequestSchema = z.object({
  version: z.number().int().min(0),
  choices: z.array(z.object({ poLineId: z.string().uuid(), supplierId: z.string().uuid() })).min(1, "Choose a vendor for at least one part").max(2000),
});

/** A message to a vendor about a purchase order or request: emailed, or a WhatsApp chat opened on this PC (logged). */
export const vendorMessageSchema = z.object({
  supplierId: z.string().uuid(),
  channel: z.enum(["email", "whatsapp"]),
  recipient: z.string().trim().min(1).max(120),
  subject: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  body: z.string().trim().min(1, "The message is empty").max(4000),
  attachment: z.object({
    fileName: z.string().trim().min(1).max(150).regex(/^[^\\/:*?"<>|]+$/, "That file name can't be used"),
    base64: z.string().max(8_000_000, "The attachment is over 6 MB").regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }).nullable().optional().transform((v) => v ?? null),
});

export const VEHICLE_FILE_KINDS = ["mulkiya_front", "mulkiya_back"] as const;
export type VehicleFileKind = (typeof VEHICLE_FILE_KINDS)[number];
/** A Mulkiya photo: a JPEG or PNG, shrunk on the screen before it's sent. */
export const vehicleFileSchema = z.object({
  fileName: z.string().trim().min(1).max(150).regex(/\.(jpe?g|png)$/i, "Choose a JPEG or PNG photo"),
  base64: z.string().min(1).max(4_000_000, "The photo is over 3 MB").regex(/^[A-Za-z0-9+/]*={0,2}$/, "That isn't a photo"),
});
