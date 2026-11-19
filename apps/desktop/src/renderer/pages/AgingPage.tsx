import { dubaiDate } from "@ffgp/shared";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Empty, Field, Input, PageHeader, Table } from "../components/ui";
import { formatAED } from "../lib/format";
import type { AgingBucket } from "../lib/types";
import { useApi } from "../lib/useApi";

interface Row { id: string; name: string; buckets: Record<AgingBucket, number>; totalFils: number; creditFils: number }
const BUCKETS: [AgingBucket, string][] = [["current", "Not yet due"], ["1-30", "1–30 days"], ["31-60", "31–60 days"], ["61-90", "61–90 days"], ["90+", "Over 90 days"]];

/** Owner and Accountant: who owes what, and how late. */
export function AgingPage() {
  const navigate = useNavigate();
  const [asOf, setAsOf] = useState(dubaiDate(new Date().toISOString()));
  const { data } = useApi<{ customers: Row[]; totals: Record<AgingBucket, number> }>(`/api/reports/aging?asOf=${asOf}`);
  const amount = (n: number) => (n ? formatAED(n) : "—");
  return (
    <>
      <PageHeader title="Aging" subtitle="What customers owe, by how many days past the due date" actions={<Field label="As of"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="As of" /></Field>} />
      <Table
        rows={data?.customers ?? []}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/customers/${r.id}`)}
        empty={<Empty title="Nobody owes anything" />}
        columns={[
          { header: "Customer", cell: (r) => <span className="font-medium">{r.name}</span> },
          ...BUCKETS.map(([b, label]) => ({ header: label, cell: (r: Row) => <span className={b === "90+" && r.buckets[b] ? "font-medium text-red-700" : ""}>{amount(r.buckets[b])}</span>, align: "right" as const })),
          { header: "Total", cell: (r) => <b>{formatAED(r.totalFils)}</b>, align: "right" },
          { header: "Credit", cell: (r) => amount(r.creditFils), align: "right" },
        ]}
      />
      {data && data.customers.length > 0 && (
        <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm text-zinc-700" data-testid="aging-totals">
          {BUCKETS.map(([b, label]) => <span key={b}>{label}: <b className="tabular">{formatAED(data.totals[b])}</b></span>)}
        </div>
      )}
    </>
  );
}
