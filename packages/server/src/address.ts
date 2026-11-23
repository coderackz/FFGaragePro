import { addressPartsFrom, EMPTY_ADDRESS, formatAddress, sameAddress, type AddressParts, type Emirate } from "@ffgp/shared";
import type { Db } from "./db";
import { getSettings } from "./settings";

// An address is kept in parts beside `address`, the printed text, which is made from them. A record from before the
// parts (or saved by an older screen) has only the text: it shows in Street and stays as it is until a part changes.

export interface AddressRow {
  address: string | null;
  addr_unit?: string | null; addr_building?: string | null; addr_street?: string | null; addr_area?: string | null;
  addr_emirate?: string | null; addr_po_box?: string | null; addr_country?: string | null;
}

const storedParts = (r: AddressRow): AddressParts => ({
  unit: r.addr_unit ?? null, building: r.addr_building ?? null, street: r.addr_street ?? null, area: r.addr_area ?? null,
  emirate: (r.addr_emirate ?? null) as Emirate | null, poBox: r.addr_po_box ?? null, country: r.addr_country ?? null,
});

/** The parts as the screens show them. */
export const shownAddress = (r: AddressRow): AddressParts => addressPartsFrom(r.address, storedParts(r));

/** The garage's emirate is the one in its settings (the VAT return's). */
export const garageEmirate = (db: Db): Emirate | null => getSettings(db).garage.emirate;

/**
 * What a save leaves: the parts it sent, or (an older screen) its text. The same parts or text change nothing.
 * `emirate`: the garage, whose emirate isn't one of its own parts.
 */
export function resolveAddress(
  existing: AddressRow | null, body: { address?: string | null; addressParts?: AddressParts }, emirate?: Emirate | null,
): { address: string | null; parts: AddressParts } {
  const row: AddressRow = existing ?? { address: null };
  const kept = { address: row.address, parts: storedParts(row) };
  if (body.addressParts) {
    const parts = emirate === undefined ? body.addressParts : { ...body.addressParts, emirate: null };
    if (existing && sameAddress(parts, shownAddress(row))) return kept;
    // The garage's emirate alone isn't an address.
    const garageAddress = () => (sameAddress(parts, EMPTY_ADDRESS) ? null : formatAddress({ ...parts, emirate: emirate ?? null }));
    return { address: emirate === undefined ? formatAddress(parts) : garageAddress(), parts };
  }
  if (body.address !== undefined && (body.address || null) !== row.address) return { address: body.address || null, parts: EMPTY_ADDRESS };
  return kept;
}

/** What was sent, from a request's own body (a PATCH merges the stored record into what it parses). */
export const sentAddress = (body: unknown, parsed: { address?: string | null; addressParts?: AddressParts }) => {
  const has = (k: string) => !!body && typeof body === "object" && k in body;
  return { address: has("address") ? parsed.address : undefined, addressParts: has("addressParts") ? parsed.addressParts : undefined };
};

type AddressTable = "garage" | "customers" | "suppliers";
const COLUMNS: Record<AddressTable, [string, keyof AddressParts][]> = {
  garage: [["addr_unit", "unit"], ["addr_building", "building"], ["addr_street", "street"], ["addr_area", "area"], ["addr_po_box", "poBox"]],
  customers: [["addr_unit", "unit"], ["addr_building", "building"], ["addr_street", "street"], ["addr_area", "area"], ["addr_po_box", "poBox"], ["addr_emirate", "emirate"]],
  suppliers: [["addr_unit", "unit"], ["addr_building", "building"], ["addr_street", "street"], ["addr_area", "area"], ["addr_po_box", "poBox"], ["addr_emirate", "emirate"], ["addr_country", "country"]],
};

export function saveAddress(db: Db, table: AddressTable, id: string | number, a: { address: string | null; parts: AddressParts }): void {
  const cols = COLUMNS[table];
  db.run(`UPDATE ${table} SET address = ?, ${cols.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`, [a.address, ...cols.map(([, k]) => a.parts[k]), id]);
}

/** The printed text made again from the parts (they changed somewhere else, or the garage's emirate did). */
export function recomposeAddress(db: Db, table: AddressTable, id: string | number): void {
  const row = db.get<AddressRow>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!row) return;
  const parts = storedParts(row);
  if (sameAddress(parts, EMPTY_ADDRESS)) return;
  const address = formatAddress(table === "garage" ? { ...parts, emirate: garageEmirate(db) } : parts);
  if (address !== row.address) db.run(`UPDATE ${table} SET address = ? WHERE id = ?`, [address, id]);
}
