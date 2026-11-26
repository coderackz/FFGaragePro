import { ArrowLeft, CheckCircle2, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner } from "../../components/ui";
import { get, patch, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import type { MoneyAccount } from "../../payables/types";
import { printSettlement } from "../../print/print";
import type { SettlementLetter } from "../../print/templates";
import type { EmployeeFull } from "./types";

interface Item { key: string; label: string; proposedFils: number; amountFils: number; how: string; reason: string | null }
interface Settlement { id: string; name: string; job: string; joinDate: string; lastDay: string; items: Item[]; totalFils: number; status: "draft" | "approved"; approvedAt: string | null; paidOn: string | null }
const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

/** A leaver's final settlement: each amount and how it was worked out; change with a reason; approve; pay; print the letter. */
export function SettlementPage() {
  const { id } = useParams();
  const { garage, settings, can } = useAuth();
  const { data, reload } = useApi<{ settlement: Settlement }>(`/api/employees/${id}/settlement`);
  const [changing, setChanging] = useState<Item | null>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!data || !garage || !settings) return <Spinner />;
  const s = data.settlement;
  const draft = s.status === "draft";
  const approve = async () => {
    if (!window.confirm(`Approve ${s.name}'s final settlement of ${formatAED(s.totalFils)}? It can't change afterwards.`)) return;
    setBusy(true);
    try { await post(`/api/settlements/${s.id}/approve`, { totalFils: s.totalFils }); toast.success("Settlement approved"); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); await reload(); }
  };
  const print = async () => {
    const e = (await get<{ employee: EmployeeFull }>(`/api/employees/${id}`)).employee;
    const letter: SettlementLetter = { employeeId: e.id, name: s.name, job: s.job, joinDate: s.joinDate, lastDay: s.lastDay, items: s.items, totalFils: s.totalFils, draft };
    await printSettlement(letter, garage, settings, "print");
  };
  return (
    <>
      <PageHeader back={<Link to={`/employees/${id}`} className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> {s.name}</Link>}
        title={`Final settlement: ${s.name}`}
        subtitle={<span data-testid="settlement-status" className="inline-flex items-center gap-2">
          <Badge tone={draft ? "brand" : "zinc"}>{draft ? "Draft" : "Approved"}</Badge>{s.paidOn && <Badge>Paid {day(s.paidOn)}</Badge>}
          <span className="text-sm text-zinc-600">{s.job} · joined {day(s.joinDate)} · last day {day(s.lastDay)}</span>
        </span>}
        actions={<>
          <Button icon={<Printer className="size-4" />} onClick={() => void print()}>Print letter</Button>
          {draft && can("payroll.approve") && <Button variant="primary" icon={<CheckCircle2 className="size-4" />} busy={busy} onClick={() => void approve()}>Approve</Button>}
          {!draft && !s.paidOn && <Button onClick={() => setPaying(true)}>Mark paid</Button>}
        </>} />
      <Card padded={false}>
        <table className="w-full text-sm">
          <tbody>
            {s.items.map((i) => (
              <tr key={i.key} data-testid="settlement-item" className="border-b border-zinc-100">
                <td className="px-4 py-3">
                  <div className="font-medium">{i.label}</div>
                  <div className="text-xs text-zinc-600">{i.how}</div>
                  {i.reason && <div className="text-xs text-amber-700">Changed from {formatAED(i.proposedFils)}: {i.reason}</div>}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular">{formatAED(i.amountFils)}</td>
                <td className="w-24 pr-4 text-right">{draft && <Button size="sm" variant="ghost" onClick={() => setChanging(i)}>Change</Button>}</td>
              </tr>
            ))}
            <tr className="font-semibold"><td className="px-4 py-3">{s.totalFils < 0 ? "Owed by the employee" : "Total due"}</td><td className="px-4 py-3 text-right tabular" data-testid="settlement-total">{formatAED(Math.abs(s.totalFils))}</td><td /></tr>
          </tbody>
        </table>
      </Card>
      <ChangeModal item={changing} settlementId={s.id} onClose={() => setChanging(null)} onDone={() => void reload()} />
      <PayModal open={paying} settlementId={s.id} lastDay={s.lastDay} owedBy={s.totalFils < 0} onClose={() => setPaying(false)} onDone={() => void reload()} />
    </>
  );
}

function ChangeModal({ item, settlementId, onClose, onDone }: { item: Item | null; settlementId: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (item) { setAmount((item.amountFils / 100).toFixed(2)); setReason(item.reason ?? ""); } }, [item]);
  const fils = Math.round(Number(amount.replace(/,/g, "")) * 100);
  const save = async () => {
    if (!item) return;
    setBusy(true);
    try { await patch(`/api/settlements/${settlementId}`, { key: item.key, amountFils: fils, reason }); toast.success("Changed"); onClose(); onDone(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!item} title={`Change: ${item?.label ?? ""}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!Number.isFinite(fils) || reason.trim().length < 3} onClick={() => void save()}>Save</Button></>}>
      <p className="mb-3 text-xs text-zinc-600">Proposed: {item ? formatAED(item.proposedFils) : ""} · {item?.how}</p>
      {item?.key === "advances" && <p className="mb-3 text-xs text-zinc-600">Enter a minus amount up to what's owed; what isn't taken back is forgiven (written off).</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" /></Field>
        <Field label="Reason" hint="Kept with the settlement and printed on the letter"><Input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" /></Field>
      </div>
    </Modal>
  );
}

function PayModal({ open, settlementId, lastDay, owedBy, onClose, onDone }: { open: boolean; settlementId: string; lastDay: string; owedBy: boolean; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<{ accounts: MoneyAccount[] }>(open ? "/api/money-accounts" : null);
  const usable = (accounts.data?.accounts ?? []).filter((a) => a.moneyKind === "bank" || a.moneyKind === "cash");
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const chosen = account || usable[0]?.id || "";
  const save = async () => {
    setBusy(true);
    try { await post(`/api/settlements/${settlementId}/paid`, { date, accountId: chosen }); toast.success("Settlement marked paid"); onClose(); onDone(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={owedBy ? "Received from the employee" : "Settlement paid"} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!chosen} onClick={() => void save()}>Mark paid</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={owedBy ? "Received into" : "Paid from"}><Select value={chosen} onChange={(e) => setAccount(e.target.value)} aria-label={owedBy ? "Received into" : "Paid from"}>{usable.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select></Field>
        <Field label="Date"><Input type="date" value={date} min={lastDay} max={today()} onChange={(e) => setDate(e.target.value)} aria-label="Date" /></Field>
      </div>
    </Modal>
  );
}
