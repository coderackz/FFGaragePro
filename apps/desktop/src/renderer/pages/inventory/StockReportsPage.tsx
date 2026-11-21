import { STOCK_AGE_BUCKETS } from "@ffgp/shared";
import { useState } from "react";
import { Link } from "react-router";
import { Segmented } from "../../components/Segmented";
import { Badge, Card, Empty, PageHeader, Select, Spinner, Table } from "../../components/ui";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";

type View = "abc" | "movers" | "dead" | "valuation" | "aging";
const partCell = (r: { partId: string; partNo: string; name: string }) => <Link to={`/parts/${r.partId}`} className="hover:underline"><span className="font-mono">{r.partNo}</span> {r.name}</Link>;
const Total = ({ label, fils }: { label: string; fils: number }) => (
  <div className="flex justify-end gap-6 border-t border-zinc-100 px-4 py-2.5 text-sm"><span className="text-zinc-500">{label}</span><span className="font-semibold tabular" data-testid="report-total">{formatAED(fils)}</span></div>
);

/** Reports → Stock: ABC, fast and slow movers, dead stock, valuation by category, aging by last receipt. */
export function StockReportsPage() {
  const [view, setView] = useState<View>("abc");
  return (
    <>
      <PageHeader title="Stock reports" subtitle="Which parts matter, which don't move, and what the shelf is worth" actions={
        <Segmented label="Stock report" value={view} onChange={setView}
          options={[["abc", "ABC"], ["movers", "Movers"], ["dead", "Dead stock"], ["valuation", "Valuation"], ["aging", "Aging"]] as const} />
      } />
      {view === "abc" && <Abc />}
      {view === "movers" && <Movers />}
      {view === "dead" && <Dead />}
      {view === "valuation" && <Valuation />}
      {view === "aging" && <Aging />}
    </>
  );
}

function Abc() {
  const { data } = useApi<{ totalFils: number; parts: { partId: string; partNo: string; name: string; usageQty: number; usageValueFils: number; sharePct: number; abc: "A" | "B" | "C" }[] }>("/api/reports/inventory/abc?months=12");
  if (!data) return <Spinner />;
  const count = (c: string) => data.parts.filter((p) => p.abc === c).length;
  return (
    <>
      <p className="mb-3 text-sm text-zinc-600">By what each part was used for in the last 12 months: A parts make up the first 80 % of it ({count("A")}), B the next 15 % ({count("B")}), C the rest ({count("C")}).</p>
      <Card padded={false}>
        <Table rows={data.parts} rowKey={(r) => r.partId} empty={<Empty title="No stocked parts yet" />} columns={[
          { header: "Class", cell: (r) => <Badge tone={r.abc === "A" ? "brand" : "zinc"}>{r.abc}</Badge> },
          { header: "Part", cell: partCell },
          { header: "Used", align: "right", cell: (r) => r.usageQty },
          { header: "Used for", align: "right", cell: (r) => formatAED(r.usageValueFils) },
          { header: "Share", align: "right", cell: (r) => `${r.sharePct} %` },
        ]} />
        <Total label="Used in 12 months" fils={data.totalFils} />
      </Card>
    </>
  );
}

function Movers() {
  const [days, setDays] = useState("90");
  const { data } = useApi<{ parts: { partId: string; partNo: string; name: string; unit: string; onHand: number; usageQty: number; daysOfStock: number | null }[] }>(`/api/reports/inventory/movers?days=${days}`);
  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-sm text-zinc-600">
        Used in the last
        <span className="block w-32 shrink-0"><Select value={days} onChange={(e) => setDays(e.target.value)}  aria-label="Period">
          {["30", "90", "180", "365"].map((d) => <option key={d} value={d}>{d} days</option>)}
        </Select></span>
        — fastest first; the slowest (and unused) at the bottom.
      </div>
      {!data ? <Spinner /> : (
        <Card padded={false}>
          <Table rows={data.parts} rowKey={(r) => r.partId} empty={<Empty title="No stocked parts yet" />} columns={[
            { header: "Part", cell: partCell },
            { header: "Used", align: "right", cell: (r) => (r.usageQty ? `${r.usageQty} ${r.unit === "each" ? "" : r.unit}` : <span className="text-zinc-400">none</span>) },
            { header: "On hand", align: "right", cell: (r) => r.onHand },
            { header: "Lasts about", align: "right", cell: (r) => (r.daysOfStock === null ? "—" : `${r.daysOfStock} days`) },
          ]} />
        </Card>
      )}
    </>
  );
}

