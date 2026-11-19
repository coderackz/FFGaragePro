export interface MoneyAccount { id: string; code: string; name: string; moneyKind: "cash" | "bank" | "card_clearing" | "cheques_in_hand"; balanceFils: number }
export interface BillLine { id: string; accountId: string; code: string; name: string; description: string; netFils: number; vat: "standard" | "none"; vatFils: number }
export interface Bill {
  id: string; supplierId: string; supplierName: string; supplierInvoiceNo: string; billDate: string; dueDate: string | null; notes: string | null;
  netFils: number; vatFils: number; grossFils: number; paidFils: number; owedFils: number; status: "posted" | "cancelled"; cancelReason: string | null; lines: BillLine[];
}
export interface SupplierPayment {
  id: string; number: string; supplierId: string; supplierName: string; amountFils: number; method: string; paidFromAccountId: string; reference: string | null;
  chequeNo: string | null; chequeDate: string | null; paidAt: string; clearedAt: string | null; unallocatedFils: number;
  allocations: { allocationId: string; target: "bill" | "goods_receipt"; id: string; amountFils: number }[];
}
export interface OpenItem { target: "bill" | "goods_receipt"; id: string; number: string; date: string; dueDate: string; grossFils: number; owedFils: number }
export interface Expense {
  id: string; number: string; date: string; accountId: string; accountName: string; description: string; netFils: number; vat: string; vatFils: number; grossFils: number;
  paidFromAccountId: string; paidFromName: string; payee: string | null; reference: string | null; hasPhoto: boolean;
}
export const METHOD_LABELS: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", card: "Card", cheque: "Cheque" };
