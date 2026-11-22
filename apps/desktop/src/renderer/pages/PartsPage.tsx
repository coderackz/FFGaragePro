import clsx from "clsx";
import { Package, Plus, ScanSearch, Upload } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { PartFormModal } from "../components/inventoryForms";
import { PartImportDialog } from "../components/PartImportDialog";
import { ShowMore, usePageLimit } from "../components/ShowMore";
import { Badge, Button, Card, Empty, Modal, PageHeader, SearchInput, Select, Spinner, Table } from "../components/ui";
import { useAuth } from "../lib/auth";
import { formatAED, formatDate } from "../lib/format";
import type { Part, PartCategory, StockUnit } from "../lib/types";
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
  const [categoryId, setCategoryId] = useState("");
  const categories = useApi<{ categories: PartCategory[] }>("/api/part-categories");
  const catName = (id: string | null | undefined) => categories.data?.categories.find((c) => c.id === id)?.name ?? "—";
  const filters = `q=${encodeURIComponent(query)}${lowStock ? "&lowStock=1" : ""}${categoryId ? `&categoryId=${categoryId}` : ""}`;
  const [limit, showMore] = usePageLimit(filters);
  const { data, loading, reload } = useApi<{ parts: Part[]; more: boolean }>(`/api/parts?${filters}&limit=${limit}`);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [finding, setFinding] = useState(false);
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
        <SearchInput value={q} onChange={setQ} placeholder="Search part no, OEM no, name, brand, tyre size…" />
        <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category" className="w-48">
          <option value="">All categories</option>
          {(categories.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <div className="inline-flex rounded-md border border-zinc-300 bg-white p-0.5 text-sm shadow-xs">
          {[{ v: false, label: "All parts" }, { v: true, label: "Low stock" }].map((o) => (
            <button key={o.label} type="button" onClick={() => setParams(o.v ? { lowStock: "1" } : {})}
              className={clsx("rounded px-2.5 py-1 whitespace-nowrap", lowStock === o.v ? "bg-ink text-white" : "text-zinc-600 hover:bg-zinc-100")}>
              {o.label}
            </button>
          ))}
        </div>
        {loading && <Spinner className="size-4 text-zinc-400" />}
        <Button size="sm" variant="ghost" className="ml-auto shrink-0 whitespace-nowrap" icon={<ScanSearch className="size-4" />} onClick={() => setFinding(true)}>Find a serial or DOT</Button>
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
            { header: "Name", cell: (p) => (
              <span className={clsx(!p.active && "text-zinc-400 line-through")}>
                {p.name}{p.supersededById && <span className="ml-2"><Badge>Replaced</Badge></span>}
                {p.matchedBy && <span className="ml-2 text-xs text-zinc-500">{p.matchedBy}</span>}
              </span>
            ) },
            { header: "Category", cell: (p) => catName(p.categoryId) },
            { header: "Brand", cell: (p) => p.brand ?? "—" },
            { header: "Type", cell: (p) => (p.isKit ? <Badge tone="zinc">Kit</Badge> : p.stocked ? <Badge>Stocked</Badge> : <Badge tone="brand">Per job</Badge>) },
            { header: "On hand", align: "right", cell: (p) => <span className={stockTone(p)}>{p.isKit ? `${p.kitAvailable ?? 0} kits` : p.stocked ? `${p.onHand} ${p.unit === "each" ? "" : p.unit}` : "—"}</span> },
            { header: "Sell price", align: "right", cell: (p) => formatAED(p.sellPriceFils) },
            ...(showCost ? [{ header: "Avg cost", align: "right" as const, cell: (p: Part) => (p.stocked ? formatAED(p.avgCostFils ?? 0) : "—") }] : []),
          ]}
        />
        <ShowMore more={data?.more} loading={loading} shown={data?.parts.length ?? 0} onMore={showMore} />
      </Card>
      <PartFormModal open={creating} onClose={() => setCreating(false)} onSaved={(p) => navigate(`/parts/${p.id}`)} />
      <PartImportDialog open={importing} onClose={() => setImporting(false)} onDone={() => void reload()} />
      <FindUnitModal open={finding} onClose={() => setFinding(false)} />
    </>
  );
}

/** Finds a tyre or battery by its serial or DOT: which part, and where it is or was fitted (customer, vehicle). */
function FindUnitModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 250);
  const found = useApi<{ units: StockUnit[] }>(open && query.length >= 2 ? `/api/stock-units?q=${encodeURIComponent(query)}` : null);
  const navigate = useNavigate();
  const STATUS: Record<string, string> = { in_stock: "On the shelf", fitted: "Fitted", returned: "Returned", written_off: "Written off" };
  return (
    <Modal open={open} onClose={() => { setQ(""); onClose(); }} title="Find a serial or DOT" width="max-w-3xl">
      <SearchInput value={q} onChange={setQ} placeholder="Serial number or DOT code" />
      <div className="mt-3">
        <Table
          rows={found.data?.units ?? []}
          rowKey={(u) => u.id}
          onRowClick={(u) => { onClose(); navigate(u.documentId ? `/documents/${u.documentId}` : `/parts/${u.partId}`); }}
          empty={<Empty title={query.length < 2 ? "Type at least 2 characters" : "Nothing found"} />}
          columns={[
            { header: "Code", cell: (u) => <span className="font-mono">{u.code}</span> },
            { header: "Part", cell: (u) => <span><span className="font-mono">{u.partNo}</span> {u.partName}</span> },
            { header: "Where", cell: (u) => (u.status === "fitted" ? `${u.documentNumber ?? ""} · ${u.customerName ?? ""}${u.vehiclePlate ? ` · ${u.vehiclePlate}` : ""}` : STATUS[u.status ?? ""] ?? "") },
            { header: "Warranty to", cell: (u) => (u.warrantyEnds ? formatDate(u.warrantyEnds) : "—") },
          ]}
        />
      </div>
    </Modal>
  );
}
