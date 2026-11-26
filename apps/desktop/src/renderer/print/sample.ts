import { docTotals } from "@ffgp/shared";
import type { DocLine, DocumentFull, Garage } from "../lib/types";

/** A made-up garage and documents for the Settings preview and "Print a test page". */
export const SAMPLE_GARAGE: Garage = {
  name: "Al Quoz Auto Care",
  trn: "100234567890003",
  address: "Street 6, Al Quoz Industrial 3, Dubai",
  phone: "04 333 1234",
  email: "service@example.ae",
  vatRateBp: 500,
};

const LINES: DocLine[] = [
  { kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 3500, discountPct: 0, partNo: "90915-YZZE1", suppliedBy: "garage" },
  { kind: "part", description: "Engine oil 5W-30 (litre)", qty: 7, unitPriceFils: 3500, discountPct: 0, partNo: "08880-83716", suppliedBy: "garage" },
  { kind: "labour", description: "Minor service", qty: 1.5, unitPriceFils: 18000, discountPct: 0, suppliedBy: "garage" },
];

function sample(type: DocumentFull["type"], number: string, status: string): DocumentFull {
  const totals = docTotals(LINES, 500);
  const at = "2026-11-19T08:30:00.000Z";
  return {
    id: `sample-${type}`, type, number, status, odometer: 84250, notes: null, issuedAt: type === "invoice" ? at : null,
    createdAt: at, updatedAt: at, createdBy: null, editable: false, pricesIncludeVat: false,
    customer: {
      id: "sample-customer", kind: "individual", name: "Mohammed Al Marri", phone: "050 123 4567", email: null, trn: null,
      address: "Al Barsha 1, Dubai", notes: null, createdAt: at,
    },
    vehicle: {
      id: "sample-vehicle", customerId: "sample-customer", plate: "DUBAI A 12345", make: "Toyota", model: "Land Cruiser", year: 2021,
      vin: null, colour: "White", odometer: 84250, createdAt: at,
    },
    source: null, derived: null, lines: LINES, totals, paidFils: 0, balanceFils: type === "invoice" ? totals.grossFils : 0, payments: [],
  };
}

export const SAMPLE_DOCUMENTS: Record<DocumentFull["type"], DocumentFull> = {
  estimate: sample("estimate", "EST-00088", "sent"),
  jobcard: sample("jobcard", "JC-00102", "open"),
  invoice: sample("invoice", "INV-00143", "issued"),
  credit_note: sample("credit_note", "CN-00007", "issued"),
};
