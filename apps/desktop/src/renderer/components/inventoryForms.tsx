import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ADJUSTMENT_REASONS, formatAED, roundFils, checkEmail, checkPhone, checkTrn, EMPTY_ADDRESS } from "@ffgp/shared";
import { patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Part, PartCategory, Supplier } from "../lib/types";
import { useApi } from "../lib/useApi";
import { AttributeFields, FitmentRows, NumberRows, PackRows, type Fitments, type Numbers, type Packs } from "./catalogueFields";
import { TrackingFields, UnitChooser, UnitCodesInput, splitCodes, type KitRow, type Tracking } from "./trackedFields";
import { Button, Field, Input, Modal, MoneyInput, NumberInput, Select, Textarea } from "./ui";
import { AddressFields, EmailField, firstProblem, PhoneField, TrnField } from "./fields";

const emptyPart = {
  partNo: "", name: "", brand: "", unit: "each", stocked: true, sellPriceFils: 0, reorderLevel: 0, location: "", fits: "", active: true,
  categoryId: null as string | null, attributes: {} as Record<string, string | number>, numbers: [] as Numbers, fitments: [] as Fitments, packs: [] as Packs,
  tracking: "none" as Tracking, warrantyMonths: 0, isKit: false, components: [] as KitRow[],
  maxLevel: 0, preferredSupplierId: null as string | null, leadTimeDays: 7, coreFils: 0,
};

