import { useEffect, useState } from "react";
import { toast } from "sonner";
import { checkPhone, checkTrn, dubaiDate, formatDay, phoneDigits, roundFils, warrantyUntil } from "@ffgp/shared";
import { post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatAED } from "../lib/format";
import type { DocumentFull, Supplier } from "../lib/types";
import { useApi } from "../lib/useApi";
import { PhoneField } from "./fields";
import { Button, Field, Input, Modal, MoneyInput, NumberInput } from "./ui";

export interface UsedPartRequest { documentId: string; documentNumber?: string; position: number; line: { description: string; qty: number } }
const WARRANTIES = [3, 7, 15, 30];
type Warranty = number | "other" | "none" | null;

/** Records what a used part was bought for: the seller, the price, the day, a VAT bill if there was one, and the warranty. */
export function BuyUsedPartDialog({ request, onClose, onDone }: { request: UsedPartRequest | null; onClose: () => void; onDone: (d: DocumentFull) => void }) {
  const { garage } = useAuth();
  const suppliers = useApi<{ suppliers: Supplier[] }>(request ? "/api/suppliers" : null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [costFils, setCostFils] = useState(0);
  const [qty, setQty] = useState(1);
  const [on, setOn] = useState("");
  const [bill, setBill] = useState(false);
  const [trn, setTrn] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [vatFils, setVatFils] = useState(0);
  const [vatTouched, setVatTouched] = useState(false);
  const [warranty, setWarranty] = useState<Warranty>(null);
  const [otherDays, setOtherDays] = useState(10);
  const [busy, setBusy] = useState(false);
  const today = dubaiDate(new Date().toISOString());

  useEffect(() => {
    if (!request) return;
    setName(""); setPhone(""); setCostFils(0); setQty(request.line.qty || 1); setOn(dubaiDate(new Date().toISOString()));
    setBill(false); setTrn(""); setInvoiceNo(""); setVatTouched(false); setWarranty(null); setOtherDays(10);
  }, [request]);

  const sellers = suppliers.data?.suppliers ?? [];
  const digits = phoneDigits(phone);
  // The seller a saved one is: by phone, else by name (one with another phone saved is somebody else).
  const saved = digits
    ? sellers.find((s) => phoneDigits(s.phone ?? "") === digits) ?? sellers.find((s) => !s.phone && s.name.toLowerCase() === name.trim().toLowerCase())
    : sellers.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  const net = roundFils(qty * costFils);
  useEffect(() => {
    if (!vatTouched) setVatFils(roundFils((net * (garage?.vatRateBp ?? 500)) / 10000));
  }, [net, vatTouched, garage]);
  // Another seller (or none): the TRN is that seller's, never one left over from a name typed on the way.
  const savedId = saved?.id;
  const savedTrn = saved?.trn ?? "";
  useEffect(() => { setTrn(savedTrn); }, [savedId, savedTrn]);

  const days = warranty === "other" ? otherDays : warranty === "none" ? null : warranty;
  const until = typeof days === "number" && on ? warrantyUntil(on, days) : null;
  const few = !!request && qty < request.line.qty;
  const ready = !!request && name.trim() !== "" && costFils > 0 && !few && qty > 0 && on !== "" && on <= today && warranty !== null && (digits === "" || !checkPhone(phone))
    && (warranty !== "other" || (Number.isInteger(otherDays) && otherDays >= 1 && otherDays <= 365))
    && (!bill || (trn.trim() !== "" && !checkTrn(trn) && invoiceNo.trim() !== ""));

  const submit = async () => {
    if (!request) return;
    setBusy(true);
    try {
      const res = await post<{ document: DocumentFull }>("/api/used-purchases", {
        documentId: request.documentId, position: request.position, description: request.line.description.trim(), qty,
        seller: saved ? { supplierId: saved.id, ...(digits && !saved.phone ? { phone } : {}) } : { name: name.trim(), phone: phone || null },
        unitCostFils: costFils, purchasedOn: on, bill: bill ? { trn, invoiceNo: invoiceNo.trim(), vatFils } : null, warrantyDays: days,
      });
      toast.success("Used part recorded as bought");
      onDone(res.document);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const radio = (value: Warranty, label: string) => (
    <label key={label} className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
      <input type="radio" name="used-warranty" checked={warranty === value} onChange={() => setWarranty(value)} />{label}
    </label>
  );
  return (
    <Modal open={request !== null} onClose={onClose} title="Buy used part" width="max-w-xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!ready} onClick={() => void submit()}>Save purchase</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 rounded-md bg-zinc-50 px-3 py-2 text-sm">{request?.line.description}{request?.documentNumber && <span className="text-zinc-500"> · {request.documentNumber}</span>}</div>
        <Field label="Seller">
          <Input value={name} list="used-sellers" maxLength={200} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <datalist id="used-sellers">{sellers.filter((s) => !s.isFleetfix).map((s) => <option key={s.id} value={s.name}>{s.phone ?? ""}</option>)}</datalist>
        <PhoneField label="Phone" value={phone} onChange={setPhone} before="" />
        {saved && <p className="col-span-2 -mt-1 text-xs text-zinc-600">Saved seller: {saved.name}{saved.phone ? ` · ${saved.phone}` : digits ? " · the phone will be saved" : ""}</p>}
        <Field label="Price each"><MoneyInput fils={costFils} onChange={setCostFils} /></Field>
        <Field label="Qty"><NumberInput value={qty} onChange={setQty} /></Field>
        {few && <p className="col-span-2 -mt-1 text-xs text-red-700">Buy at least the {request!.line.qty} on the job card</p>}
        <Field label="Bought on"><Input type="date" value={on} max={today} onChange={(e) => setOn(e.target.value)} /></Field>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-[13px] font-medium text-zinc-700">VAT bill?</legend>
          <div className="flex h-9 items-center gap-4 text-sm">
            <label className="inline-flex items-center gap-1.5"><input type="radio" name="used-bill" checked={!bill} onChange={() => setBill(false)} />No</label>
            <label className="inline-flex items-center gap-1.5"><input type="radio" name="used-bill" checked={bill} onChange={() => setBill(true)} />Yes</label>
          </div>
        </fieldset>
        {bill && (
          <>
            <Field label="Seller's TRN" hint={trn.trim() ? checkTrn(trn) ?? undefined : undefined}><Input value={trn} inputMode="numeric" onChange={(e) => setTrn(e.target.value)} /></Field>
            <Field label="Invoice no."><Input value={invoiceNo} maxLength={60} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
            <Field label="VAT (AED)"><MoneyInput fils={vatFils} onChange={(v) => { setVatTouched(true); setVatFils(v); }} /></Field>
          </>
        )}
        <fieldset className="col-span-2 flex flex-col gap-1.5">
          <legend className="text-[13px] font-medium text-zinc-700">Warranty from the day it was bought</legend>
          <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1.5">
            {WARRANTIES.map((d) => radio(d, `${d} days`))}
            {radio("other", "Other")}
            {warranty === "other" && <span className="inline-flex w-28 items-center gap-1.5 text-sm"><NumberInput value={otherDays} onChange={setOtherDays} className="h-8" aria-label="Warranty days" /> days</span>}
            {radio("none", "No warranty")}
          </div>
          {until && <p className="text-xs text-zinc-600">Until {formatDay(until)}{until < today ? " — already ended" : ""}</p>}
        </fieldset>
        <div className="col-span-2 text-right text-sm font-semibold">Total {formatAED(net + (bill ? vatFils : 0))}</div>
      </div>
    </Modal>
  );
}
