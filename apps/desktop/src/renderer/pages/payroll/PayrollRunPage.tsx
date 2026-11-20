import { ArrowLeft, CheckCircle2, Download, Printer, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner } from "../../components/ui";
import { get, patch, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatAED } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import type { MoneyAccount } from "../../payables/types";
import { printBonusVoucher, printPayslips } from "../../print/print";
import type { BonusVoucher, Payslip } from "../../print/templates";
import { monthLabel, runStatus } from "./PayrollPage";

interface Line {
  employeeId: string; name: string; job: string; workedDays: number; basicFils: number; allowancesFils: number; unpaidDays: number; unpaidDeductionFils: number;
  advanceRepaymentFils: number; extrasFils: number; extrasNote: string | null; bonusFils: number; netFils: number; gratuityFils: number; bonusInWps: boolean;
}
interface Run {
  id: string; month: string; status: "draft" | "approved"; wpsPaidOn: string | null; bonusPaidOn: string | null; lines: Line[];
  totals: { grossFils: number; deductionsFils: number; advancesFils: number; bonusFils: number; gratuityFils: number; netWpsFils: number };
}
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

/** One month's payroll: the grid while it's prepared, then approval, the WPS file, paying, vouchers and payslips. */
export function PayrollRunPage() {
  const { id } = useParams();
  const { garage, settings, can } = useAuth();
  const { data, reload } = useApi<{ run: Run }>(`/api/payroll/runs/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [paying, setPaying] = useState<"wps" | "bonus" | null>(null);
  if (!data || !garage || !settings) return <Spinner />;
  const r = data.run;
  const draft = r.status === "draft";
  const cashBonus = r.lines.some((l) => l.bonusFils > 0 && !l.bonusInWps);
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try { await fn(); if (done) toast.success(done); await reload(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(null); }
  };
  const editBonus = (l: Line, fils: number) => fils !== l.bonusFils && void run(`bonus:${l.employeeId}`, () => patch(`/api/payroll/runs/${r.id}/lines/${l.employeeId}`, { bonusFils: fils }));
  const approve = () => {
    if (!window.confirm(`Approve ${monthLabel(r.month)}? WPS ${formatAED(r.totals.netWpsFils)}, cash bonus ${formatAED(r.lines.filter((l) => !l.bonusInWps).reduce((s, l) => s + l.bonusFils, 0))}. It can't change afterwards.`)) return;
    void run("approve", () => post(`/api/payroll/runs/${r.id}/approve`, {}), "Payroll approved");
  };
  const wps = () => run("wps", async () => {
    const f = await get<{ fileName: string; text: string }>(`/api/payroll/runs/${r.id}/wps`);
    const href = URL.createObjectURL(new Blob([f.text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = href; a.download = f.fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  });
  const slips = () => run("slips", async () => printPayslips((await get<{ payslips: Payslip[] }>(`/api/payroll/runs/${r.id}/payslips`)).payslips, garage, settings, "print"));
  const voucher = () => run("voucher", async () => printBonusVoucher(await get<BonusVoucher>(`/api/payroll/runs/${r.id}/bonus-voucher`), garage, settings, "print"));
  const num = "px-2 py-2 text-right tabular";

  return (
    <>
      <PageHeader back={<Link to="/payroll" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Payroll</Link>}
        title={`Payroll ${monthLabel(r.month)}`}
        subtitle={<span data-testid="run-status" className="inline-flex gap-1">{runStatus(r).map((s) => <Badge key={s} tone={s === "Draft" ? "brand" : "zinc"}>{s}</Badge>)}</span>}
        actions={draft ? (
          <>
            <Button icon={<RefreshCw className="size-4" />} busy={busy === "refresh"} onClick={() => void run("refresh", () => post(`/api/payroll/runs/${r.id}/refresh`, {}), "Updated from the employees")}>Refresh from employees</Button>
            {can("payroll.approve") && <Button variant="primary" icon={<CheckCircle2 className="size-4" />} busy={busy === "approve"} onClick={approve}>Approve</Button>}
          </>
        ) : (
          <>
            <Button icon={<Download className="size-4" />} busy={busy === "wps"} onClick={() => void wps()}>Download WPS file</Button>
            {!r.wpsPaidOn && <Button onClick={() => setPaying("wps")}>Mark WPS paid</Button>}
            {cashBonus && <Button icon={<Printer className="size-4" />} busy={busy === "voucher"} onClick={() => void voucher()}>Print bonus voucher</Button>}
            {cashBonus && !r.bonusPaidOn && <Button onClick={() => setPaying("bonus")}>Mark bonus paid</Button>}
            <Button icon={<Printer className="size-4" />} busy={busy === "slips"} onClick={() => void slips()}>Print payslips</Button>
          </>
        )} />
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-500">
              <th className="px-4 py-2">Employee</th><th className="px-2 py-2 text-right">Days</th><th className="px-2 py-2 text-right">Basic</th><th className="px-2 py-2 text-right">Allowances</th>
              <th className="px-2 py-2 text-right">Unpaid leave</th><th className="px-2 py-2 text-right">Advance</th><th className="px-2 py-2 text-right">Extras</th>
              <th className="px-2 py-2 text-right">Bonus</th><th className="px-4 py-2 text-right">Net (WPS)</th>
            </tr></thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.employeeId} className="border-b border-zinc-100">
                  <td className="px-4 py-2"><Link to={`/employees/${l.employeeId}`} className="font-medium hover:underline">{l.name}</Link><div className="text-xs text-zinc-500">{l.job}</div></td>
                  <td className={num}>{l.workedDays}</td>
                  <td className={num}>{formatAED(l.basicFils)}</td>
                  <td className={num}>{formatAED(l.allowancesFils)}</td>
                  <td className={num}>{l.unpaidDays ? `${l.unpaidDays} d · ${formatAED(-l.unpaidDeductionFils)}` : ""}</td>
                  <td className={num} data-testid="advance">{l.advanceRepaymentFils ? formatAED(l.advanceRepaymentFils) : ""}</td>
                  <td className={num} title={l.extrasNote ?? ""}>{l.extrasFils ? formatAED(l.extrasFils) : ""}</td>
                  <td className="px-2 py-1 text-right">
                    {draft ? <MoneyInput fils={l.bonusFils} onChange={(f) => editBonus(l, f)} aria-label={`Bonus, ${l.name}`} className="ml-auto w-28 text-right" />
                      : <span className="tabular">{l.bonusFils ? `${formatAED(l.bonusFils)}${l.bonusInWps ? "" : " cash"}` : ""}</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular">{formatAED(l.netFils + (l.bonusInWps ? l.bonusFils : 0))}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="px-4 py-2" colSpan={5}>Total · gratuity put aside {draft ? "on approval" : formatAED(r.totals.gratuityFils)}</td>
                <td className={num}>{formatAED(r.totals.advancesFils)}</td><td />
                <td className={num} data-testid="total-bonus">{formatAED(r.totals.bonusFils)}</td>
                <td className="px-4 py-2 text-right tabular">{formatAED(r.totals.netWpsFils)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
      <PayModal kind={paying} runId={r.id} onClose={() => setPaying(null)} onDone={() => void reload()} />
    </>
  );
}

function PayModal({ kind, runId, onClose, onDone }: { kind: "wps" | "bonus" | null; runId: string; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<{ accounts: MoneyAccount[] }>(kind ? "/api/money-accounts" : null);
  const usable = (accounts.data?.accounts ?? []).filter((a) => a.moneyKind === (kind === "wps" ? "bank" : "cash"));
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const chosen = account || usable[0]?.id || "";
  const label = kind === "wps" ? "Paid from" : "Cash box";
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/api/payroll/runs/${runId}/${kind === "wps" ? "wps-paid" : "bonus-paid"}`, kind === "wps" ? { date, bankAccountId: chosen } : { date, cashAccountId: chosen });
      toast.success(kind === "wps" ? "Salaries marked paid" : "Cash bonus marked paid");
      onClose(); onDone();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!kind} title={kind === "wps" ? "Salaries paid through WPS" : "Cash bonus handed out"} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!chosen} onClick={() => void submit()}>Mark paid</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={label}><Select value={chosen} onChange={(e) => setAccount(e.target.value)} aria-label={label}>{usable.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select></Field>
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" /></Field>
      </div>
      {kind === "bonus" && <p className="mt-3 text-xs text-zinc-600">Each person signs the printed voucher when they take their bonus.</p>}
    </Modal>
  );
}
