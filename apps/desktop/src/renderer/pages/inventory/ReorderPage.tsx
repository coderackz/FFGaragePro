import { ShoppingCart, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Segmented } from "../../components/Segmented";
import { Badge, Button, Card, Empty, NumberInput, PageHeader, Select, Spinner, Table } from "../../components/ui";
import { post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatAED } from "../../lib/format";
import type { Supplier } from "../../lib/types";
import { useApi } from "../../lib/useApi";

interface SuggestedLine { partId: string; partNo: string; name: string; unit: string; qty: number; onHand: number; onOrder: number; reorderLevel: number; maxLevel: number; unitCostFils?: number }
interface SuggestedGroup { supplierId: string | null; supplierName: string; lines: SuggestedLine[] }
interface LevelRow {
  partId: string; partNo: string; name: string; unit: string; onHand: number; usage90: number; leadTimeDays: number;
  reorderLevel: number; maxLevel: number; suggestedMin: number; suggestedMax: number;
}

/** Inventory → Reorder: what to order now (made into draft POs in one click), and each part's min / max levels. */
export function ReorderPage() {
  const [view, setView] = useState<"orders" | "levels">("orders");
  return (
    <>
      <PageHeader title="Reorder" subtitle="What's running low, and the levels that decide it" actions={
        <Segmented label="Reorder view" value={view} onChange={setView} options={[["orders", "Suggested orders"], ["levels", "Min / max levels"]] as const} />
      } />
      {view === "orders" ? <SuggestedOrders /> : <Levels />}
    </>
  );
}

