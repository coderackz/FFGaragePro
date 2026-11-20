import { PROMO_APPLIES } from "@ffgp/shared";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Card, Empty, Field, Input, Modal, MoneyInput, NumberInput, Select, Table } from "../../../components/ui";
import { patch, post } from "../../../lib/api";
import { formatAED, formatDate } from "../../../lib/format";
import { useApi } from "../../../lib/useApi";
import { SectionShell } from "../SectionShell";

export interface PromoCode {
  id: string; code: string; description: string | null; kind: "percent" | "amount"; value: number; appliesTo: "all" | "labour" | "parts";
  validFrom: string | null; validTo: string | null; minNetFils: number | null; maxUses: number | null; oncePerCustomer: boolean; active: boolean;
}
export const APPLIES: Record<string, string> = { all: "Labour and parts", labour: "Labour", parts: "Parts" };
/** "10% labour", "AED 25.00 off parts". */
export const promoTerms = (p: Pick<PromoCode, "kind" | "value" | "appliesTo">) =>
  `${p.kind === "percent" ? `${p.value}%` : formatAED(p.value)} off ${p.appliesTo === "all" ? "the bill" : APPLIES[p.appliesTo]!.toLowerCase()}`;

type Draft = Omit<PromoCode, "id">;
const blank = (): Draft => ({ code: "", description: null, kind: "percent", value: 10, appliesTo: "all", validFrom: null, validTo: null, minNetFils: null, maxUses: null, oncePerCustomer: false, active: true });

/** Settings → Promo codes: codes customers can be given, with their limits. */
export function PromoSection() {
  const { data, reload } = useApi<{ codes: PromoCode[] }>("/api/promo-codes");
  const [editing, setEditing] = useState<PromoCode | "new" | null>(null);
  const dates = (p: PromoCode) => (p.validFrom || p.validTo ? `${p.validFrom ? formatDate(p.validFrom) : "…"} – ${p.validTo ? formatDate(p.validTo) : "…"}` : "Any time");
  return (
    <SectionShell title="Promo codes" subtitle="Discount codes for estimates and invoices, taken off before VAT">
      <Card padded={false} title="Codes" actions={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing("new")}>New code</Button>}>
        <Table rows={data?.codes ?? []} rowKey={(p) => p.id} onRowClick={(p) => setEditing(p)}
          empty={<Empty title="No promo codes yet">Make one, then type it on an estimate or invoice.</Empty>}
          columns={[
            { header: "Code", cell: (p) => <span className="font-mono font-medium">{p.code}{!p.active && <span className="ml-2"><Badge>Not active</Badge></span>}</span> },
            { header: "Discount", cell: (p) => promoTerms(p) },
            { header: "Valid", cell: dates },
            { header: "Limits", cell: (p) => [p.minNetFils ? `min ${formatAED(p.minNetFils)}` : "", p.maxUses ? `${p.maxUses} uses` : "", p.oncePerCustomer ? "once per customer" : ""].filter(Boolean).join(" · ") || "None" },
          ]} />
      </Card>
      <PromoForm promo={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />
    </SectionShell>
  );
}

function PromoForm({ promo, onClose, onSaved }: { promo: PromoCode | "new" | null; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(blank());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (promo) setD(promo === "new" ? blank() : { ...promo }); }, [promo]);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true);
    try {
      if (promo === "new") await post("/api/promo-codes", d); else if (promo) await patch(`/api/promo-codes/${promo.id}`, d);
      toast.success("Code saved"); onClose(); onSaved();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!promo} title={promo === "new" ? "New promo code" : `Edit ${promo ? (promo as PromoCode).code : ""}`} onClose={onClose} width="max-w-xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save code</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Code"><Input className="font-mono uppercase" value={d.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} aria-label="Code" /></Field>
        <Field label="Description"><Input value={d.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} aria-label="Description" /></Field>
        <Field label="Discount type">
          <Select value={d.kind} onChange={(e) => set({ kind: e.target.value as Draft["kind"], value: e.target.value === "percent" ? 10 : 5000 })} aria-label="Discount type">
            <option value="percent">Percent off</option>
            <option value="amount">Fixed amount off (AED)</option>
          </Select>
        </Field>
        <Field label={d.kind === "percent" ? "Discount (%)" : "Discount (AED)"}>
          {d.kind === "percent"
            ? <NumberInput value={d.value} min={0} step={0.5} onChange={(v) => set({ value: v })} aria-label="Discount" />
            : <MoneyInput fils={d.value} onChange={(v) => set({ value: v })} aria-label="Discount" />}
        </Field>
        <Field label="Applies to">
          <Select value={d.appliesTo} onChange={(e) => set({ appliesTo: e.target.value as Draft["appliesTo"] })} aria-label="Applies to">
            {PROMO_APPLIES.map((a) => <option key={a} value={a}>{APPLIES[a]}</option>)}
          </Select>
        </Field>
        <Field label="Minimum bill (before VAT)" hint="Of the lines it applies to; blank for none">
          <MoneyInput fils={d.minNetFils ?? 0} onChange={(v) => set({ minNetFils: v || null })} aria-label="Minimum bill" />
        </Field>
        <Field label="Valid from"><Input type="date" value={d.validFrom ?? ""} onChange={(e) => set({ validFrom: e.target.value || null })} aria-label="Valid from" /></Field>
        <Field label="Valid to"><Input type="date" value={d.validTo ?? ""} onChange={(e) => set({ validTo: e.target.value || null })} aria-label="Valid to" /></Field>
        <Field label="Maximum uses" hint="Blank for no limit">
          <Input inputMode="numeric" value={d.maxUses ?? ""} onChange={(e) => set({ maxUses: Number.parseInt(e.target.value, 10) || null })} aria-label="Maximum uses" />
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.oncePerCustomer} onChange={(e) => set({ oncePerCustomer: e.target.checked })} /> Once per customer</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.active} onChange={(e) => set({ active: e.target.checked })} /> Active</label>
        </div>
      </div>
    </Modal>
  );
}