function Dead() {
  const [months, setMonths] = useState("6");
  const { data } = useApi<{ totalFils: number; parts: { partId: string; partNo: string; name: string; onHand: number; lastUsed: string | null; valueFils: number }[] }>(`/api/reports/inventory/dead?months=${months}`);
  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-sm text-zinc-600">
        Parts with stock not used on any job for
        <span className="block w-32 shrink-0"><Select value={months} onChange={(e) => setMonths(e.target.value)}  aria-label="Not used for">
          <option value="6">6 months</option>
          <option value="12">12 months</option>
        </Select></span>
      </div>
      {!data ? <Spinner /> : (
        <Card padded={false}>
          <Table rows={data.parts} rowKey={(r) => r.partId} empty={<Empty title="No dead stock" />} columns={[
            { header: "Part", cell: partCell },
            { header: "On hand", align: "right", cell: (r) => r.onHand },
            { header: "Last used", cell: (r) => (r.lastUsed ? formatDate(r.lastUsed) : "Never") },
            { header: "Value", align: "right", cell: (r) => formatAED(r.valueFils) },
          ]} />
          <Total label="Dead stock" fils={data.totalFils} />
        </Card>
      )}
    </>
  );
}

function Valuation() {
  const { data } = useApi<{ totalFils: number; categories: { categoryId: string | null; name: string; parts: number; qty: number; valueFils: number }[] }>("/api/reports/inventory/valuation");
  if (!data) return <Spinner />;
  return (
    <Card padded={false}>
      <Table rows={data.categories} rowKey={(r) => r.categoryId ?? "none"} empty={<Empty title="Nothing on the shelf" />} columns={[
        { header: "Category", cell: (r) => r.name },
        { header: "Parts", align: "right", cell: (r) => r.parts },
        { header: "Quantity", align: "right", cell: (r) => r.qty },
        { header: "Value at average cost", align: "right", cell: (r) => formatAED(r.valueFils) },
      ]} />
      <Total label="Stock value" fils={data.totalFils} />
    </Card>
  );
}

function Aging() {
  const { data } = useApi<{ buckets: Record<string, number>; parts: { partId: string; partNo: string; name: string; onHand: number; lastReceived: string | null; days: number | null; bucket: string; valueFils: number }[] }>("/api/reports/inventory/aging");
  if (!data) return <Spinner />;
  return (
    <>
      <div className="mb-3 grid grid-cols-4 gap-3">
        {STOCK_AGE_BUCKETS.map((b) => (
          <Card key={b}><div className="text-xs text-zinc-500 uppercase">{b === "Over 365" ? "Over a year" : `${b} days`}</div><div className="mt-1 text-lg font-semibold tabular">{formatAED(data.buckets[b] ?? 0)}</div></Card>
        ))}
      </div>
      <Card padded={false}>
        <Table rows={data.parts} rowKey={(r) => r.partId} empty={<Empty title="Nothing on the shelf" />} columns={[
          { header: "Part", cell: partCell },
          { header: "Last received", cell: (r) => (r.lastReceived ? formatDate(r.lastReceived) : "Never") },
          { header: "Days", align: "right", cell: (r) => r.days ?? "—" },
          { header: "On hand", align: "right", cell: (r) => r.onHand },
          { header: "Value", align: "right", cell: (r) => formatAED(r.valueFils) },
        ]} />
      </Card>
    </>
  );
}