function SuggestedOrders() {
  const { can } = useAuth();
  const { data, reload } = useApi<{ suppliers: SuggestedGroup[] }>("/api/inventory/suggested-orders");
  const suppliers = useApi<{ suppliers: Supplier[] }>("/api/suppliers");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [skip, setSkip] = useState<Record<string, boolean>>({});
  const [supplierFor, setSupplierFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: string; number: string; supplier: { name: string } }[]>([]);
  useEffect(() => { setQty({}); setSkip({}); setSupplierFor({}); }, [data]);
  if (!data) return <Spinner />;
  const showCost = can("costs.view");
  const lines = data.suppliers.flatMap((g) => g.lines.map((l) => ({ ...l, supplierId: g.supplierId ?? supplierFor[l.partId] ?? "" })));
  const chosen = lines.filter((l) => !skip[l.partId] && (qty[l.partId] ?? l.qty) > 0);
  const missing = chosen.filter((l) => !l.supplierId).length;

  const make = async () => {
    setBusy(true);
    try {
      const res = await post<{ purchaseOrders: { id: string; number: string; supplier: { name: string } }[] }>("/api/inventory/suggested-orders", {
        lines: chosen.map((l) => ({ partId: l.partId, supplierId: l.supplierId, qty: qty[l.partId] ?? l.qty })),
      });
      setMade(res.purchaseOrders);
      toast.success(`${res.purchaseOrders.length} draft purchase order${res.purchaseOrders.length === 1 ? "" : "s"} made`);
      void reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {made.length > 0 && (
        <Card title="Drafts made">
          <div className="flex flex-wrap gap-3 text-sm">
            {made.map((p) => <Link key={p.id} to={`/purchase-orders/${p.id}`} className="font-mono text-brand-700 hover:underline">{p.number} · {p.supplier.name}</Link>)}
          </div>
        </Card>
      )}
      {data.suppliers.length === 0 ? (
        <Card><Empty icon={<ShoppingCart className="size-10" />} title="Nothing to order">Parts at or below their reorder level (counting what's on order) show here.</Empty></Card>
      ) : (
        <>
          {data.suppliers.map((g) => (
            <Card key={g.supplierId ?? "none"} title={g.supplierName} padded={false}>
              <Table
                rows={g.lines}
                rowKey={(l) => l.partId}
                columns={[
                  { header: "", cell: (l) => <input type="checkbox" aria-label={`Order ${l.partNo}`} checked={!skip[l.partId]} onChange={(e) => setSkip((s) => ({ ...s, [l.partId]: !e.target.checked }))} /> },
                  { header: "Part", cell: (l) => <Link to={`/parts/${l.partId}`} className="hover:underline"><span className="font-mono">{l.partNo}</span> {l.name}</Link> },
                  { header: "On hand", align: "right", cell: (l) => l.onHand },
                  { header: "On order", align: "right", cell: (l) => l.onOrder || "—" },
                  { header: "Reorder at / up to", align: "right", cell: (l) => `${l.reorderLevel} / ${l.maxLevel || l.reorderLevel}` },
                  ...(g.supplierId ? [] : [{
                    header: "Supplier",
                    cell: (l: SuggestedLine) => (
                      <span className="block w-44 shrink-0"><Select value={supplierFor[l.partId] ?? ""} onChange={(e) => setSupplierFor((s) => ({ ...s, [l.partId]: e.target.value }))} aria-label={`Supplier for ${l.partNo}`} className="h-8">
                        <option value="">Choose…</option>
                        {(suppliers.data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select></span>
                    ),
                  }]),
                  { header: "Order", align: "right", cell: (l) => <span className="inline-block w-24"><NumberInput value={qty[l.partId] ?? l.qty} onChange={(v) => setQty((q) => ({ ...q, [l.partId]: v }))} aria-label={`Quantity of ${l.partNo}`} className="h-8" /></span> },
                  ...(showCost ? [{ header: "Price", align: "right" as const, cell: (l: SuggestedLine) => formatAED(l.unitCostFils ?? 0) }] : []),
                ]}
              />
            </Card>
          ))}
          <div className="flex items-center justify-end gap-3">
            {missing > 0 && <span className="text-sm text-amber-700">Choose a supplier for {missing} part{missing === 1 ? "" : "s"}</span>}
            <Button variant="primary" icon={<ShoppingCart className="size-4" />} busy={busy} disabled={!chosen.length || missing > 0} onClick={() => void make()}>
              Make draft purchase orders
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Levels() {
  const { can } = useAuth();
  const { data, reload } = useApi<{ parts: LevelRow[] }>("/api/inventory/levels");
  const [edits, setEdits] = useState<Record<string, { reorderLevel: number; maxLevel: number }>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => setEdits({}), [data]);
  if (!data) return <Spinner />;
  const owner = can("settings.manage");
  const value = (r: LevelRow) => edits[r.partId] ?? { reorderLevel: r.reorderLevel, maxLevel: r.maxLevel };
  const set = (r: LevelRow, p: Partial<{ reorderLevel: number; maxLevel: number }>) => setEdits((e) => ({ ...e, [r.partId]: { ...value(r), ...p } }));
  const differs = (r: LevelRow) => r.suggestedMin !== r.reorderLevel || r.suggestedMax !== r.maxLevel;
  const useAll = () => setEdits(Object.fromEntries(data.parts.filter((r) => r.usage90 > 0 && differs(r)).map((r) => [r.partId, { reorderLevel: r.suggestedMin, maxLevel: r.suggestedMax }])));
  const save = async () => {
    setBusy(true);
    try {
      await post("/api/inventory/levels", { items: Object.entries(edits).map(([partId, v]) => ({ partId, ...v })) });
      toast.success("Levels saved");
      void reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-600">
        Suggested from the last 90 days: reorder at enough for the lead time plus two weeks; order up to a further 30 days.
      </p>
      <Card padded={false}>
        <Table
          rows={data.parts}
          rowKey={(r) => r.partId}
          empty={<Empty title="No stocked parts yet" />}
          columns={[
            { header: "Part", cell: (r) => <Link to={`/parts/${r.partId}`} className="hover:underline"><span className="font-mono">{r.partNo}</span> {r.name}</Link> },
            { header: "On hand", align: "right", cell: (r) => r.onHand },
            { header: "Used (90 days)", align: "right", cell: (r) => r.usage90 },
            { header: "Lead (days)", align: "right", cell: (r) => r.leadTimeDays },
            { header: "Suggested", align: "right", cell: (r) => (
              <span className={differs(r) && r.usage90 > 0 ? "font-medium text-brand-700" : "text-zinc-500"}>{r.suggestedMin} / {r.suggestedMax}</span>
            ) },
            { header: "Reorder at", align: "right", cell: (r) => (owner
              ? <span className="inline-block w-20"><NumberInput value={value(r).reorderLevel} onChange={(v) => set(r, { reorderLevel: v })} aria-label={`Reorder at for ${r.partNo}`} className="h-8" /></span>
              : r.reorderLevel) },
            { header: "Order up to", align: "right", cell: (r) => (owner
              ? <span className="inline-block w-20"><NumberInput value={value(r).maxLevel} onChange={(v) => set(r, { maxLevel: v })} aria-label={`Order up to for ${r.partNo}`} className="h-8" /></span>
              : r.maxLevel || "—") },
            ...(owner ? [{ header: "", cell: (r: LevelRow) => (r.usage90 > 0 && differs(r)
              ? <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => set(r, { reorderLevel: r.suggestedMin, maxLevel: r.suggestedMax })}>Use suggested</button>
              : edits[r.partId] ? <Badge tone="zinc">Changed</Badge> : null) }] : []),
          ]}
        />
      </Card>
      {owner && (
        <div className="flex justify-end gap-2">
          <Button icon={<Sparkles className="size-4" />} onClick={useAll}>Use all suggested</Button>
          <Button variant="primary" busy={busy} disabled={!Object.keys(edits).length} onClick={() => void save()}>Save levels</Button>
        </div>
      )}
    </div>
  );
}
