import { Banknote } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Empty, Field, Input, PageHeader, Table } from "../../components/ui";
import { post } from "../../lib/api";
import { formatAED } from "../../lib/format";
import { useApi } from "../../lib/useApi";

export interface RunSummary {
  id: string; month: string; status: "draft" | "approved"; wpsPaidOn: string | null; bonusPaidOn: string | null; people: number;
  totals: { grossFils: number; bonusFils: number; netWpsFils: number; gratuityFils: number };
}
export const monthLabel = (month: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
export const runStatus = (r: { status: string; wpsPaidOn: string | null; bonusPaidOn: string | null }) =>
  [r.status === "approved" ? "Approved" : "Draft", r.wpsPaidOn ? "WPS paid" : null, r.bonusPaidOn ? "Bonus paid" : null].filter(Boolean) as string[];

const lastMonth = () => {
  const t = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  return new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
};

/** Payroll runs, month by month; start the next one. */
export function PayrollPage() {
  const navigate = useNavigate();
  const { data, loading } = useApi<{ runs: RunSummary[] }>("/api/payroll/runs");
  const [month, setMonth] = useState(lastMonth());
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const { run } = await post<{ run: { id: string } }>("/api/payroll/runs", { month });
      navigate(`/payroll/${run.id}`);
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Payroll" subtitle="Salaries by WPS, the cash bonus, payslips" />
      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Month"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" /></Field>
          <Button variant="primary" icon={<Banknote className="size-4" />} busy={busy} disabled={!month} onClick={() => void start()}>Run payroll</Button>
          <span className="text-sm text-zinc-600">The accountant prepares the month; the owner approves it.</span>
        </div>
      </Card>
      <Card padded={false}>
        <Table rows={data?.runs ?? []} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/payroll/${r.id}`)}
          empty={!loading && <Empty icon={<Banknote className="size-10" />} title="No payroll yet" />}
          columns={[
            { header: "Month", cell: (r) => <span className="font-medium">{monthLabel(r.month)}</span> },
            { header: "Status", cell: (r) => runStatus(r).map((s) => <span key={s} className="mr-1"><Badge tone={s === "Draft" ? "brand" : "zinc"}>{s}</Badge></span>) },
            { header: "People", cell: (r) => r.people, align: "right" },
            { header: "WPS", cell: (r) => formatAED(r.totals.netWpsFils), align: "right" },
            { header: "Cash bonus", cell: (r) => formatAED(r.totals.bonusFils), align: "right" },
          ]} />
      </Card>
    </>
  );
}
