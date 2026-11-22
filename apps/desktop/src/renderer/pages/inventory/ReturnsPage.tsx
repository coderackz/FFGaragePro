import { Plus, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Segmented } from "../../components/Segmented";
import { splitCodes, UnitChooser, UnitCodesInput } from "../../components/trackedFields";
import { Badge, Button, Card, Empty, Field, Input, Modal, MoneyInput, NumberInput, PageHeader, Select, Spinner, Table, Textarea } from "../../components/ui";
import { post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatAED, formatDate } from "../../lib/format";
import type { Part, StockUnit, Supplier } from "../../lib/types";
import { useApi } from "../../lib/useApi";
import { ALL } from "../../components/ShowMore";

interface DebitNote {
  id: string; number: string; kind: "return" | "core" | "warranty"; date: string; reason: string; supplierRef: string | null;
  supplier: { id: string; name: string }; netFils: number; vatFils: number; grossFils: number;
  lines: { partNo: string; description: string; qty: number; unitCreditFils: number; units: string[] }[];
}
interface CoreOwed { supplierId: string; supplierName: string; partId: string; partNo: string; name: string; qty: number; valueFils: number; depositFils: number }
interface Claim {
  id: string; number: string; status: "open" | "replaced" | "credited" | "rejected"; reason: string; qty: number; outcomeNote: string | null; createdAt: string;
  supplier: { id: string; name: string }; part: { id: string; partNo: string; name: string }; unit: { id: string; code: string } | null;
  documentId: string | null; documentNumber: string | null; debitNote: { id: string; number: string; grossFils: number } | null;
}
const KIND = { return: "Parts returned", core: "Cores returned", warranty: "Warranty credit" } as const;
const STATUS_TONE = { open: "red", replaced: "brand", credited: "brand", rejected: "zinc" } as const;

/** Inventory → Returns & claims: debit notes to suppliers (parts and cores going back), cores owed, warranty claims. */
export function ReturnsPage() {
  const [view, setView] = useState<"returns" | "cores" | "claims">("returns");
  return (
    <>
      <PageHeader title="Returns & claims" subtitle="Parts and cores going back to suppliers, and warranty claims" actions={
        <Segmented label="Returns view" value={view} onChange={setView} options={[["returns", "Returns"], ["cores", "Cores owed"], ["claims", "Warranty claims"]] as const} />
      } />
      {view === "returns" && <Returns />}
      {view === "cores" && <Cores />}
      {view === "claims" && <Claims />}
    </>
  );
}

