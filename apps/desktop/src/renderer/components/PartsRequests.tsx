import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { post } from "../lib/api";
import { formatDate } from "../lib/format";
import type { BuyerList } from "../lib/types";
import { useApi } from "../lib/useApi";
import { Badge, Button, Card, Table } from "./ui";

/**
 * What the buyer still has to do for job cards, so no part is forgotten: requests waiting for a vendor (oldest first),
 * orders not sent to their vendor, and parts that reached an order after it was placed.
 */
export function PartsRequests() {
  const navigate = useNavigate();
  const { data, reload } = useApi<BuyerList>("/api/parts-requests");
  const [busy, setBusy] = useState<string | null>(null);
  const requests = data?.requests ?? [];
  const unsent = data?.unsent ?? [];
  const late = data?.late ?? [];
  const requestAgain = async (poId: string, lineId: string) => {
    setBusy(lineId);
    try {
      await post(`/api/purchase-orders/${poId}/lines/${lineId}/request-again`, {});
      toast.success("Back on a request");
      await reload();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {late.length > 0 && (
        <div className="mb-4" data-testid="late-parts">
          <Card title={`Added after ordering (${late.length})`} padded={false}>
            <p className="px-4 pt-3 text-sm text-amber-800">Requested on another computer while the order was being placed: the vendor wasn't asked for these.</p>
            <Table rows={late} rowKey={(l) => l.poLineId}
              columns={[
                { header: "Part", cell: (l) => <span className="font-medium">{l.description}</span> },
                { header: "Qty", cell: (l) => l.qty, align: "right" },
                { header: "Job card", cell: (l) => <span className="font-mono text-[13px]">{l.jobDocumentNumber ?? "—"}</span> },
                { header: "On", cell: (l) => <Link className="font-mono text-[13px] text-brand-700 hover:underline" to={`/purchase-orders/${l.purchaseOrderId}`}>{l.purchaseOrderNumber}</Link> },
                { header: "Vendor", cell: (l) => l.supplierName },
                { header: "", align: "right", cell: (l) => <Button size="sm" busy={busy === l.poLineId} onClick={() => void requestAgain(l.purchaseOrderId, l.poLineId)}>Request again</Button> },
              ]} />
          </Card>
        </div>
      )}
      {requests.length > 0 && (
        <div className="mb-4" data-testid="parts-requests">
          <Card title={`Parts requests (${requests.length})`} padded={false}>
            <Table rows={requests} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/purchase-orders/${r.id}`)}
              columns={[
                { header: "Request", cell: (r) => <span className="font-mono font-medium">{r.number}</span> },
                { header: "Job card", cell: (r) => <span className="font-mono text-[13px]">{r.jobDocumentNumber ?? "—"}</span> },
                { header: "Vehicle", cell: (r) => r.vehicle ? `${[r.vehicle.make, r.vehicle.model, r.vehicle.year].filter(Boolean).join(" ")} · ${r.vehicle.plate}` : "—" },
                { header: "Parts", cell: (r) => r.lineCount, align: "right" },
                {
                  header: "Where it is",
                  cell: (r) => !r.asked ? <Badge tone="amber">Not sent to vendors</Badge>
                    : <span>Asked {r.asked} · {r.priced} priced{r.notSent ? <> · <span className="text-amber-700">{r.notSent} not sent yet</span></> : null}</span>,
                },
                { header: "Requested", cell: (r) => formatDate(r.createdAt) },
              ]} />
          </Card>
        </div>
      )}
      {unsent.length > 0 && (
        <div className="mb-4" data-testid="unsent-orders">
          <Card title={`Ordered, not sent (${unsent.length})`} padded={false}>
            <Table rows={unsent} rowKey={(o) => o.id} onRowClick={(o) => navigate(`/purchase-orders/${o.id}`)}
              columns={[
                { header: "Order", cell: (o) => <span className="font-mono font-medium">{o.number}</span> },
                { header: "Vendor", cell: (o) => o.supplierName },
                { header: "Job card", cell: (o) => <span className="font-mono text-[13px]">{o.jobDocumentNumber ?? "—"}</span> },
                { header: "Parts", cell: (o) => o.lineCount, align: "right" },
                { header: "", cell: () => <Badge tone="amber">Send to the vendor</Badge> },
              ]} />
          </Card>
        </div>
      )}
    </>
  );
}
