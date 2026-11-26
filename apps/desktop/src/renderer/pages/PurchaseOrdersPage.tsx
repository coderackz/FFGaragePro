import { Plus, ShoppingCart } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { PO_STATUSES, STATUS_LABELS } from "@ffgp/shared";
import { PartsRequests } from "../components/PartsRequests";
import { UsedPartsToBuy } from "../components/UsedPartsToBuy";
import { Badge, Button, Card, Empty, PageHeader, Select, Spinner, StatusBadge, Table } from "../components/ui";
import { ShowMore, usePageLimit } from "../components/ShowMore";
import { useAuth } from "../lib/auth";
import { formatAED, formatDate } from "../lib/format";
import type { PurchaseOrderSummary, Supplier } from "../lib/types";
import { useApi } from "../lib/useApi";

export function PurchaseOrdersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const filters = new URLSearchParams({ ...(status ? { status } : {}), ...(supplierId ? { supplierId } : {}) }).toString();
  const [limit, showMore] = usePageLimit(filters);
  const { data, loading, reload } = useApi<{ purchaseOrders: PurchaseOrderSummary[]; more: boolean }>(`/api/purchase-orders?${filters ? `${filters}&` : ""}limit=${limit}`);
  const suppliers = useApi<{ suppliers: Supplier[] }>("/api/suppliers");
  const showCost = can("costs.view");

  return (
    <>
      <PageHeader title="Purchase orders" subtitle="Parts ordered from suppliers"
        actions={can("purchases.manage") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/purchase-orders/new")}>New purchase order</Button>} />
      <PartsRequests />
      <UsedPartsToBuy onBought={() => void reload()} />
      <div className="mb-3 flex items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Status filter">
          <option value="">All statuses</option>
          {PO_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </Select>
        <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="w-60" aria-label="Supplier filter">
          <option value="">All suppliers</option>
          {(suppliers.data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {loading && <Spinner className="size-4 text-zinc-400" />}
      </div>
      <Card padded={false}>
        <Table
          rows={data?.purchaseOrders ?? []}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/purchase-orders/${p.id}`)}
          empty={!loading && <Empty icon={<ShoppingCart className="size-10" />} title="No purchase orders">Parts requested on job cards come here; or start a purchase order.</Empty>}
          columns={[
            { header: "Number", cell: (p) => <span className="flex items-center gap-2"><span className="font-mono font-medium">{p.number}</span>{p.usedPart && <Badge>Used part</Badge>}</span> },
            { header: "Supplier", cell: (p) => p.supplierName ?? <span className="text-amber-700">Not chosen yet</span> },
            { header: "Date", cell: (p) => formatDate(p.createdAt) },
            { header: "Lines", cell: (p) => p.lineCount, align: "right" },
            { header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
            ...(showCost ? [{ header: "Amount", align: "right" as const, cell: (p: PurchaseOrderSummary) => formatAED(p.netFils ?? 0) }] : []),
          ]}
        />
        <ShowMore more={data?.more} loading={loading} shown={data?.purchaseOrders.length ?? 0} onMore={showMore} />
      </Card>
    </>
  );
}
