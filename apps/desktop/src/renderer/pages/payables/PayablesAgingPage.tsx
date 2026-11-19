import { AGING_BUCKETS, type AgingBucket } from "@ffgp/shared";
import { useNavigate } from "react-router";
import { Card, Empty, PageHeader, Spinner, Table } from "../../components/ui";
import { formatAED } from "../../lib/format";
import { useApi } from "../../lib/useApi";

const LABELS: Record<AgingBucket, string> = { current: "Not due", "1-30": "1–30 days", "31-60": "31–60 days", "61-90": "61–90 days", "90+": "Over 90 days" };
interface Row { id: string; name: string; buckets: Record<AgingBucket, number>; totalFils: number; advanceFils: number }

/** What we owe each supplier, by how late it is, with advances paid beside it. */
export function PayablesAgingPage() {
  const navigate = useNavigate();
  const { data } = useApi<{ suppliers: Row[]; totals: Record<AgingBucket, number> }>("/api/reports/payables-aging");
  return (
    <>
      <PageHeader title="Payables aging" subtitle="What we owe suppliers, by days past due" />
      <Card padded={false}>
        {!data ? <Spinner /> : (
          <Table rows={data.suppliers} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/suppliers/${r.id}`)} empty={<Empty title="Nothing owed to suppliers" />}
            columns={[
              { header: "Supplier", cell: (r) => r.name },
              ...AGING_BUCKETS.map((b) => ({ header: LABELS[b], cell: (r: Row) => (r.buckets[b] ? formatAED(r.buckets[b]) : ""), align: "right" as const })),
              { header: "Total", cell: (r) => formatAED(r.totalFils), align: "right" },
              { header: "Advance", cell: (r) => (r.advanceFils ? formatAED(r.advanceFils) : ""), align: "right" },
            ]} />
        )}
      </Card>
    </>
  );
}
