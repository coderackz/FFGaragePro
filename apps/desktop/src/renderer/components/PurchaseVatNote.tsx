/** Beside the VAT on a purchase: why it starts at none, or that it's claimed from a supplier with no TRN. */
export function PurchaseVatNote({ supplier, vatFils }: { supplier: { trn: string | null; isFleetfix: boolean } | undefined; vatFils: number }) {
  if (!supplier || supplier.isFleetfix || supplier.trn) return null;
  return vatFils > 0
    ? <span className="text-xs text-amber-700">VAT claimed from a supplier with no TRN</span>
    : <span className="text-xs text-zinc-500">No TRN saved for this supplier</span>;
}
