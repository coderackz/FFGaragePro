import type { DocType, LineKind, Role } from "@ffgp/shared";

export interface User { id: string; name: string; username: string; role: Role; active?: boolean; createdAt?: string }
export interface Garage { name: string; trn: string | null; address: string | null; phone: string | null; email: string | null; vatRateBp: number }

export interface Customer {
  id: string; kind: "individual" | "company"; name: string; phone: string | null; email: string | null; trn: string | null;
  address: string | null; notes: string | null; createdAt: string; plates?: string[];
}
export interface Vehicle {
  id: string; customerId: string; plate: string; make: string | null; model: string | null; year: number | null; vin: string | null;
  colour: string | null; odometer: number | null; createdAt: string; customerName?: string;
}

export interface DocLine {
  id?: string; kind: LineKind; description: string; qty: number; unitPriceFils: number; discountPct: number;
  netFils?: number; vatFils?: number; grossFils?: number;
}
export interface Payment { id: string; amountFils: number; method: string; reference: string | null; paidAt: string; createdBy: string | null }
export interface DocRef { id: string; number: string; type: DocType }

export interface DocumentFull {
  id: string; type: DocType; number: string; status: string; odometer: number | null; notes: string | null; issuedAt: string | null;
  createdAt: string; updatedAt: string; createdBy: string | null; editable: boolean;
  customer: Customer; vehicle: Vehicle | null; source: DocRef | null; derived: DocRef | null;
  lines: DocLine[]; totals: { netFils: number; vatFils: number; grossFils: number }; paidFils: number; balanceFils: number; payments: Payment[];
}
export interface DocumentSummary {
  id: string; type: DocType; number: string; status: string; customerName: string; plate: string | null; grossFils: number;
  paidFils: number; balanceFils: number; createdAt: string; issuedAt: string | null;
}

// ---- Inventory ----

export interface Part {
  id: string; partNo: string; name: string; brand: string | null; unit: string; stocked: boolean; sellPriceFils: number;
  onHand: number; reorderLevel: number; location: string | null; fits: string | null; active: boolean; lowStock: boolean;
  avgCostFils?: number; stockValueFils?: number;
}
export interface StockMovement {
  id: string; qty: number; reason: "receive" | "job" | "invoice" | "adjust" | "opening"; note: string | null; createdAt: string;
  createdBy: string | null; documentId: string | null; documentNumber: string | null; purchaseOrderId: string | null;
  purchaseOrderNumber: string | null; unitCostFils?: number;
}
export interface Supplier {
  id: string; name: string; trn: string | null; phone: string | null; email: string | null; address: string | null; notes: string | null;
  isFleetfix: boolean;
}
