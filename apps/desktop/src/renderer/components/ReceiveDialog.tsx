import { useEffect, useMemo, useState } from "react";
import { splitCodes, UnitCodesInput } from "./trackedFields";
import { toast } from "sonner";
import { defaultPurchaseVat, dubaiDate, poLineNetFils, roundFils } from "@ffgp/shared";
import { post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatAED } from "../lib/format";
import type { PurchaseOrder } from "../lib/types";
import { PurchaseVatNote } from "./PurchaseVatNote";
import { Button, Field, Input, Modal, MoneyInput, NumberInput } from "./ui";

interface Row {
  poLineId: string; description: string; remaining: number; qty: number; unitCostFils: number; packSize: number | null; packCostFils: number | null;
  /** Tyres and batteries: each one's DOT or serial, as typed. */
  tracking: "none" | "dot" | "serial"; codes: string;
  /** Core deposit per unit, charged with the delivery. */
  coreFils: number;
}

/** Records a delivery against a purchase order: what arrived, what it cost, and the supplier's invoice. */
export function ReceiveDialog({ po, open, onClose, onDone }: { po: PurchaseOrder; open: boolean; onClose: () => void; onDone: (po: PurchaseOrder) => void }) {
  const { garage } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [vatFils, setVatFils] = useState(0);
  const [vatTouched, setVatTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(po.lines.filter((l) => l.id && l.qty - (l.receivedQty ?? 0) > 0).map((l) => {
      const remaining = Math.round((l.qty - (l.receivedQty ?? 0)) * 1000) / 1000;
      return { poLineId: l.id!, description: l.description, remaining, qty: remaining, unitCostFils: l.unitCostFils ?? 0, packSize: l.packSize ?? null, packCostFils: l.packCostFils ?? null, tracking: l.partTracking ?? "none", codes: "", coreFils: l.coreFils ?? 0 };
    }));
    setInvoiceNo(""); setInvoiceDate(dubaiDate(new Date().toISOString())); setVatTouched(false);
  }, [open, po]);

  // Whole packs at the PO's price: packs × the pack price, as the server works it out.
  const net = useMemo(() => rows.reduce((s, r) => s + poLineNetFils(r) + roundFils(r.qty * r.coreFils), 0), [rows]);
  useEffect(() => {
    if (!vatTouched) setVatFils(defaultPurchaseVat(net, po.supplier ?? { trn: null, isFleetfix: false }, garage?.vatRateBp ?? 500));
  }, [net, vatTouched, garage, po.supplier]);
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const over = rows.some((r) => r.qty > r.remaining);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await post<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${po.id}/receive`, {
        supplierInvoiceNo: invoiceNo || null, supplierInvoiceDate: invoiceDate || null, vatFils,
        lines: rows.filter((r) => r.qty > 0).map(({ poLineId, qty, unitCostFils, tracking, codes, coreFils }) => ({ poLineId, qty, unitCostFils, units: tracking === "none" ? [] : splitCodes(codes, tracking), coreFils })),
      });
      toast.success(res.purchaseOrder.status === "received" ? `${po.number} fully received` : "Delivery recorded");
      onDone(res.purchaseOrder);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Receive delivery — ${po.number}`} width="max-w-3xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={over || !rows.some((r) => r.qty > 0)} onClick={() => void submit()}>Record delivery</Button></>}>
      <table className="mb-4 w-full text-sm">
        <thead><tr className="text-left text-xs text-zinc-500 uppercase"><th className="py-1.5 font-medium">Item</th><th className="w-24 text-right font-medium">Waiting</th><th className="w-24 pl-2 text-right font-medium">Received</th><th className="w-32 pl-2 text-right font-medium">Cost each</th></tr></thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((r, i) => (
            <tr key={r.poLineId} className="align-top">
              <td className="py-1.5">
                {r.description}
                {r.coreFils > 0 && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-600">Core deposit each
                    <span className="w-24"><MoneyInput fils={r.coreFils} onChange={(coreFils) => setRow(i, { coreFils })} className="!h-7 text-xs" aria-label={`Core deposit for ${r.description}`} /></span>
                  </div>
                )}
                {r.tracking !== "none" && r.qty > 0 && <UnitCodesInput tracking={r.tracking} qty={r.qty} value={r.codes} onChange={(codes) => setRow(i, { codes })} label={`Codes for ${r.description}`} />}
              </td>
              <td className="text-right tabular text-zinc-500">{r.remaining}</td>
              <td className="pl-2"><NumberInput value={r.qty} onChange={(qty) => setRow(i, { qty })} className={r.qty > r.remaining ? "h-8 border-red-400" : "h-8"} aria-label="Received quantity" /></td>
              <td className="pl-2"><MoneyInput fils={r.unitCostFils} onChange={(unitCostFils) => setRow(i, { unitCostFils })} className="h-8" aria-label="Cost each" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {over && <div className="mb-3 text-sm text-red-700">You can't receive more than is still waiting.</div>}
      <div className="grid grid-cols-4 gap-3">
        <Field label="Supplier invoice no."><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
        <Field label="Invoice date"><Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></Field>
        <Field label="VAT on invoice (AED)"><MoneyInput fils={vatFils} onChange={(v) => { setVatTouched(true); setVatFils(v); }} aria-label="VAT" /><PurchaseVatNote supplier={po.supplier ?? undefined} vatFils={vatFils} /></Field>
        <div className="flex flex-col justify-end pb-2 text-right text-sm">
          <div className="text-zinc-500">Net {formatAED(net)}</div>
          <div className="font-semibold">Total {formatAED(net + vatFils)}</div>
        </div>
      </div>
    </Modal>
  );
}
