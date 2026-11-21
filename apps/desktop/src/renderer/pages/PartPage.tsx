import { ArrowLeft, Pencil, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { AdjustStockModal, PartFormModal } from "../components/inventoryForms";
import { fitmentText } from "../components/catalogueFields";
import { PART_NUMBER_KIND_LABELS } from "@ffgp/shared";
import { toast } from "sonner";
import { post } from "../lib/api";
import { Badge, Button, Card, Empty, Input, Modal, PageHeader, Spinner, Table } from "../components/ui";
import { useAuth } from "../lib/auth";
import { formatAED, formatDateTime } from "../lib/format";
import type { Part, PartCategory, StockMovement } from "../lib/types";
import { useApi, useDebounced } from "../lib/useApi";
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
  const [replacing, setReplacing] = useState(false);

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
        <CatalogueCard part={part} canEdit={can("inventory.edit")} onReplace={() => setReplacing(true)} onChanged={() => void reload()} />
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
      <ReplaceModal open={replacing} part={part} onClose={() => setReplacing(false)} onSaved={() => void reload()} />
    </>
  );
}

/** The part's catalogue: category and specs, other numbers, the vehicles it fits, packs, and what replaced it. */
function CatalogueCard({ part, canEdit, onReplace, onChanged }: { part: Part; canEdit: boolean; onReplace: () => void; onChanged: () => void }) {
  const categories = useApi<{ categories: PartCategory[] }>("/api/part-categories");
  const defs = categories.data?.categories.find((c) => c.id === part.categoryId)?.attributes ?? [];
  const specs = defs.filter((d) => part.attributes?.[d.key] !== undefined).map((d) => `${d.label}: ${part.attributes![d.key]}${d.unit ? ` ${d.unit}` : ""}`);
  const unreplace = async () => {
    try { await post(`/api/parts/${part.id}/supersede`, { byPartId: null }); toast.success("No longer marked as replaced"); onChanged(); } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <Card title="Catalogue" actions={canEdit && <Button size="sm" variant="ghost" onClick={onReplace}>Replaced by…</Button>}>
      <div className="space-y-3 text-sm" data-testid="catalogue">
        <div><span className="text-zinc-500">Category: </span>{part.categoryName ?? "—"}{specs.length > 0 && <div className="mt-1 text-zinc-700">{specs.join(" · ")}</div>}</div>
        {part.supersededBy && (
          <div className="rounded-md bg-amber-50 px-2.5 py-1.5 text-amber-800">
            Replaced by <Link className="font-mono font-medium underline" to={`/parts/${part.supersededBy.id}`}>{part.supersededBy.partNo}</Link> {part.supersededBy.name}
            {canEdit && <button type="button" className="ml-2 text-xs underline" onClick={() => void unreplace()}>Undo</button>}
          </div>
        )}
        {(part.replaces?.length ?? 0) > 0 && <div className="text-zinc-600">Replaces {part.replaces!.map((r) => r.partNo).join(", ")}</div>}
        {(part.chain?.length ?? 0) > 2 && <div className="text-xs text-zinc-500">Chain: {part.chain!.map((c) => c.partNo).join(" → ")}</div>}
        <div>
          <div className="text-zinc-500">Other numbers</div>
          {part.numbers?.length ? <ul className="mt-0.5">{part.numbers.map((n, i) => <li key={i}><span className="font-mono">{n.number}</span> <span className="text-xs text-zinc-500">{PART_NUMBER_KIND_LABELS[n.kind]}{n.brand ? ` · ${n.brand}` : ""}</span></li>)}</ul> : <div>—</div>}
        </div>
        <div>
          <div className="text-zinc-500">Fits</div>
          {part.fitments?.length ? <ul className="mt-0.5">{part.fitments.map((f, i) => <li key={i}>{fitmentText(f)}</li>)}</ul> : <div>{part.fits ?? "—"}</div>}
        </div>
        {(part.packs?.length ?? 0) > 0 && <div><span className="text-zinc-500">Bought in: </span>{part.packs!.map((p) => `${p.name} (${p.size} ${part.unit})`).join(", ")}</div>}
      </div>
    </Card>
  );
}

/** "Replaced by…": pick the newer part; searching for this one then offers that one. */
function ReplaceModal({ open, part, onClose, onSaved }: { open: boolean; part: Part; onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState("");
  const query = useDebounced(q, 150);
  const results = useApi<{ parts: Part[] }>(open && query.trim().length >= 2 ? `/api/parts?active=1&q=${encodeURIComponent(query.trim())}` : null);
  const choose = async (p: Part) => {
    try {
      await post(`/api/parts/${part.id}/supersede`, { byPartId: p.id });
      toast.success(`${part.partNo} is now replaced by ${p.partNo}`);
      onClose(); onSaved();
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`${part.partNo} is replaced by…`} footer={<Button onClick={onClose}>Cancel</Button>}>
      <p className="mb-3 text-sm text-zinc-600">Its history stays. While it has stock it's still offered first; after that the replacement is.</p>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the replacement's number or name" aria-label="Replacement part" autoFocus />
      <ul role="listbox" className="mt-2 max-h-64 overflow-y-auto">
        {(results.data?.parts ?? []).filter((p) => p.id !== part.id).map((p) => (
          <li key={p.id} role="option" aria-selected={false} onClick={() => void choose(p)} className="flex cursor-pointer gap-3 rounded px-2 py-1.5 text-sm hover:bg-brand-50">
            <span className="w-28 shrink-0 font-mono text-xs text-zinc-500">{p.partNo}</span><span>{p.name}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
