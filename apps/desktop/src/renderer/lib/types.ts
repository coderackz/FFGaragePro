import type { DocLanguage, DocType, LineKind, MessageLanguage, Role } from "@ffgp/shared";
export type { Contact } from "@ffgp/shared";

export interface User { id: string; name: string; username: string; role: Role; active?: boolean; createdAt?: string }
/** A PC's backup folder and newest backup (filled by the main process). */
export interface BackupStatus { folder: string; folderOk: boolean; last: string | null; keepDays: number }

export interface Garage { name: string; trn: string | null; address: string | null; phone: string | null; email: string | null; vatRateBp: number }

export interface Customer {
  id: string; kind: "individual" | "company"; name: string; phone: string | null; email: string | null; trn: string | null;
  address: string | null; notes: string | null; createdAt: string; plates?: string[];
  creditAllowed?: boolean; creditLimitFils?: number; termsDays?: number | null; discountPct?: number; lpoRequired?: boolean;
  openingBalanceFils?: number; openingBalanceDate?: string | null;
  /** Arabic name and address, and what their documents print in (English, or English + Arabic). */
  nameAr?: string | null; addressAr?: string | null; docLanguage?: DocLanguage;
  /** The language of messages to the customer's own phone/email. */
  messageLanguage?: MessageLanguage;
  /** Where the account stands: owed (negative = in credit), past due, unallocated payments, over the credit limit. */
  balanceFils?: number; overdueFils?: number; creditFils?: number; openingDueFils?: number; overLimit?: boolean;
}
export interface Vehicle {
  id: string; customerId: string; plate: string; make: string | null; model: string | null; year: number | null; vin: string | null;
  engine?: string | null; colour: string | null; odometer: number | null; createdAt: string; customerName?: string;
}

export interface DocLine {
  id?: string; kind: LineKind; description: string; qty: number; unitPriceFils: number; discountPct: number;
  netFils?: number; vatFils?: number; grossFils?: number;
  /** This line's share of the document's promo discount (set by the server). */
  promoFils?: number;
  partId?: string | null; partNo?: string | null; partNameAr?: string | null; partStocked?: boolean | null; partOnHand?: number | null; partUnit?: string | null;
  suppliedBy?: "garage" | "fleetfix"; poLineId?: string | null; orderStatus?: "on_order" | "received" | null;
  purchaseOrderId?: string | null; purchaseOrderNumber?: string | null; costFils?: number | null;
  /** Set in the editor when a part was just picked: its shelf count before this line takes any. */
  pickedOnHand?: number;
  /** Tyres and batteries tracked one by one: the units this line fits. */
  unitIds?: string[];
  units?: { id: string; code: string; kind: "dot" | "serial"; warrantyEnds: string | null }[];
}
export interface Payment { id: string; amountFils: number; method: string; reference: string | null; paidAt: string; createdBy: string | null; receiptNumber?: string; receiptId?: string }
export interface DocRef { id: string; number: string; type: DocType; issuedAt?: string | null }

export interface DocumentFull {
  id: string; type: DocType; number: string; status: string; odometer: number | null; notes: string | null; issuedAt: string | null;
  createdAt: string; updatedAt: string; createdBy: string | null; editable: boolean;
  /** Prices were typed including VAT (fixed when the document was created). */
  pricesIncludeVat: boolean;
  /** What it prints in, copied from the customer when it was created. */
  language?: DocLanguage;
  /** Times an issued invoice has been printed (the 2nd print onwards says COPY). */
  printCount?: number;
  dueDate?: string | null; lpoNumber?: string | null;
  /** Job cards: the driver who gets "vehicle received/ready" messages. */
  driverName?: string | null; driverPhone?: string | null;
  /** A credit note's reason. */
  reason?: string | null;
  /** Invoices: issued credit notes against it, and what's still owed after them and payments. */
  creditedFils?: number; owedFils?: number; customerBalanceFils?: number;
  creditNotes?: { id: string; number: string; grossFils: number }[];
  customer: Customer; vehicle: Vehicle | null; source: DocRef | null; derived: DocRef | null;
  lines: DocLine[]; totals: { netFils: number; vatFils: number; grossFils: number }; paidFils: number; balanceFils: number; payments: Payment[];
  partsCostFils?: number; marginFils?: number; costPending?: boolean; uncostedLines?: number;
  promo?: { code: string; kind: "percent" | "amount"; value: number; appliesTo: "all" | "labour" | "parts"; discountFils: number } | null;
}
export interface DocumentSummary {
  id: string; type: DocType; number: string; status: string; customerName: string; plate: string | null; grossFils: number;
  paidFils: number; balanceFils: number; createdAt: string; issuedAt: string | null; dueDate?: string | null; creditedFils?: number;
}

// ---- Inventory ----

