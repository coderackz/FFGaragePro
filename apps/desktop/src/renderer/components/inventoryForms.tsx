import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ADJUSTMENT_REASONS, formatAED, roundFils } from "@ffgp/shared";
import { patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Part, Supplier } from "../lib/types";
import { Button, Field, Input, Modal, MoneyInput, NumberInput, Select, Textarea } from "./ui";

const emptyPart = {
  partNo: "", name: "", nameAr: "", brand: "", unit: "each", stocked: true, sellPriceFils: 0, reorderLevel: 0, location: "", fits: "", active: true,
};

export function PartFormModal({ open, part, onClose, onSaved }: { open: boolean; part?: Part | null; onClose: () => void; onSaved: (p: Part) => void }) {
  const { settings } = useAuth();
  const [form, setForm] = useState(emptyPart);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(part
      ? { partNo: part.partNo, name: part.name, nameAr: part.nameAr ?? "", brand: part.brand ?? "", unit: part.unit, stocked: part.stocked, sellPriceFils: part.sellPriceFils, reorderLevel: part.reorderLevel, location: part.location ?? "", fits: part.fits ?? "", active: part.active }
      : { ...emptyPart, reorderLevel: settings?.inventory.defaultReorderLevel ?? 0 });
  }, [open, part]); // eslint-disable-line react-hooks/exhaustive-deps
  // Settings → Pricing markup: a suggested selling price from what the part costs on average.
  const markup = settings?.pricing.partsMarkupPct ?? null;
  const suggested = markup != null && part?.avgCostFils ? roundFils(part.avgCostFils * (1 + markup / 100)) : null;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = part ? await patch<{ part: Part }>(`/api/parts/${part.id}`, form) : await post<{ part: Part }>("/api/parts", form);
      toast.success(part ? "Part saved" : "Part added");
      onSaved(res.part);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={part ? "Edit part" : "New part"} width="max-w-2xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="part-form" busy={busy}>Save</Button></>}>
      <form id="part-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Part number"><Input value={form.partNo} onChange={(e) => set("partNo", e.target.value)} required autoFocus /></Field>
        <Field label="Brand"><Input value={form.brand} onChange={(e) => set("brand", e.target.value)} /></Field>
        <Field label="Name" className="col-span-2"><Input value={form.name} onChange={(e) => set("name", e.target.value)} required /></Field>
        <Field label="Arabic name" hint="Printed under the name on English + Arabic documents" className="col-span-2">
          <Input value={form.nameAr} onChange={(e) => set("nameAr", e.target.value)} dir="rtl" lang="ar" />
        </Field>
        <Field label="Selling price (AED, before VAT)">
          <MoneyInput fils={form.sellPriceFils} onChange={(v) => set("sellPriceFils", v)} />
          {suggested != null && suggested !== form.sellPriceFils && (
            <div className="mt-1 text-xs text-zinc-600">
              Suggested at {markup}% markup: {formatAED(suggested)}{" "}
              <button type="button" className="font-medium text-zinc-900 underline" onClick={() => set("sellPriceFils", suggested)}>Use</button>
            </div>
          )}
        </Field>
        <Field label="Unit">
          <Select value={form.unit} onChange={(e) => set("unit", e.target.value)}>
            {["each", "set", "pair", "litre", "kg", "metre"].map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </Field>
        <Field label="Kept on the shelf?" hint={form.stocked ? "Stock is counted and comes off when used on a job." : "Bought for each job when needed."}>
          <Select value={form.stocked ? "yes" : "no"} onChange={(e) => set("stocked", e.target.value === "yes")} disabled={!!part && part.onHand !== 0}>
            <option value="yes">Yes — stocked</option>
            <option value="no">No — buy per job</option>
          </Select>
        </Field>
        {form.stocked && <Field label="Reorder when at or below"><NumberInput value={form.reorderLevel} onChange={(v) => set("reorderLevel", v)} /></Field>}
        <Field label="Shelf / bin"><Input value={form.location} onChange={(e) => set("location", e.target.value)} /></Field>
        <Field label="Fits (vehicles)" className="col-span-2"><Input value={form.fits} onChange={(e) => set("fits", e.target.value)} placeholder="e.g. Nissan Patrol 2016–2022" /></Field>
        {part && (
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Active (shown when picking parts)
          </label>
        )}
      </form>
    </Modal>
  );
}

