import { ArrowLeft, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, Table } from "../../components/ui";
import { post } from "../../lib/api";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import type { MoneyAccount } from "../../payables/types";
import { EmployeeForm } from "./EmployeeForm";
import { grossOf, type EmployeeFull } from "./types";

const day = (ymd: string | null) => (ymd ? formatDate(`${ymd}T00:00:00.000Z`) : "—");
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const KIND = { annual: "Annual", sick: "Sick", unpaid: "Unpaid" } as const;

/** One employee: pay, WPS details, documents and their expiry, leave and advances. */
export function EmployeePage() {
  const { id } = useParams();
  const { data, reload } = useApi<{ employee: EmployeeFull }>(`/api/employees/${id}`);
  const [editing, setEditing] = useState(false);
  const [leave, setLeave] = useState(false);
  const [advance, setAdvance] = useState(false);
  const cancel = async (what: string, question: string) => {
    if (!window.confirm(question)) return;
    try { await post(`/api/employees/${id}/${what}/cancel`, {}); toast.success("Cancelled"); await reload(); } catch (err) { toast.error((err as Error).message); }
  };
  if (!data) return <Spinner />;
  const e = data.employee;
  const docs = [["Emirates ID", e.emiratesId, e.emiratesIdExpiry], ["Labour card", e.labourCard, e.labourCardExpiry], ["Passport", e.passport, e.passportExpiry], ["Visa", e.visa, e.visaExpiry]] as const;
  const soon = new Set(e.expiring.map((x) => x.document));
  return (
    <>
      <PageHeader back={<Link to="/employees" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Employees</Link>}
        title={e.name} subtitle={`${e.job}${e.nationality ? ` · ${e.nationality}` : ""} · joined ${day(e.joinDate)}${e.leftDate ? ` · left ${day(e.leftDate)}` : ""}`}
        actions={<Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>} />
      <div className="grid grid-cols-3 gap-5 max-lg:grid-cols-1">
        <Card title="Pay">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-zinc-500">Basic</dt><dd className="text-right tabular">{formatAED(e.basicFils)}</dd>
            <dt className="text-zinc-500">Housing</dt><dd className="text-right tabular">{formatAED(e.housingFils)}</dd>
            <dt className="text-zinc-500">Transport</dt><dd className="text-right tabular">{formatAED(e.transportFils)}</dd>
            <dt className="text-zinc-500">Other</dt><dd className="text-right tabular">{formatAED(e.otherAllowanceFils)}</dd>
            <dt className="font-medium">Gross</dt><dd className="text-right font-medium tabular">{formatAED(grossOf(e))}</dd>
          </dl>
          <p className="mt-3 text-xs text-zinc-600">{e.payMethod === "bank" ? `Bank ${e.iban ?? "(no IBAN)"}` : `Salary card ${e.cardNumber ?? "(no number)"}`} · routing {e.routingCode ?? "—"} · MOHRE {e.personId ?? "—"}</p>
        </Card>
        <Card title="Documents">
          <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-sm">
            {docs.map(([label, no, exp]) => (
              <div key={label} className="contents">
                <dt className="text-zinc-500">{label}</dt><dd className="font-mono text-[13px]">{no ?? "—"}</dd>
                <dd className={soon.has(label) ? "font-medium text-red-700" : ""}>{exp ? day(exp) : ""}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Balances">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-zinc-500">Annual leave left</dt><dd className="text-right tabular" data-testid="leave-balance">{e.annualLeaveDays} days</dd>
            <dt className="text-zinc-500">Advances owed</dt><dd className="text-right tabular" data-testid="advance-owed">{formatAED(e.advanceOwedFils)}</dd>
          </dl>
        </Card>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-5 max-lg:grid-cols-1">
        <Card title="Leave" padded={false} actions={<Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLeave(true)}>Add leave</Button>}>
          <Table rows={e.leave} rowKey={(l) => l.id} empty={<div className="px-4 py-3 text-sm text-zinc-600">No leave recorded</div>}
            columns={[
              { header: "Kind", cell: (l) => <Badge tone={l.kind === "unpaid" ? "red" : "zinc"}>{KIND[l.kind]}</Badge> },
              { header: "From", cell: (l) => day(l.from) }, { header: "To", cell: (l) => day(l.to) }, { header: "Note", cell: (l) => l.note ?? "" },
              { header: "", cell: (l) => <Button size="sm" variant="ghost" onClick={() => void cancel(`leave/${l.id}`, `Cancel this ${KIND[l.kind].toLowerCase()} leave (${day(l.from)} – ${day(l.to)})?`)}>Cancel</Button> },
            ]} />
        </Card>
        <Card title="Advances" padded={false} actions={<Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdvance(true)}>Pay an advance</Button>}>
          <Table rows={e.advances} rowKey={(a) => a.id} empty={<div className="px-4 py-3 text-sm text-zinc-600">No advances</div>}
            columns={[
              { header: "Paid", cell: (a) => day(a.paidOn) }, { header: "Amount", cell: (a) => formatAED(a.amountFils), align: "right" },
              { header: "Monthly", cell: (a) => formatAED(a.instalmentFils), align: "right" },
              { header: "Owed", cell: (a) => (a.cancelled ? <Badge>Cancelled</Badge> : formatAED(a.owedFils)), align: "right" },
              { header: "", cell: (a) => (!a.cancelled && a.repaidFils === 0
                ? <Button size="sm" variant="ghost" onClick={() => void cancel(`advances/${a.id}`, `Cancel the advance of ${formatAED(a.amountFils)}? Its payment is reversed (the money came back).`)}>Cancel</Button> : null) },
            ]} />
        </Card>
      </div>
      <EmployeeForm open={editing} employee={e} onClose={() => setEditing(false)} onSaved={() => void reload()} />
      <LeaveModal open={leave} employeeId={e.id} onClose={() => setLeave(false)} onDone={() => void reload()} />
      <AdvanceModal open={advance} employeeId={e.id} onClose={() => setAdvance(false)} onDone={() => void reload()} />
    </>
  );
}

function LeaveModal({ open, employeeId, onClose, onDone }: { open: boolean; employeeId: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ kind: "annual", from: today(), to: today(), note: "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await post(`/api/employees/${employeeId}/leave`, v); toast.success("Leave recorded"); onClose(); onDone(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Add leave" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save leave</Button></>}>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Kind"><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} aria-label="Kind">{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="From"><Input type="date" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} aria-label="From" /></Field>
        <Field label="To"><Input type="date" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} aria-label="To" /></Field>
      </div>
      <Field label="Note" className="mt-3"><Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} aria-label="Note" /></Field>
      {v.kind === "unpaid" && <p className="mt-3 text-xs text-zinc-600">Unpaid leave is taken off that month's pay and doesn't count as service for gratuity.</p>}
    </Modal>
  );
}