export interface Part {
  id: string; partNo: string; name: string; nameAr?: string | null; brand: string | null; unit: string; stocked: boolean; sellPriceFils: number;
  onHand: number; reorderLevel: number; location: string | null; fits: string | null; active: boolean; lowStock: boolean;
  avgCostFils?: number; stockValueFils?: number;
  // The catalogue (inventory v2).
  categoryId?: string | null; categoryName?: string | null; attributes?: Record<string, string | number>;
  numbers?: { id?: string; number: string; kind: "oem" | "aftermarket" | "supplier" | "old"; brand: string | null }[];
  fitments?: { id?: string; make: string; model: string | null; yearFrom: number | null; yearTo: number | null; engine: string | null; note: string | null }[];
  packs?: { id?: string; name: string; size: number }[];
  supersededById?: string | null;
  supersededBy?: { id: string; partNo: string; name: string } | null;
  replaces?: { id: string; partNo: string; name: string }[];
  chain?: { id: string; partNo: string; name: string }[];
  /** Search results: which other number matched, whether it fits the job's vehicle, the replaced part it stands in for. */
  matchedBy?: string | null; fitsVehicle?: boolean; replacesPartNo?: string | null;
}
export interface PartCategory {
  id: string; name: string; parentId: string | null; position: number;
  attributes: { key: string; label: string; type: "text" | "number" | "choice"; unit?: string | null; options?: string[] }[];
}
export interface StockMovement {
  id: string; qty: number; reason: "receive" | "job" | "invoice" | "adjust" | "opening"; note: string | null; createdAt: string;
  createdBy: string | null; documentId: string | null; documentNumber: string | null; purchaseOrderId: string | null;
  purchaseOrderNumber: string | null; unitCostFils?: number;
}
export interface Supplier {
  id: string; name: string; trn: string | null; phone: string | null; email: string | null; address: string | null; notes: string | null;
  isFleetfix: boolean;
  termsDays?: number; openingBalanceFils?: number; openingBalanceDate?: string | null;
  /** For those who pay suppliers: what we owe (negative = an advance), what's overdue, the advance. */
  balanceFils?: number; overdueFils?: number; advanceFils?: number;
}

export interface PoLine {
  id?: string; partId: string | null; partNo?: string | null; stocked?: boolean | null; description: string; qty: number; receivedQty?: number;
  jobDocumentId: string | null; jobDocumentNumber?: string | null; unitCostFils?: number; netFils?: number;
  /** Bought in packs: qty and unitCostFils are still in the part's unit. */
  packName?: string | null; packSize?: number | null; packCostFils?: number | null;
}
export interface GoodsReceipt {
  id: string; supplierInvoiceNo: string | null; supplierInvoiceDate: string | null; netFils: number; vatFils: number; grossFils: number;
  createdAt: string; createdBy: string | null;
}
export interface PurchaseOrder {
  id: string; number: string; status: string; version: number; notes: string | null; createdAt: string; updatedAt: string; createdBy: string | null;
  supplier: Supplier; editable: boolean; lines: PoLine[]; netFils?: number; receipts?: GoodsReceipt[];
}
export interface PurchaseOrderSummary {
  id: string; number: string; status: string; supplierId: string; supplierName: string; lineCount: number; createdAt: string; netFils?: number;
}

/** A payment from a customer and what it was put against (Settings Part 2). */
export interface ReceiptAllocation { id: string; documentId: string; number: string; amountFils: number; createdAt: string }
export interface Receipt {
  id: string; number: string; customerId: string; customerName: string; customerNameAr?: string | null; customerLanguage?: DocLanguage; amountFils: number; method: string; reference: string | null;
  chequeDate: string | null; receivedAt: string; createdBy: string | null; allocations: ReceiptAllocation[]; allocatedFils: number; unallocatedFils: number;
}

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";
export interface LedgerRow {
  date: string; kind: "opening" | "invoice" | "credit_note" | "receipt"; number: string; description: string; debitFils: number; creditFils: number; balanceFils: number;
}
export interface Statement { openingFils: number; rows: LedgerRow[]; closingFils: number; aging: Record<AgingBucket, number>; creditFils: number }

/** A message in the log: an email (queued → sent / failed) or a WhatsApp message opened on a PC. */
export interface Message {
  id: string; customerId: string | null; contactId: string | null; documentId: string | null; receiptId: string | null;
  event: string; channel: "email" | "whatsapp"; recipient: string; subject: string | null; body: string;
  status: "queued" | "sending" | "sent" | "failed" | "opened"; attempts: number; nextAttemptAt: string | null; error: string | null;
  senderPlace: string | null; createdBy: string | null; createdAt: string; sentAt: string | null; fileName: string | null;
  /** WhatsApp Business API: what Meta reported back. */
  delivery?: "delivered" | "read" | null;
}