const useSuppliers = () => useApi<{ suppliers: Supplier[] }>("/api/suppliers").data?.suppliers ?? [];
const useStockedParts = () => (useApi<{ parts: Part[] }>(`/api/parts?active=1&limit=${ALL}`).data?.parts ?? []).filter((p) => p.stocked && !p.isKit);
const run = async (fn: () => Promise<void>, done: string, setBusy: (b: boolean) => void) => {
  setBusy(true);
  try { await fn(); toast.success(done); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
};

function Returns() {
  const { data, reload } = useApi<{ supplierReturns: DebitNote[] }>("/api/supplier-returns");
  const [creating, setCreating] = useState(false);
  if (!data) return <Spinner />;
  return (
    <>
      <div className="mb-3 flex justify-end"><Button variant="primary" icon={<Undo2 className="size-4" />} onClick={() => setCreating(true)}>Return parts</Button></div>
      <Card padded={false}>
        <Table rows={data.supplierReturns} rowKey={(r) => r.id} empty={<Empty title="Nothing returned yet">A return takes parts off the shelf and lowers what you owe the supplier.</Empty>} columns={[
          { header: "Number", cell: (r) => <span className="font-mono">{r.number}</span> },
          { header: "Date", cell: (r) => formatDate(`${r.date}T00:00:00Z`) },
          { header: "Supplier", cell: (r) => <Link className="hover:underline" to={`/suppliers/${r.supplier.id}`}>{r.supplier.name}</Link> },
          { header: "What", cell: (r) => <span>{KIND[r.kind]}<span className="block text-xs text-zinc-500">{r.lines.map((l) => `${l.qty} × ${l.partNo}${l.units.length ? ` (${l.units.join(", ")})` : ""}`).join(", ")}</span></span> },
          { header: "Reason", cell: (r) => <span className="text-zinc-600">{r.reason}{r.supplierRef ? ` · their ref ${r.supplierRef}` : ""}</span> },
          { header: "Credit", align: "right", cell: (r) => formatAED(r.grossFils) },
        ]} />
      </Card>
      <ReturnDialog open={creating} kind="return" onClose={() => setCreating(false)} onDone={() => void reload()} />
    </>
  );
}

type ReturnLine = { partId: string; partNo: string; qty: number; unitCreditFils: number; unitIds: string[] };

/** A debit note: parts going back off the shelf, or cores going back (from the Cores owed list). */
function ReturnDialog({ open, kind, onClose, onDone, preset }: {
  open: boolean; kind: "return" | "core"; onClose: () => void; onDone: () => void; preset?: { supplierId: string; line: ReturnLine };
}) {
  const suppliers = useSuppliers();
  const parts = useStockedParts();
  const [supplierId, setSupplierId] = useState("");
  const [lines, setLines] = useState<ReturnLine[]>([]);
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");
  const [vat, setVat] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSupplierId(preset?.supplierId ?? ""); setLines(preset ? [preset.line] : [{ partId: "", partNo: "", qty: 1, unitCreditFils: 0, unitIds: [] }]);
    setReason(kind === "core" ? "Old units returned" : ""); setRef(""); setVat(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const net = lines.reduce((s, l) => s + Math.round(l.qty * l.unitCreditFils), 0);
  // The garage's VAT rate until the user types the supplier's own figure (only then is it sent).
  const { garage } = useAuth();
  const vatShown = vat ?? Math.round((net * (garage?.vatRateBp ?? 500)) / 10000);
  const set = (i: number, p: Partial<ReturnLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const submit = () => run(async () => {
    if (lines.some((l) => !l.partId)) throw new Error("Pick each part by its number");
    await post("/api/supplier-returns", { supplierId, kind, reason, supplierRef: ref || null, ...(vat !== null ? { vatFils: vat } : {}), lines });
    onDone(); onClose();
  }, kind === "core" ? "Cores returned" : "Return made", setBusy);
  return (
    <Modal open={open} onClose={onClose} title={kind === "core" ? "Return cores" : "Return parts to the supplier"} width="max-w-3xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!supplierId || reason.trim().length < 3} onClick={() => void submit()}>Make debit note</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Supplier">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-label="Supplier" disabled={!!preset}>
            <option value="">Choose…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Their reference" hint="Their credit note or return number"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      </div>
      <datalist id="return-parts">{parts.map((p) => <option key={p.id} value={p.partNo}>{p.name}</option>)}</datalist>
      <div className="mt-3 space-y-2">
        {lines.map((l, i) => {
          const part = parts.find((p) => p.id === l.partId);
          return (
            <div key={i} className="rounded-md border border-zinc-200 p-2">
              <div className="flex items-end gap-2">
                <Field label="Part" className="flex-1">
                  <Input list="return-parts" value={l.partNo} aria-label="Part number" disabled={!!preset}
                    onChange={(e) => {
                      const p = parts.find((x) => x.partNo.toLowerCase() === e.target.value.trim().toLowerCase());
                      set(i, { partNo: e.target.value, partId: p?.id ?? "", unitIds: [], unitCreditFils: l.unitCreditFils || (kind === "return" ? p?.avgCostFils ?? 0 : 0) });
                    }} />
                </Field>
                <Field label="Qty"><span className="block w-20"><NumberInput value={l.qty} onChange={(qty) => set(i, { qty })} aria-label="Return quantity" /></span></Field>
                <Field label="Credit each (AED)"><span className="block w-32"><MoneyInput fils={l.unitCreditFils} onChange={(unitCreditFils) => set(i, { unitCreditFils })} aria-label="Credit each" /></span></Field>
              </div>
              {part && <div className="mt-1 text-xs text-zinc-500">{part.name} · {part.onHand} on the shelf{kind === "return" && part.avgCostFils ? ` · cost ${formatAED(part.avgCostFils)}` : ""}</div>}
              {kind === "return" && part?.tracking && part.tracking !== "none" && (
                <div className="mt-1 text-xs"><UnitChooser partId={part.id} qty={l.qty} chosen={l.unitIds} current={[]} onChange={(unitIds) => set(i, { unitIds })} /></div>
              )}
            </div>
          );
        })}
        {!preset && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setLines((ls) => [...ls, { partId: "", partNo: "", qty: 1, unitCreditFils: 0, unitIds: [] }])}>Add a part</Button>}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Field label="Reason" className="col-span-2"><Input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" placeholder="e.g. Wrong part supplied" /></Field>
        <Field label="VAT (AED)"><MoneyInput fils={vatShown} onChange={setVat} aria-label="Debit note VAT" /></Field>
      </div>
      <div className="mt-2 text-right text-sm"><span className="text-zinc-500">Net {formatAED(net)} · </span><span className="font-semibold">Credit {formatAED(net + vatShown)}</span></div>
    </Modal>
  );
}

function Cores() {
  const { data, reload } = useApi<{ cores: CoreOwed[] }>("/api/cores");
  const [returning, setReturning] = useState<CoreOwed | null>(null);
  const [writing, setWriting] = useState<CoreOwed | null>(null);
  if (!data) return <Spinner />;
  return (
    <>
      <Card padded={false}>
        <Table rows={data.cores} rowKey={(c) => `${c.supplierId}:${c.partId}`} empty={<Empty title="No cores owed">Parts with a core deposit show here until the old units go back.</Empty>} columns={[
          { header: "Supplier", cell: (c) => c.supplierName },
          { header: "Part", cell: (c) => <Link className="hover:underline" to={`/parts/${c.partId}`}><span className="font-mono">{c.partNo}</span> {c.name}</Link> },
          { header: "Cores owed", align: "right", cell: (c) => c.qty },
          { header: "Deposits", align: "right", cell: (c) => formatAED(c.valueFils) },
          { header: "", cell: (c) => (
            <span className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setReturning(c)}>Return cores</Button>
              <Button size="sm" variant="ghost" onClick={() => setWriting(c)}>Write off</Button>
            </span>
          ) },
        ]} />
      </Card>
      {returning && (
        <ReturnDialog open kind="core" onClose={() => setReturning(null)} onDone={() => void reload()}
          preset={{ supplierId: returning.supplierId, line: { partId: returning.partId, partNo: returning.partNo, qty: returning.qty, unitCreditFils: returning.depositFils, unitIds: [] } }} />
      )}
      <WriteOffDialog core={writing} onClose={() => setWriting(null)} onDone={() => void reload()} />
    </>
  );
}

function WriteOffDialog({ core, onClose, onDone }: { core: CoreOwed | null; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (core) { setQty(core.qty); setReason(""); } }, [core]);
  if (!core) return null;
  return (
    <Modal open onClose={onClose} title={`Write off cores — ${core.partNo}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={reason.trim().length < 3}
        onClick={() => void run(async () => { await post("/api/cores/write-offs", { supplierId: core.supplierId, partId: core.partId, qty, reason }); onDone(); onClose(); }, "Written off", setBusy)}>Write off</Button></>}>
      <p className="mb-3 text-sm text-zinc-600">The deposits on cores that won't go back to {core.supplierName} become a cost.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`How many (of ${core.qty})`}><NumberInput value={qty} onChange={(v) => setQty(Math.max(1, Math.min(core.qty, Math.round(v))))} aria-label="Cores to write off" /></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Write-off reason" placeholder="e.g. Customer kept the old unit" /></Field>
      </div>
    </Modal>
  );
}

function Claims() {
  const [status, setStatus] = useState("open");
  const { data, reload } = useApi<{ warrantyClaims: Claim[] }>(`/api/warranty-claims${status ? `?status=${status}` : ""}`);
  const [creating, setCreating] = useState(false);
  const [resolving, setResolving] = useState<Claim | null>(null);
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <span className="block w-40 shrink-0"><Select value={status} onChange={(e) => setStatus(e.target.value)}  aria-label="Claim status">
          <option value="open">Open</option>
          <option value="">All</option>
        </Select></span>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New claim</Button>
      </div>
      {!data ? <Spinner /> : (
        <Card padded={false}>
          <Table rows={data.warrantyClaims} rowKey={(c) => c.id} empty={<Empty title={status === "open" ? "No open claims" : "No claims yet"} />} columns={[
            { header: "Number", cell: (c) => <span className="font-mono">{c.number}</span> },
            { header: "Opened", cell: (c) => formatDate(c.createdAt) },
            { header: "Supplier", cell: (c) => c.supplier.name },
            { header: "Part", cell: (c) => <span><span className="font-mono">{c.part.partNo}</span> {c.part.name}{c.unit ? <span className="block text-xs text-zinc-500">Serial {c.unit.code}</span> : null}</span> },
            { header: "What failed", cell: (c) => <span className="text-zinc-600">{c.reason}{c.documentNumber ? <span className="block text-xs">on {c.documentNumber}</span> : null}</span> },
            { header: "Status", cell: (c) => (
              <span><Badge tone={STATUS_TONE[c.status]}>{c.status[0]!.toUpperCase() + c.status.slice(1)}</Badge>
                {c.debitNote && <span className="ml-1 text-xs text-zinc-500">{c.debitNote.number} · {formatAED(c.debitNote.grossFils)}</span>}</span>
            ) },
            { header: "", cell: (c) => (c.status === "open" ? <Button size="sm" onClick={() => setResolving(c)}>Close claim</Button> : null) },
          ]} />
        </Card>
      )}
      <ClaimDialog open={creating} onClose={() => setCreating(false)} onDone={() => void reload()} />
      <ResolveDialog claim={resolving} onClose={() => setResolving(null)} onDone={() => void reload()} />
    </>
  );
}

function ClaimDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const suppliers = useSuppliers();
  const [serial, setSerial] = useState("");
  const [unit, setUnit] = useState<StockUnit | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [partNo, setPartNo] = useState("");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const parts = useApi<{ parts: Part[] }>(open ? `/api/parts?active=1&limit=${ALL}` : null).data?.parts ?? [];
  const found = useApi<{ units: StockUnit[] }>(open && serial.trim().length >= 3 ? `/api/stock-units?q=${encodeURIComponent(serial.trim())}` : null).data?.units ?? [];
  useEffect(() => { if (open) { setSerial(""); setUnit(null); setSupplierId(""); setPartNo(""); setQty(1); setReason(""); } }, [open]);
  const part = useMemo(() => (unit ? parts.find((p) => p.id === unit.partId) : parts.find((p) => p.partNo.toLowerCase() === partNo.trim().toLowerCase())), [unit, parts, partNo]);
  return (
    <Modal open={open} onClose={onClose} title="New warranty claim" width="max-w-2xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!supplierId || !part || reason.trim().length < 3}
        onClick={() => void run(async () => {
          await post("/api/warranty-claims", { supplierId, partId: part!.id, unitId: unit?.id ?? null, documentId: unit?.documentId ?? null, qty: unit ? 1 : qty, reason });
          onDone(); onClose();
        }, "Claim opened", setBusy)}>Open claim</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Battery or tyre serial" hint="For something tracked one by one" className="col-span-2">
          <Input value={serial} onChange={(e) => { setSerial(e.target.value); setUnit(null); }} aria-label="Claim serial" placeholder="Serial or DOT" />
        </Field>
        {serial.trim().length >= 3 && !unit && (
          <div className="col-span-2 space-y-1 text-sm">
            {found.filter((u) => u.status === "fitted").map((u) => (
              <button key={u.id} type="button" className="block w-full rounded border border-zinc-200 px-2 py-1 text-left hover:bg-zinc-50" onClick={() => setUnit(u)}>
                <span className="font-mono">{u.code}</span> · {u.partNo} {u.partName} · {u.documentNumber} {u.customerName ?? ""}
              </button>
            ))}
            {!found.some((u) => u.status === "fitted") && <div className="text-zinc-500">No fitted unit with that serial</div>}
          </div>
        )}
        {unit ? (
          <div className="col-span-2 rounded bg-zinc-50 px-2 py-1.5 text-sm">Claiming <span className="font-mono">{unit.code}</span> ({unit.partNo}), fitted on {unit.documentNumber}</div>
        ) : (
          <>
            <datalist id="claim-parts">{parts.map((p) => <option key={p.id} value={p.partNo}>{p.name}</option>)}</datalist>
            <Field label="Or the part"><Input list="claim-parts" value={partNo} onChange={(e) => setPartNo(e.target.value)} aria-label="Claim part number" /></Field>
            <Field label="How many"><NumberInput value={qty} onChange={(v) => setQty(Math.max(1, Math.round(v)))} aria-label="Claim quantity" /></Field>
          </>
        )}
        <Field label="Supplier">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-label="Claim supplier">
            <option value="">Choose…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="What failed"><Input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="What failed" /></Field>
      </div>
    </Modal>
  );
}

function ResolveDialog({ claim, onClose, onDone }: { claim: Claim | null; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const [outcome, setOutcome] = useState<"replaced" | "credited" | "rejected">("replaced");
  const [codes, setCodes] = useState("");
  const [credit, setCredit] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const part = useApi<{ part: Part }>(claim ? `/api/parts/${claim.part.id}` : null).data?.part;
  useEffect(() => { if (claim) { setOutcome("replaced"); setCodes(""); setCredit(0); setNote(""); } }, [claim]);
  if (!claim) return null;
  const tracking = part?.stocked ? part.tracking ?? "none" : "none";
  return (
    <Modal open onClose={onClose} title={`Close ${claim.number}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy}
        onClick={() => void run(async () => {
          await post(`/api/warranty-claims/${claim.id}/resolve`, { outcome, note: note || null, replacementCodes: tracking !== "none" ? splitCodes(codes, tracking) : [], ...(outcome === "credited" ? { creditFils: credit } : {}) });
          onDone(); onClose();
        }, "Claim closed", setBusy)}>Close claim</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Outcome">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} aria-label="Outcome">
            <option value="replaced">Replaced by the supplier</option>
            {can("payables.manage") && <option value="credited">Credited by the supplier</option>}
            <option value="rejected">Rejected</option>
          </Select>
        </Field>
        {outcome === "credited" && <Field label="Credit before VAT (AED)"><MoneyInput fils={credit} onChange={setCredit} aria-label="Credit amount" /></Field>}
        {outcome === "replaced" && tracking !== "none" && (
          <Field label={`The replacement's ${tracking === "dot" ? "DOT" : "serial"}`} className="col-span-2">
            <UnitCodesInput tracking={tracking} qty={claim.qty} value={codes} onChange={setCodes} label="Replacement codes" />
          </Field>
        )}
        <Field label="Note" className="col-span-2"><Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-14" /></Field>
      </div>
      {outcome === "replaced" && <p className="mt-2 text-xs text-zinc-500">The replacement comes onto the shelf at no cost.</p>}
    </Modal>
  );
}