export function PartFormModal({ open, part, onClose, onSaved }: { open: boolean; part?: Part | null; onClose: () => void; onSaved: (p: Part) => void }) {
  const { settings } = useAuth();
  const [form, setForm] = useState(emptyPart);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(part
      ? {
        partNo: part.partNo, name: part.name, brand: part.brand ?? "", unit: part.unit, stocked: part.stocked, sellPriceFils: part.sellPriceFils, reorderLevel: part.reorderLevel, location: part.location ?? "", fits: part.fits ?? "", active: part.active,
        categoryId: part.categoryId ?? null, attributes: part.attributes ?? {}, numbers: part.numbers ?? [], fitments: part.fitments ?? [], packs: part.packs ?? [],
        tracking: part.tracking ?? "none", warrantyMonths: part.warrantyMonths ?? 0, isKit: !!part.isKit,
        components: (part.components ?? []).map((c) => ({ partId: c.partId, partNo: c.partNo, qty: c.qty })),
        maxLevel: part.maxLevel ?? 0, preferredSupplierId: part.preferredSupplierId ?? null, leadTimeDays: part.leadTimeDays ?? 7, coreFils: part.coreFils ?? 0,
      }
      : { ...emptyPart, reorderLevel: settings?.inventory.defaultReorderLevel ?? 0 });
  }, [open, part]); // eslint-disable-line react-hooks/exhaustive-deps
  // Settings → Pricing markup: a suggested selling price from what the part costs on average.
  const markup = settings?.pricing.partsMarkupPct ?? null;
  const suggested = markup != null && part?.avgCostFils ? roundFils(part.avgCostFils * (1 + markup / 100)) : null;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const categories = useApi<{ categories: PartCategory[] }>(open ? "/api/part-categories" : null);
  const suppliers = useApi<{ suppliers: Supplier[] }>(open ? "/api/suppliers" : null);
  const category = categories.data?.categories.find((c) => c.id === form.categoryId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Numbers given as typed; blank rows dropped. Specs go as typed: the server reads numbers (and "2,5").
      const body = {
        ...form,
        numbers: form.numbers.filter((n) => n.number.trim()).map(({ number, kind, brand }) => ({ number, kind, brand })),
        fitments: form.fitments.filter((f) => f.make.trim()).map(({ id: _, ...f }) => f),
        packs: form.packs.filter((p) => p.name.trim()).map(({ name, size }) => ({ name, size })),
        attributes: form.attributes,
        tracking: form.isKit || !form.stocked ? "none" : form.tracking,
        warrantyMonths: form.tracking === "serial" ? form.warrantyMonths : 0,
        components: form.isKit ? form.components.filter((c) => c.partNo.trim()).map(({ partId, qty }) => ({ partId, qty })) : [],
      };
      if (form.isKit && body.components.some((c) => !c.partId)) throw new Error("A kit part isn't a stocked part: check the part numbers");
      const res = part ? await patch<{ part: Part }>(`/api/parts/${part.id}`, body) : await post<{ part: Part }>("/api/parts", body);
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
    <Modal open={open} onClose={onClose} title={part ? "Edit part" : "New part"} width="max-w-3xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="part-form" busy={busy}>Save</Button></>}>
      <form id="part-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Part number"><Input value={form.partNo} onChange={(e) => set("partNo", e.target.value)} required autoFocus /></Field>
        <Field label="Brand"><Input value={form.brand} onChange={(e) => set("brand", e.target.value)} /></Field>
        <Field label="Name" className="col-span-2"><Input value={form.name} onChange={(e) => set("name", e.target.value)} required /></Field>
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
        {!form.isKit && (
          <Field label="Kept on the shelf?" hint={form.stocked ? "Stock is counted and comes off when used on a job." : "Bought for each job when needed."}>
            <Select value={form.stocked ? "yes" : "no"} onChange={(e) => set("stocked", e.target.value === "yes")} disabled={!!part && part.onHand !== 0}>
              <option value="yes">Yes — stocked</option>
              <option value="no">No — buy per job</option>
            </Select>
          </Field>
        )}
        {form.stocked && !form.isKit && <Field label="Reorder when at or below"><NumberInput value={form.reorderLevel} onChange={(v) => set("reorderLevel", v)} /></Field>}
        {form.stocked && !form.isKit && (
          <Field label="Order up to" hint="Suggested orders top the shelf up to this (0: to the reorder level)">
            <NumberInput value={form.maxLevel} onChange={(v) => set("maxLevel", v)} aria-label="Order up to" />
          </Field>
        )}
        {form.stocked && !form.isKit && (
          <Field label="Preferred supplier">
            <Select value={form.preferredSupplierId ?? ""} onChange={(e) => set("preferredSupplierId", e.target.value || null)} aria-label="Preferred supplier">
              <option value="">The one last bought from</option>
              {(suppliers.data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        {form.stocked && !form.isKit && (
          <Field label="Core deposit (AED)" hint="Charged with each one bought (alternators, starters…), owed back when the old unit goes back">
            <MoneyInput fils={form.coreFils} onChange={(v) => set("coreFils", v)} aria-label="Core deposit" />
          </Field>
        )}
        {form.stocked && !form.isKit && (
          <Field label="Lead time (days)" hint="How long the supplier takes to deliver">
            <NumberInput value={form.leadTimeDays} onChange={(v) => set("leadTimeDays", Math.max(0, Math.round(v)))} aria-label="Lead time" />
          </Field>
        )}
        <Field label="Shelf / bin"><Input value={form.location} onChange={(e) => set("location", e.target.value)} /></Field>
        <Field label="Category">
          <Select value={form.categoryId ?? ""} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value || null, attributes: {} }))} aria-label="Category">
            <option value="">None</option>
            {(categories.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Notes on fit" hint="Free text, as before"><Input value={form.fits} onChange={(e) => set("fits", e.target.value)} placeholder="e.g. Nissan Patrol 2016–2022" /></Field>
        <AttributeFields category={category} values={form.attributes} onChange={(v) => set("attributes", v)} />
        <NumberRows rows={form.numbers} onChange={(v) => set("numbers", v)} />
        <FitmentRows rows={form.fitments} onChange={(v) => set("fitments", v)} />
        <PackRows rows={form.packs} unit={form.unit} onChange={(v) => set("packs", v)} />
        <TrackingFields stocked={form.stocked} tracking={form.tracking} warrantyMonths={form.warrantyMonths} isKit={form.isKit} components={form.components}
          lockedKit={!!part && part.onHand !== 0} onChange={(p) => setForm((f) => ({ ...f, ...p }))} />
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
  const [codes, setCodes] = useState("");
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setDirection("in"); setQty(1); setReason(part.onHand === 0 ? "opening" : "count"); setCostFils(part.avgCostFils ?? 0); setNote(""); setCodes(""); setUnitIds([]); }
  }, [open, part]);
  const opening = reason === "opening";
  const tracking = part.stocked ? part.tracking ?? "none" : "none";
  const goingIn = opening || direction === "in";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post(`/api/parts/${part.id}/adjustments`, {
        qty: goingIn ? qty : -qty, reason, note: note || null, ...(opening ? { unitCostFils: costFils } : {}),
        ...(tracking !== "none" ? (goingIn ? { units: splitCodes(codes, tracking) } : { unitIds }) : {}),
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
        {tracking !== "none" && (
          <Field label={goingIn ? (tracking === "dot" ? "Each tyre's DOT" : "Each battery's serial") : "Which ones went"} className="col-span-2">
            {goingIn
              ? <UnitCodesInput tracking={tracking} qty={qty} value={codes} onChange={setCodes} label="Unit codes" />
              : <div className="text-xs"><UnitChooser partId={part.id} qty={qty} chosen={unitIds} current={[]} onChange={(ids) => setUnitIds(ids)} /></div>}
          </Field>
        )}
        <Field label="Note" className="col-span-2"><Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-14" /></Field>
        <div className="col-span-2 text-sm text-zinc-500">Now on the shelf: <span className="font-medium text-zinc-800 tabular">{part.onHand}</span></div>
      </form>
    </Modal>
  );
}

