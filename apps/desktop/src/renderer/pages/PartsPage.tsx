import clsx from "clsx";
import { Package, Plus, Upload } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { PartFormModal } from "../components/inventoryForms";
import { PartImportDialog } from "../components/PartImportDialog";
import { Badge, Button, Card, Empty, PageHeader, SearchInput, Spinner, Table } from "../components/ui";
import { useAuth } from "../lib/auth";
import { formatAED } from "../lib/format";
import type { Part } from "../lib/types";
import { useApi, useDebounced } from "../lib/useApi";

export function stockTone(p: Pick<Part, "stocked" | "onHand" | "lowStock">) {
  if (!p.stocked) return "text-zinc-400";
  if (p.onHand < 0) return "font-semibold text-red-700";
  return p.lowStock ? "font-semibold text-amber-700" : "";
}

export function PartsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const lowStock = params.get("lowStock") === "1";
  const [q, setQ] = useState("");
  const query = useDebounced(q);
  const { data, loading, reload } = useApi<{ parts: Part[] }>(`/api/parts?q=${encodeURIComponent(query)}${lowStock ? "&lowStock=1" : ""}`);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const navigate = useNavigate();
  const showCost = can("costs.view");

  return (
    <>
      <PageHeader
        title="Parts"
        subtitle="Shelf stock and parts bought per job"
        actions={can("inventory.edit") && (
          <>
            <Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>Import CSV</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New part</Button>
          </>
        )}
      />
      <div className="mb-3 flex items-center gap-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search part no, name, brand, vehicle" />
        <div className="inline-flex rounded-md border border-zinc-300 bg-white p-0.5 text-sm shadow-xs">
          {[{ v: false, label: "All parts" }, { v: true, label: "Low stock" }].map((o) => (
            <button key={o.label} type="button" onClick={() => setParams(o.v ? { lowStock: "1" } : {})}
              className={clsx("rounded px-2.5 py-1", lowStock === o.v ? "bg-ink text-white" : "text-zinc-600 hover:bg-zinc-100")}>
              {o.label}
            </button>
          ))}
        </div>
        {loading && <Spinner className="size-4 text-zinc-400" />}
      </div>
      <Card padded={false}>
        <Table
          rows={data?.parts ?? []}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/parts/${p.id}`)}
          empty={!loading && (
            <Empty icon={<Package className="size-10" />} title={lowStock ? "Nothing is low on stock" : q ? "No matching parts" : "No parts yet"}>
              {!lowStock && !q && "Add parts one by one, or import your list from a spreadsheet."}
            </Empty>
          )}
          columns={[
            { header: "Part no", cell: (p) => <span className="font-mono text-[13px] font-medium">{p.partNo}</span> },
            { header: "Name", cell: (p) => <span className={clsx(!p.active && "text-zinc-400 line-through")}>{p.name}</span> },
            { header: "Brand", cell: (p) => p.brand ?? "—" },
            { header: "Type", cell: (p) => (p.stocked ? <Badge>Stocked</Badge> : <Badge tone="brand">Per job</Badge>) },
            { header: "On hand", align: "right", cell: (p) => <span className={stockTone(p)}>{p.stocked ? `${p.onHand} ${p.unit === "each" ? "" : p.unit}` : "—"}</span> },
            { header: "Sell price", align: "right", cell: (p) => formatAED(p.sellPriceFils) },
            ...(showCost ? [{ header: "Avg cost", align: "right" as const, cell: (p: Part) => (p.stocked ? formatAED(p.avgCostFils ?? 0) : "—") }] : []),
          ]}
        />
      </Card>
      <PartFormModal open={creating} onClose={() => setCreating(false)} onSaved={(p) => navigate(`/parts/${p.id}`)} />
      <PartImportDialog open={importing} onClose={() => setImporting(false)} onDone={() => void reload()} />
    </>
  );
}
