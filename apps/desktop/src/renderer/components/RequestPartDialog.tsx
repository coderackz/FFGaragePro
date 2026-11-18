import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FLEETFIX_SUPPLIER_ID } from "@ffgp/shared";
import { post } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DocLine, DocumentFull, Supplier } from "../lib/types";
import { useApi } from "../lib/useApi";
import { Button, Field, Input, Modal, MoneyInput, NumberInput, Select } from "./ui";

/** Request a part on a job-card line from a supplier, or (Owner/Accountant) record that it was already bought. */
export function RequestPartDialog({ request, onClose, onDone }: {
  request: { documentId: string; position: number; line: DocLine } | null; onClose: () => void; onDone: (d: DocumentFull) => void;
}) {
  const { can } = useAuth();
  const suppliers = useApi<{ suppliers: Supplier[] }>(request ? "/api/suppliers" : null);
  const [supplierId, setSupplierId] = useState(FLEETFIX_SUPPLIER_ID);
  const [qty, setQty] = useState(1);
  const [bought, setBought] = useState(false);
  const [costFils, setCostFils] = useState(0);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (request) { setSupplierId(FLEETFIX_SUPPLIER_ID); setQty(request.line.qty || 1); setBought(false); setCostFils(0); setInvoiceNo(""); }
  }, [request]);

  const submit = async () => {
    if (!request) return;
    setBusy(true);
    try {
      const res = await post<{ document: DocumentFull }>("/api/purchase-requests", {
        documentId: request.documentId, position: request.position, supplierId, qty,
        ...(bought ? { alreadyBought: true, unitCostFils: costFils, supplierInvoiceNo: invoiceNo || null } : {}),
      });
      const line = res.document.lines[request.position];
      toast.success(bought ? "Recorded as bought" : `Added to ${line?.purchaseOrderNumber ?? "a purchase order"}`);
      onDone(res.document);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={request !== null} onClose={onClose} title="Request part"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>{bought ? "Record purchase" : "Request"}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 rounded-md bg-zinc-50 px-3 py-2 text-sm">{request?.line.description}</div>
        <Field label="Supplier">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-label="Supplier">
            {(suppliers.data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Quantity"><NumberInput value={qty} onChange={setQty} aria-label="Request quantity" /></Field>
        {can("purchases.manage") && (
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={bought} onChange={(e) => setBought(e.target.checked)} /> Already bought (e.g. paid cash at a parts shop)
          </label>
        )}
        {bought && (
          <>
            <Field label="Cost each (AED, before VAT)"><MoneyInput fils={costFils} onChange={setCostFils} aria-label="Cost each" /></Field>
            <Field label="Supplier invoice no."><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
          </>
        )}
        {!bought && <p className="col-span-2 text-xs text-zinc-500">It's added to this supplier's draft purchase order. The accountant prices and sends it, and records the delivery.</p>}
      </div>
    </Modal>
  );
}
