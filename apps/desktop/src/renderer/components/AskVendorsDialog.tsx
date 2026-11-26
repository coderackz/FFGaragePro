import { Check, Mail, MessageCircle, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DEFAULT_SETTINGS } from "@ffgp/shared";
import { post } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { PurchaseOrder, Supplier } from "../lib/types";
import { useApi } from "../lib/useApi";
import { sendToVendor, whatsappOf, type VendorTo } from "../messages/vendors";
import { loadMulkiya } from "./MulkiyaPhotos";
import { Button, Field, Input, Modal } from "./ui";

interface NewVendor { name: string; phone: string; email: string }
const BLANK: NewVendor = { name: "", phone: "", email: "" };

/**
 * Asks vendors for prices on a request: choose saved vendors (or add one), then send each the request by WhatsApp
 * or email, with the vehicle and VIN, and the Mulkiya only when ticked.
 */
export function AskVendorsDialog({ po, open, onClose, onChanged }: { po: PurchaseOrder; open: boolean; onClose: () => void; onChanged: (po: PurchaseOrder) => void }) {
  const { garage, settings } = useAuth();
  const suppliers = useApi<{ suppliers: Supplier[] }>(open ? "/api/suppliers" : null);
  const [step, setStep] = useState<"choose" | "send">("choose");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<NewVendor[]>([]);
  const [draft, setDraft] = useState<NewVendor>(BLANK);
  const [q, setQ] = useState("");
  const [attach, setAttach] = useState(false);
  const [sent, setSent] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const asked = new Set((po.quotes ?? []).map((x) => x.supplierId));
  const mulkiya = po.job?.vehicle?.mulkiya;
  const hasMulkiya = !!(mulkiya?.front || mulkiya?.back);

  useEffect(() => {
    if (!open) return;
    setStep((po.quotes ?? []).length ? "send" : "choose");
    setChosen(new Set());
    setAdded([]);
    setDraft(BLANK);
    setQ("");
    setAttach(false);
    setSent({});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (suppliers.data?.suppliers ?? []).filter((s) => !asked.has(s.id) && (!term || s.name.toLowerCase().includes(term) || (s.phone ?? "").includes(term)));
  }, [suppliers.data, q, po.quotes]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = async () => {
    const vendors = [
      ...[...chosen].map((supplierId) => ({ supplierId })),
      ...added.map((v) => ({ name: v.name.trim(), phone: v.phone.trim() || null, email: v.email.trim() || null })),
    ];
    if (!vendors.length) return setStep("send");
    setBusy("next");
    try {
      const res = await post<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${po.id}/quotes`, { vendors });
      onChanged(res.purchaseOrder);
      setStep("send");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = async (to: VendorTo, channel: "whatsapp" | "email") => {
    if (!garage) return;
    setBusy(`${to.supplierId}:${channel}`);
    try {
      const photos = attach && po.job?.vehicle
        ? (await Promise.all([["mulkiya_front", "Mulkiya front"], ["mulkiya_back", "Mulkiya back"]].map(async ([kind, label]) => {
          const p = await loadMulkiya(po.job!.vehicle!.id, kind as "mulkiya_front" | "mulkiya_back");
          return p ? { label: label!, base64: p.base64 } : null;
        }))).filter((p): p is { label: string; base64: string } => !!p)
        : [];
      onChanged(await sendToVendor(po, to, channel, garage, settings ?? DEFAULT_SETTINGS, photos));
      setSent((s) => ({ ...s, [to.supplierId]: [...(s[to.supplierId] ?? []), channel] }));
      toast.success(channel === "email" ? `Emailed to ${to.name}` : `WhatsApp opened for ${to.name}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addDraft = () => {
    if (!draft.name.trim()) return toast.error("Enter the vendor's name");
    setAdded((a) => [...a, draft]);
    setDraft(BLANK);
  };

  return (
    <Modal open={open} onClose={onClose} title="Ask vendors for prices" width="max-w-2xl"
      footer={step === "choose"
        ? <><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy === "next"} disabled={!chosen.size && !added.length && !(po.quotes ?? []).length} onClick={() => void next()}>Next</Button></>
        : <><Button onClick={() => setStep("choose")}>Add vendors</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      {step === "choose" ? (
        <div className="flex flex-col gap-3">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendors" aria-label="Search vendors" />
          <div className="max-h-56 overflow-y-auto rounded-md border border-zinc-200">
            {shown.length === 0 && <div className="px-3 py-4 text-sm text-zinc-500">No saved vendors{q ? " match" : ""}. Add one below.</div>}
            {shown.map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-3 border-b border-zinc-100 px-3 py-2 text-sm last:border-0 hover:bg-zinc-50">
                <input type="checkbox" checked={chosen.has(s.id)} onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} />
                <span className="flex-1">{s.name}</span>
                <span className="text-xs text-zinc-500">{[s.phone, s.email].filter(Boolean).join(" · ") || "No phone or email"}</span>
              </label>
            ))}
          </div>
          {added.map((v, i) => <div key={i} className="flex items-center gap-2 text-sm"><Check className="size-4 text-emerald-600" />{v.name} <span className="text-xs text-zinc-500">{[v.phone, v.email].filter(Boolean).join(" · ")} · new</span></div>)}
          <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
            <Field label="New vendor"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name" aria-label="New vendor name" /></Field>
            <Field label="Mobile"><Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="05x xxx xxxx" aria-label="New vendor mobile" /></Field>
            <Field label="Email"><Input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} aria-label="New vendor email" /></Field>
            <Button icon={<Plus className="size-4" />} onClick={addDraft}>Add</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className={`flex items-center gap-2 text-sm ${hasMulkiya ? "" : "text-zinc-400"}`}>
            <input type="checkbox" checked={attach} disabled={!hasMulkiya} onChange={(e) => setAttach(e.target.checked)} />
            Attach Mulkiya photo {hasMulkiya ? "(it shows the owner's details)" : "(none saved on the vehicle)"}
          </label>
          {!po.job?.vehicle?.vin && <p className="text-sm text-amber-700">No VIN saved for this vehicle: vendors may not be able to price the parts.</p>}
          <div className="rounded-md border border-zinc-200">
            {(po.quotes ?? []).map((v) => {
              const wa = whatsappOf(v);
              const done = sent[v.supplierId] ?? [];
              return (
                <div key={v.supplierId} className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-3 py-2 text-sm last:border-0">
                  <span className="min-w-40 flex-1 font-medium">{v.name}</span>
                  {v.askedAt && !done.length && <span className="text-xs text-zinc-500">Asked before</span>}
                  {done.map((c) => <span key={c} className="text-xs text-emerald-700">Sent by {c === "email" ? "email" : "WhatsApp"}</span>)}
                  <Button size="sm" icon={<MessageCircle className="size-3.5" />} disabled={!wa} busy={busy === `${v.supplierId}:whatsapp`} onClick={() => void send(v, "whatsapp")}
                    aria-label={`Send ${v.name} by WhatsApp`}>WhatsApp</Button>
                  <Button size="sm" icon={<Mail className="size-3.5" />} disabled={!v.email} busy={busy === `${v.supplierId}:email`} onClick={() => void send(v, "email")}
                    aria-label={`Send ${v.name} by email`}>Email</Button>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-zinc-500">Vendors get the parts, the vehicle and its VIN, and the reference — never the customer or the plate. Type their prices on the request as they reply.</p>
        </div>
      )}
    </Modal>
  );
}
