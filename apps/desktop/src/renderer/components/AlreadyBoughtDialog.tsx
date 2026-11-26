import { useEffect, useState } from "react";
import { toast } from "sonner";
import { defaultPurchaseVat, dubaiDate, roundFils } from "@ffgp/shared";
import { post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatAED } from "../lib/format";
import type { DocLine, DocumentFull, Supplier } from "../lib/types";
import { useApi } from "../lib/useApi";
import { PurchaseVatNote } from "./PurchaseVatNote";
import { Button, Field, Input, Modal, MoneyInput, NumberInput, Select } from "./ui";

/** Owner/Accountant: a job card's part already bought (paid at a shop), bought and received in one step. */
export function AlreadyBoughtDialog({ request, onClose, onDone }: {
  request: { documentId: string; position: number; line: DocLine } | null; onClose: () => void; onDone: (d: DocumentFull) => void;
}) {
  const { garage } = useAuth();
  const suppliers = useApi<{ suppliers: Supplier[] }>(request ? "/api/suppliers" : null);
  // Nobody is preselected: the shop is chosen every time.
  const [supplierId, setSupplierId] = useState("");
  const [qty, setQty] = useState(1);
  const [costFils, setCostFils] = useState(0);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [vatFils, setVatFils] = useState(0);
  const [vatTouched, setVatTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState("");
  const today = dubaiDate(new Date().toISOString());
  const net = roundFils(qty * costFils);
  const supplier = suppliers.data?.suppliers.find((s) => s.id === supplierId);
  // The garage's rate from a supplier with a TRN, none otherwise, until the receipt says something else.
  useEffect(() => {
    if (!vatTouched) setVatFils(supplier ? defaultPurchaseVat(net, supplier, garage?.vatRateBp ?? 500) : 0);
  }, [net, vatTouched, garage, supplier]);
  useEffect(() => {
    if (request) { setSupplierId(""); setQty(request.line.qty || 1); setCostFils(0); setInvoiceNo(""); setVatTouched(false); setOn(dubaiDate(new Date().toISOString())); }
  }, [request]);

  const submit = async () => {
    if (!request) return;
    setBusy(true);
    try {
      const res = await post<{ document: DocumentFull }>("/api/purchase-requests", {
        documentId: request.documentId, position: request.position, description: request.line.description.trim(), supplierId, qty,
        alreadyBought: true, unitCostFils: costFils, vatFils, supplierInvoiceNo: invoiceNo || null, purchasedOn: on || undefined,
      });
      toast.success("Recorded as bought");
      onDone(res.document);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={request !== null} onClose={onClose} title="Already bought"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!supplierId} onClick={() => void submit()}>Record purchase</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 rounded-md bg-zinc-50 px-3 py-2 text-sm">{request?.line.description}</div>
        <Field label="Bought from">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-label="Bought from">
            <option value="">Choose the shop…</option>
            {(suppliers.data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Quantity"><NumberInput value={qty} onChange={setQty} aria-label="Quantity bought" /></Field>
        <Field label="Cost each (AED, before VAT)"><MoneyInput fils={costFils} onChange={setCostFils} aria-label="Cost each" /></Field>
        <Field label="Supplier invoice no."><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
        <Field label="Bought on"><Input type="date" value={on} max={today} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field label="VAT on the receipt (AED)" hint="0 if the shop charged no VAT">
          <MoneyInput fils={vatFils} onChange={(v) => { setVatTouched(true); setVatFils(v); }} aria-label="VAT on the receipt" />
          <PurchaseVatNote supplier={supplier} vatFils={vatFils} />
        </Field>
        <div className="col-span-2 self-end pb-2 text-right text-sm">
          <div className="text-zinc-500">Net {formatAED(net)}</div>
          <div className="font-semibold">Total {formatAED(net + vatFils)}</div>
        </div>
      </div>
    </Modal>
  );
}
