import { useNavigate } from "react-router";
import { formatDate } from "../lib/format";
import type { PartsRequest } from "../lib/types";
import { useApi } from "../lib/useApi";
import { Badge, Card, Table } from "./ui";

/** Parts requested on job cards, waiting for the buyer to ask vendors and order: oldest first, so none is forgotten. */
export function PartsRequests() {
  const navigate = useNavigate();
  const { data } = useApi<{ requests: PartsRequest[] }>("/api/parts-requests");
  const requests = data?.requests ?? [];
  if (!requests.length) return null;
  return (
    <div className="mb-4" data-testid="parts-requests">
      <Card title={`Parts requests (${requests.length})`} padded={false}>
        <Table rows={requests} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/purchase-orders/${r.id}`)}
          columns={[
            { header: "Request", cell: (r) => <span className="font-mono font-medium">{r.number}</span> },
            { header: "Job card", cell: (r) => <span className="font-mono text-[13px]">{r.jobDocumentNumber ?? "—"}</span> },
            { header: "Vehicle", cell: (r) => r.vehicle ? `${[r.vehicle.make, r.vehicle.model, r.vehicle.year].filter(Boolean).join(" ")} · ${r.vehicle.plate}` : "—" },
            { header: "Parts", cell: (r) => r.lineCount, align: "right" },
            { header: "Where it is", cell: (r) => r.asked ? `Asked ${r.asked} · ${r.priced} priced` : <Badge tone="amber">Not sent to vendors</Badge> },
            { header: "Requested", cell: (r) => formatDate(r.createdAt) },
          ]} />
      </Card>
    </div>
  );
}