const emptySupplier = { name: "", trn: "", phone: "", email: "", addressParts: EMPTY_ADDRESS, notes: "", termsDays: "30", opening: "", openingDate: "" };

export function SupplierFormModal({ open, supplier, onClose, onSaved }: { open: boolean; supplier?: Supplier | null; onClose: () => void; onSaved: (s: Supplier) => void }) {
  const [form, setForm] = useState(emptySupplier);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setForm(supplier ? {
      name: supplier.name, trn: supplier.trn ?? "", phone: supplier.phone ?? "", email: supplier.email ?? "", addressParts: supplier.addressParts ?? EMPTY_ADDRESS, notes: supplier.notes ?? "",
      termsDays: String(supplier.termsDays ?? 30), opening: supplier.openingBalanceFils ? (supplier.openingBalanceFils / 100).toFixed(2) : "", openingDate: supplier.openingBalanceDate ?? "",
    } : emptySupplier);
  }, [open, supplier]);
  const set = (k: Exclude<keyof typeof form, "addressParts">, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = firstProblem([[supplier?.phone, form.phone, checkPhone], [supplier?.email, form.email, checkEmail], [supplier?.trn, form.trn, checkTrn]]);
    if (problem) return void toast.error(problem);
    setBusy(true);
    try {
      const { termsDays, opening, openingDate, ...rest } = form;
      const body = {
        ...rest, termsDays: Math.max(0, Math.min(365, Number.parseInt(termsDays, 10) || 0)),
        openingBalanceFils: Math.round((Number.parseFloat(opening.replace(/,/g, "")) || 0) * 100), openingBalanceDate: openingDate || null,
      };
      const res = supplier ? await patch<{ supplier: Supplier }>(`/api/suppliers/${supplier.id}`, body) : await post<{ supplier: Supplier }>("/api/suppliers", body);
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
        <PhoneField label="Phone" before={supplier?.phone} value={form.phone} onChange={(v) => set("phone", v)} />
        <TrnField label="TRN" before={supplier?.trn} value={form.trn} onChange={(v) => set("trn", v)} />
        <EmailField label="Email" className="col-span-2" before={supplier?.email} value={form.email} onChange={(v) => set("email", v)} />
        <AddressFields className="col-span-2" country value={form.addressParts} onChange={(addressParts) => setForm((x) => ({ ...x, addressParts }))} />
        <Field label="Notes" className="col-span-2"><Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} className="min-h-14" /></Field>
        <Field label="Payment terms (days)" hint="Their bills are due this long after the invoice date"><Input inputMode="numeric" value={form.termsDays} onChange={(e) => set("termsDays", e.target.value)} /></Field>
        <div />
        <Field label="Opening balance (AED)" hint="Owed to them before using the app"><Input inputMode="decimal" value={form.opening} onChange={(e) => set("opening", e.target.value)} /></Field>
        <Field label="Opening balance date"><Input type="date" value={form.openingDate} onChange={(e) => set("openingDate", e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
