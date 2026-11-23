import { z } from "zod";
import { EMIRATE_NAMES, EMIRATES } from "./vat";

// ── An address in parts; `address` (the printed text) is always made from them ────────────────────────────────────
const part = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);

export const addressPartsSchema = z.object({
  unit: part(100), building: part(100),
  // An address from before the parts is kept whole in Street.
  street: part(500), area: part(100),
  emirate: z.enum(EMIRATES).nullable().optional().transform((v) => v ?? null),
  poBox: part(100),
  /** Suppliers: where they are, when it isn't the UAE. */
  country: part(100),
});
export type AddressParts = z.infer<typeof addressPartsSchema>;

export const HOME_COUNTRY = "United Arab Emirates";
export const EMPTY_ADDRESS: AddressParts = { unit: null, building: null, street: null, area: null, emirate: null, poBox: null, country: null };

/** The address as printed: unit and building; street and area; emirate, PO box and country. */
export function formatAddress(p: AddressParts): string | null {
  const join = (...xs: (string | null)[]) => xs.filter(Boolean).join(", ");
  const top = [join(p.unit, p.building), join(p.street, p.area)];
  const emirate = p.emirate ? EMIRATE_NAMES[p.emirate] : null;
  const named = emirate && top.join("\n").toLowerCase().includes(emirate.toLowerCase());
  const box = p.poBox ? (/^\d/.test(p.poBox) ? `PO Box ${p.poBox}` : p.poBox) : null;
  return [...top, join(named ? null : emirate, box, p.country === HOME_COUNTRY ? null : p.country)].filter(Boolean).join("\n") || null;
}

export const sameAddress = (a: AddressParts, b: AddressParts): boolean => (Object.keys(EMPTY_ADDRESS) as (keyof AddressParts)[]).every((k) => a[k] === b[k]);

/** The parts to show: the stored ones, or an address from before them whole in Street. */
export function addressPartsFrom(address: string | null, stored: AddressParts): AddressParts {
  if (!address || !sameAddress(stored, EMPTY_ADDRESS)) return stored;
  return { ...EMPTY_ADDRESS, street: address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(", ") };
}
