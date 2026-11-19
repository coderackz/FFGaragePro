import { z } from "zod";
import type { NumberKind } from "./rules";

/**
 * Garage-wide settings, stored one row per field in the `settings` table as `section.field` → JSON value, so two
 * people changing different settings on two PCs never overwrite each other. Every field has a default.
 */
export const SETTINGS_SECTIONS = ["garage", "documents", "numbering", "tax", "pricing", "inventory", "security", "credit"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Settings that belong to one PC and never sync (network sharing, backup folder). */
export const LOCAL_SETTING_PREFIXES = ["network.", "local."] as const;

const IMAGE_ERROR = "Use a PNG or JPG image under 500 KB";
const MAX_IMAGE_BYTES = 500 * 1024;

function isSmallImage(v: string): boolean {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) return false;
  const b64 = m[2]!;
  if (b64.length % 4 !== 0) return false;
  const bytes = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return bytes > 0 && bytes <= MAX_IMAGE_BYTES;
}

const blankToNull = (v: unknown) => (v === "" || v === undefined ? null : v);
const optText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable()).transform((v) => (v ? v : null)).default(null);

export const imageSchema = z.preprocess(blankToNull, z.string().refine(isSmallImage, IMAGE_ERROR).nullable()).default(null);

const iban = z
  .preprocess(
    (v) => (typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : v),
    z.preprocess(blankToNull, z.string().regex(/^AE\d{21}$/, "A UAE IBAN is AE followed by 21 digits").nullable()),
  )
  .default(null);

const prefix = (d: string) => z.string().regex(/^[A-Z]{1,6}$/, "Use 1 to 6 capital letters").default(d);
const start = z.number().int().min(1).max(99_999_999).default(1);

export const settingsSchemas = {
  garage: z.object({
    tradeLicence: optText(40),
    /** Arabic name and address, printed on English + Arabic documents. */
    nameAr: optText(120),
    addressAr: optText(500),
    bankName: optText(80),
    accountName: optText(120),
    iban,
  }),
  documents: z.object({
    logo: imageSchema,
    stamp: imageSchema,
    signature: imageSchema,
    paper: z.enum(["plain", "letterhead"]).default("plain"),
    letterheadTopMm: z.number().int().min(10).max(120).default(45),
    terms: optText(1000),
    termsAr: optText(1000),
    warranty: optText(300),
    warrantyAr: optText(300),
    estimateValidDays: z.number().int().min(1).max(365).default(14),
    showPartNumbers: z.boolean().default(true),
    showLabourHours: z.boolean().default(true),
    jobCardSignature: z.boolean().default(true),
  }),
  numbering: z
    .object({
      estimatePrefix: prefix("EST"),
      jobcardPrefix: prefix("JC"),
      invoicePrefix: prefix("INV"),
      purchaseOrderPrefix: prefix("PO"),
      creditNotePrefix: prefix("CN"),
      receiptPrefix: prefix("RCT"),
      estimateStart: start,
      jobcardStart: start,
      invoiceStart: start,
      purchaseOrderStart: start,
      creditNoteStart: start,
      receiptStart: start,
    })
    .refine(
      (n) => new Set([n.estimatePrefix, n.jobcardPrefix, n.invoicePrefix, n.purchaseOrderPrefix, n.creditNotePrefix, n.receiptPrefix]).size === 6,
      { message: "Each document type needs its own prefix", path: ["invoicePrefix"] },
    ),
  tax: z.object({
    pricesIncludeVat: z.boolean().default(false),
    returnPeriod: z.enum(["quarterly", "monthly"]).default("quarterly"),
    firstPeriodStart: z.preprocess(blankToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-01").nullable()).default(null),
  }),
  pricing: z.object({
    labourRateFils: z.number().int().min(0).max(10_000_000_00).nullable().default(null),
    partsMarkupPct: z.number().min(0).max(1000).nullable().default(null),
    maxDiscountAccountantPct: z.number().min(0).max(100).default(100),
    maxDiscountAdvisorPct: z.number().min(0).max(100).default(100),
  }),
  inventory: z.object({
    belowZero: z.enum(["warn", "block"]).default("warn"),
    defaultReorderLevel: z.number().min(0).max(1_000_000).default(0),
  }),
  security: z.object({
    idleLockMinutes: z.number().int().min(0).max(240).default(15),
  }),
  credit: z.object({
    defaultTermsDays: z.number().int().min(0).max(365).default(30),
    overLimit: z.enum(["warn", "block", "approve"]).default("warn"),
  }),
} as const;

export type Settings = { [S in SettingsSection]: z.output<(typeof settingsSchemas)[S]> };

export const DEFAULT_SETTINGS: Settings = Object.fromEntries(
  SETTINGS_SECTIONS.map((s) => [s, settingsSchemas[s].parse({})]),
) as Settings;

const fieldsOf = (s: SettingsSection) => Object.keys(settingsSchemas[s].shape) as string[];
const fieldSchema = (s: SettingsSection, f: string) => (settingsSchemas[s].shape as Record<string, z.ZodType>)[f]!;

/** Stored rows → settings. A missing, unknown or invalid value (e.g. from a newer app version) falls back to the default. */
export function readSettings(rows: { key: string; value: string }[]): Settings {
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<string, Record<string, unknown>>;
  for (const s of SETTINGS_SECTIONS) {
    const section: Record<string, unknown> = {};
    for (const f of fieldsOf(s)) {
      const fallback = (DEFAULT_SETTINGS[s] as Record<string, unknown>)[f];
      const raw = stored.get(`${s}.${f}`);
      section[f] = fallback;
      if (raw === undefined) continue;
      try {
        const parsed = fieldSchema(s, f).safeParse(JSON.parse(raw));
        if (parsed.success) section[f] = parsed.data;
      } catch {
        // not JSON: keep the default
      }
    }
    out[s] = section;
  }
  return out as Settings;
}

/** A whole section → the rows to store (validated; throws a ZodError on bad input). */
export function sectionRows(section: SettingsSection, value: unknown): { key: string; value: string }[] {
  const parsed = settingsSchemas[section].parse(value) as Record<string, unknown>;
  return fieldsOf(section).map((f) => ({ key: `${section}.${f}`, value: JSON.stringify(parsed[f] ?? null) }));
}

const NUMBERING_FIELD: Record<NumberKind, "estimate" | "jobcard" | "invoice" | "purchaseOrder" | "creditNote" | "receipt"> = {
  estimate: "estimate", jobcard: "jobcard", invoice: "invoice", purchase_order: "purchaseOrder", credit_note: "creditNote", receipt: "receipt",
};

/** The prefix the garage uses for this kind of number (EST, JC, INV, PO by default). */
export function prefixOf(settings: Settings, kind: NumberKind): string {
  return settings.numbering[`${NUMBERING_FIELD[kind]}Prefix`];
}

/** The lowest number the main series may hand out next for this kind. */
export function startOf(settings: Settings, kind: NumberKind): number {
  return settings.numbering[`${NUMBERING_FIELD[kind]}Start`];
}