const REASON_LABELS: Record<(typeof ADJUSTMENT_REASONS)[number], string> = {
  count: "Stock count", damaged: "Damaged", lost: "Lost", opening: "Opening stock", other: "Other",
};

export function AdjustStockModal({ open, part, onClose, onSaved }: { open: boolean; part: Part; onClose: () => void; onSaved: () => void }) {
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<(typeof ADJUSTMENT_REASONS)[number]>("count");
  const [costFils, setCostFils] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setDirection("in"); setQty(1); setReason(part.onHand === 0 ? "opening" : "count"); setCostFils(part.avgCostFils ?? 0); setNote(""); }
  }, [open, part]);
  const opening = reason === "opening";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post(`/api/parts/${part.id}/adjustments`, {
        qty: opening || direction === "in" ? qty : -qty, reason, note: note || null, ...(opening ? { unitCostFils: costFils } : {}),
      });
      toast.success("Stock updated");
      onSaved();
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Adjust stock — ${part.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="adjust-form" busy={busy}>Save</Button></>}>
      <form id="adjust-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            {ADJUSTMENT_REASONS.map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
          </Select>
        </Field>
        {!opening && (
          <Field label="Direction">
            <Select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
              <option value="in">Add to shelf</option>
              <option value="out">Take off shelf</option>
            </Select>
          </Field>
        )}
        <Field label={`Quantity (${part.unit})`}><NumberInput value={qty} onChange={setQty} /></Field>
        {opening && <Field label="Cost each (AED)"><MoneyInput fils={costFils} onChange={setCostFils} /></Field>}
        <Field label="Note" className="col-span-2"><Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-14" /></Field>
        <div className="col-span-2 text-sm text-zinc-500">Now on the shelf: <span className="font-medium text-zinc-800 tabular">{part.onHand}</span></div>
      </form>
    </Modal>
  );
}

const emptySupplier = { name: "", trn: "", phone: "", email: "", address: "", notes: "" };

export function SupplierFormModal({ open, supplier, onClose, onSaved }: { open: boolean; supplier?: Supplier | null; onClose: () => void; onSaved: (s: Supplier) => void }) {
  const [form, setForm] = useState(emptySupplier);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setForm(supplier ? { name: supplier.name, trn: supplier.trn ?? "", phone: supplier.phone ?? "", email: supplier.email ?? "", address: supplier.address ?? "", notes: supplier.notes ?? "" } : emptySupplier);
  }, [open, supplier]);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = supplier ? await patch<{ supplier: Supplier }>(`/api/suppliers/${supplier.id}`, form) : await post<{ supplier: Supplier }>("/api/suppliers", form);
      toast.success("Supplier saved");
      onSaved(res.supplier);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={supplier ? "Edit supplier" : "New supplier"}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="supplier-form" busy={busy}>Save</Button></>}>
      <form id="supplier-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Name" className="col-span-2"><Input value={form.name} onChange={(e) => set("name", e.target.value)} required autoFocus disabled={supplier?.isFleetfix} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
        <Field label="TRN"><Input value={form.trn} onChange={(e) => set("trn", e.target.value)} /></Field>
        <Field label="Email" className="col-span-2"><Input value={form.email} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Address" className="col-span-2"><Textarea value={form.address} onChange={(e) => set("address", e.target.value)} className="min-h-14" /></Field>
        <Field label="Notes" className="col-span-2"><Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-14" /></Field>
      </form>
    </Modal>
  );
}