function AdvanceModal({ open, employeeId, onClose, onDone }: { open: boolean; employeeId: string; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<{ accounts: MoneyAccount[] }>(open ? "/api/money-accounts" : null);
  const usable = (accounts.data?.accounts ?? []).filter((a) => a.moneyKind === "cash" || a.moneyKind === "bank");
  const [v, setV] = useState({ amountFils: 0, instalmentFils: 0, paidOn: today(), from: "", note: "" });
  const [busy, setBusy] = useState(false);
  const from = v.from || usable[0]?.id || "";
  const save = async () => {
    setBusy(true);
    try {
      await post(`/api/employees/${employeeId}/advances`, { amountFils: v.amountFils, instalmentFils: v.instalmentFils, paidOn: v.paidOn, paidFromAccountId: from, note: v.note || null });
      toast.success("Advance paid"); onClose(); onDone();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Pay an advance" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!v.amountFils || !v.instalmentFils || !from} onClick={() => void save()}>Pay advance</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount"><MoneyInput fils={v.amountFils} onChange={(f) => setV({ ...v, amountFils: f })} aria-label="Amount" /></Field>
        <Field label="Taken back each month"><MoneyInput fils={v.instalmentFils} onChange={(f) => setV({ ...v, instalmentFils: f })} aria-label="Taken back each month" /></Field>
        <Field label="Paid on"><Input type="date" value={v.paidOn} onChange={(e) => setV({ ...v, paidOn: e.target.value })} aria-label="Paid on" /></Field>
        <Field label="Paid from">
          <Select value={from} onChange={(e) => setV({ ...v, from: e.target.value })} aria-label="Paid from">{usable.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
        </Field>
      </div>
      <Field label="Note" className="mt-3"><Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} aria-label="Note" /></Field>
    </Modal>
  );
}
