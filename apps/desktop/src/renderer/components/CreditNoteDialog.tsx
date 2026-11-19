import { useEffect, useState } from "react";
import { toast } from "sonner";
import { post } from "../lib/api";
import { formatAED } from "../lib/format";
import type { DocumentFull } from "../lib/types";
import { Button, Field, Modal, NumberInput, Textarea } from "./ui";

/**
 * A tax credit note against an issued invoice: the whole invoice (what isn't credited yet) or chosen lines and
 * quantities, with a reason. Stocked parts go back on the shelf unless unticked.
 */
export function CreditNoteDialog({ invoice, open, onClose, onDone }: {
  invoice: DocumentFull; open: boolean; onClose: () => void; onDone: (creditNote: DocumentFull) => void;
}) {
  const [whole, setWhole] = useState(true);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [returnToStock, setReturnToStock] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setWhole(true);
    setQty({});
    setReason("");
    setReturnToStock(true);
  }, [open]);

  const chosen = invoice.lines.filter((l) => l.id && (qty[l.id] ?? 0) > 0).map((l) => ({ lineId: l.id!, qty: qty[l.id!]! }));
  const hasParts = invoice.lines.some((l) => l.kind === "part" && l.partStocked);
  const submit = async () => {
    setBusy(true);
    try {
      const { document } = await post<{ document: DocumentFull }>(`/api/documents/${invoice.id}/credit-notes`, {
        reason, returnToStock, ...(whole ? {} : { lines: chosen }),
      });
      toast.success(`${document.number} issued for ${formatAED(document.totals.grossFils)}`);
      onDone(document);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Credit note — ${invoice.number}`} width="max-w-2xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={reason.trim().length < 3 || (!whole && !chosen.length)} onClick={() => void submit()}>Issue credit note</Button></>}>
      <div className="space-y-4 text-sm">
        <p className="text-zinc-700">An issued invoice is never changed. A credit note corrects it and reduces what the customer owes; if it was already paid, the amount becomes the customer's credit.</p>
        <div className="flex gap-4">
          <label className="flex items-center gap-2"><input type="radio" checked={whole} onChange={() => setWhole(true)} className="accent-zinc-900" /> Everything not yet credited</label>
          <label className="flex items-center gap-2"><input type="radio" checked={!whole} onChange={() => setWhole(false)} className="accent-zinc-900" /> Chosen lines</label>
        </div>
        {!whole && (
          <table className="w-full" data-testid="credit-lines">
            <thead><tr className="text-left text-xs text-zinc-600"><th className="py-1">Line</th><th className="text-right">On invoice</th><th className="text-right">Price</th><th className="w-28 text-right">Credit qty</th></tr></thead>
            <tbody className="divide-y divide-zinc-100">
              {invoice.lines.map((l, i) => (
                <tr key={l.id ?? i}>
                  <td className="py-1.5">{l.description}</td>
                  <td className="tabular text-right">{l.qty}</td>
                  <td className="tabular text-right">{formatAED(l.unitPriceFils)}</td>
                  <td className="pl-3"><NumberInput value={qty[l.id!] ?? 0} min={0} onChange={(n) => setQty({ ...qty, [l.id!]: Math.min(n, l.qty) })} aria-label={`Credit quantity for line ${i + 1}`} className="h-8" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Field label="Reason" hint="Printed on the credit note">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong part fitted, returned unused" aria-label="Reason" />
        </Field>
        {hasParts && (
          <label className="flex items-center gap-2"><input type="checkbox" checked={returnToStock} onChange={(e) => setReturnToStock(e.target.checked)} className="size-4 accent-zinc-900" /> Put the parts back on the shelf</label>
        )}
      </div>
    </Modal>
  );
}
