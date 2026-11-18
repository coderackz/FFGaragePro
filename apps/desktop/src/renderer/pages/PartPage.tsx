import { ArrowLeft, Pencil, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { AdjustStockModal, PartFormModal } from "../components/inventoryForms";
import { Badge, Button, Card, Empty, PageHeader, Spinner, Table } from "../components/ui";
import { useAuth } from "../lib/auth";
import { formatAED, formatDateTime } from "../lib/format";
import type { Part, StockMovement } from "../lib/types";
import { useApi } from "../lib/useApi";
import { stockTone } from "./PartsPage";

const REASONS: Record<StockMovement["reason"], string> = {
  receive: "Received", job: "Job card", invoice: "Invoice", adjust: "Adjustment", opening: "Opening stock",
};

export function PartPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, error, reload } = useApi<{ part: Part; movements: StockMovement[] }>(`/api/parts/${id}`);
  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);

  if (error) return <Empty title="Part not found">{error}</Empty>;
  if (!data) return <Spinner />;
  const { part, movements } = data;
  const showCost = can("costs.view");

  return (
    <>
      <PageHeader
        back={<Link to="/parts" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Parts</Link>}
        title={part.name}
        subtitle={<span className="flex items-center gap-2"><span className="font-mono">{part.partNo}</span>{part.stocked ? <Badge>Stocked</Badge> : <Badge tone="brand">Bought per job</Badge>}{!part.active && <Badge tone="red">Inactive</Badge>}</span>}
        actions={can("inventory.edit") && (
          <>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
            {part.stocked && <Button variant="primary" icon={<SlidersHorizontal className="size-4" />} onClick={() => setAdjusting(true)}>Adjust stock</Button>}
          </>
        )}
      />
      <div className="grid grid-cols-3 gap-5">
        <Card title="Details">
          <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-sm">
            <dt className="text-zinc-500">Brand</dt><dd>{part.brand ?? "—"}</dd>
            <dt className="text-zinc-500">Unit</dt><dd>{part.unit}</dd>
            <dt className="text-zinc-500">Sell price</dt><dd className="tabular">{formatAED(part.sellPriceFils)}</dd>
            <dt className="text-zinc-500">Shelf / bin</dt><dd>{part.location ?? "—"}</dd>
            <dt className="text-zinc-500">Fits</dt><dd>{part.fits ?? "—"}</dd>
          </dl>
        </Card>
        {part.stocked ? (
          <Card title="Stock">
            <div className={`text-3xl font-semibold tabular ${stockTone(part)}`} data-testid="on-hand">{part.onHand}</div>
            <div className="mt-1 text-sm text-zinc-500">on the shelf · reorder at {part.reorderLevel}</div>
            {part.onHand < 0 && <div className="mt-2 text-sm text-red-700">More has been used than received — a delivery may not have been entered.</div>}
            {showCost && (
              <dl className="mt-3 grid grid-cols-[110px_1fr] gap-y-1.5 border-t border-zinc-100 pt-3 text-sm">
                <dt className="text-zinc-500">Average cost</dt><dd className="tabular">{formatAED(part.avgCostFils ?? 0)}</dd>
                <dt className="text-zinc-500">Stock value</dt><dd className="tabular">{formatAED(part.stockValueFils ?? 0)}</dd>
              </dl>
            )}
          </Card>
        ) : (
          <Card title="Stock"><p className="text-sm text-zinc-500">Not kept on the shelf. Request it from a job card when it's needed.</p></Card>
        )}
        <div />
        <Card title="Movements" className="col-span-3" padded={false}>
          <Table
            rows={movements}
            rowKey={(m) => m.id}
            empty={<Empty title="No stock movements yet" />}
            columns={[
              { header: "Date", cell: (m) => formatDateTime(m.createdAt) },
              { header: "What", cell: (m) => REASONS[m.reason] },
              {
                header: "Ref",
                cell: (m) =>
                  m.documentId ? <Link className="font-mono text-brand-700 hover:underline" to={`/documents/${m.documentId}`}>{m.documentNumber}</Link>
                  : m.purchaseOrderId ? <Link className="font-mono text-brand-700 hover:underline" to={`/purchase-orders/${m.purchaseOrderId}`}>{m.purchaseOrderNumber}</Link>
                  : <span className="text-zinc-500">{m.note ?? "—"}</span>,
              },
              { header: "By", cell: (m) => m.createdBy ?? "—" },
              { header: "Qty", align: "right", cell: (m) => <span className={m.qty < 0 ? "text-red-700" : "text-emerald-700"}>{m.qty > 0 ? `+${m.qty}` : m.qty}</span> },
              ...(showCost ? [{ header: "Cost each", align: "right" as const, cell: (m: StockMovement) => formatAED(m.unitCostFils ?? 0) }] : []),
            ]}
          />
        </Card>
      </div>
      <PartFormModal open={editing} part={part} onClose={() => setEditing(false)} onSaved={() => void reload()} />
      <AdjustStockModal open={adjusting} part={part} onClose={() => setAdjusting(false)} onSaved={() => void reload()} />
    </>
  );
}
