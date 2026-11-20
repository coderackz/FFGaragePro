import { ASSET_CATEGORIES, ASSET_CATEGORY_LABELS, type AssetCategory } from "@ffgp/shared";
import { Plus, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Empty, Field, Input, Modal, MoneyInput, PageHeader, Select, Table } from "../../components/ui";
import type { Account } from "../../books/types";
import { patch, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import { BackToBooks } from "./ReportPage";

export interface Asset {
  id: string; name: string; category: AssetCategory; accountId: string; costFils: number; inUseFrom: string; lifeMonths: number; residualFils: number;
  openingDepreciationFils: number; serial: string | null; note: string | null; disposedOn: string | null; proceedsFils: number | null;
  proceedsAccountId: string | null; disposalNote: string | null; postedFils: number; bookValueFils: number; monthlyFils: number; gainFils: number | null;
}
export const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);
export const POLICY = "Straight line, a full month from the month it goes into use; posted when each month ends.";

/** The fixed asset register: what the garage owns, what it cost, how far it's depreciated. */
export function AssetsPage() {
  const navigate = useNavigate();
  const { canSee } = useAuth();
  const [disposed, setDisposed] = useState(false);
  const { data, loading, reload } = useApi<{ assets: Asset[] }>(`/api/assets${disposed ? "?includeDisposed=1" : ""}`);
  const [adding, setAdding] = useState(false);
  const rows = data?.assets ?? [];
  const sum = (f: (a: Asset) => number) => rows.filter((a) => !a.disposedOn).reduce((s, a) => s + f(a), 0);
  return (
    <>
      <PageHeader back={<BackToBooks />} title="Fixed assets" subtitle={POLICY}
        actions={<>
          <Button variant="ghost" onClick={() => setDisposed((v) => !v)}>{disposed ? "Hide sold and written off" : "Show sold and written off"}</Button>
          {canSee("books.post") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>New asset</Button>}
        </>} />
      <Card padded={false}>
        <Table rows={rows} rowKey={(a) => a.id} onRowClick={(a) => navigate(`/books/assets/${a.id}`)}
          empty={!loading && <Empty icon={<Wrench className="size-10" />} title="No fixed assets yet">Add tools, equipment, vehicles and fit-out the garage owns.</Empty>}
          columns={[
            { header: "Asset", cell: (a) => <span className="font-medium">{a.name}{a.disposedOn && <span className="ml-2"><Badge>{a.proceedsFils ? "Sold" : "Written off"} {day(a.disposedOn)}</Badge></span>}</span> },
            { header: "Category", cell: (a) => ASSET_CATEGORY_LABELS[a.category] },
            { header: "In use from", cell: (a) => day(a.inUseFrom) },
            { header: "Cost", cell: (a) => formatAED(a.costFils), align: "right" },
            { header: "Depreciated", cell: (a) => formatAED(a.postedFils), align: "right" },
            { header: "Book value", cell: (a) => (a.disposedOn ? "—" : formatAED(a.bookValueFils)), align: "right" },
            { header: "Monthly", cell: (a) => formatAED(a.monthlyFils), align: "right" },
          ]} />
        {rows.length > 0 && (
          <div className="flex justify-end gap-8 border-t border-zinc-200 px-4 py-2 text-sm font-semibold">
            <span>Cost {formatAED(sum((a) => a.costFils))}</span><span>Depreciated {formatAED(sum((a) => a.postedFils))}</span><span>Book value {formatAED(sum((a) => a.bookValueFils))}</span>
          </div>
        )}
      </Card>
      <AssetForm open={adding} asset={null} onClose={() => setAdding(false)} onSaved={() => void reload()} />
    </>
  );
}

type Draft = Pick<Asset, "name" | "category" | "accountId" | "costFils" | "inUseFrom" | "lifeMonths" | "residualFils" | "openingDepreciationFils" | "serial" | "note">;
const blank = (): Draft => ({ name: "", category: "equipment", accountId: "", costFils: 0, inUseFrom: new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10), lifeMonths: 60, residualFils: 0, openingDepreciationFils: 0, serial: null, note: null });

/** New or edit asset. Depreciation brought forward shows for an asset in use before the books started. */
export function AssetForm({ open, asset, onClose, onSaved }: { open: boolean; asset: Asset | null; onClose: () => void; onSaved: () => void }) {
  const { settings } = useAuth();
  const accounts = useApi<{ accounts: Account[] }>(open ? "/api/books/accounts" : null);
  const usable = (accounts.data?.accounts ?? []).filter((a) => a.type === "asset" && a.active && !a.systemKey && !a.moneyKind);
  const [d, setD] = useState<Draft>(blank());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setD(asset ? { ...asset } : blank()); }, [open, asset]);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const start = settings?.books.startDate ?? null;
  const beforeBooks = !!start && d.inUseFrom < start;
  const account = d.accountId || usable.find((a) => a.code === "1500")?.id || usable[0]?.id || "";
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...d, accountId: account, openingDepreciationFils: beforeBooks ? d.openingDepreciationFils : 0 };
      if (asset) await patch(`/api/assets/${asset.id}`, body); else await post("/api/assets", body);
      toast.success(asset ? "Asset saved" : "Asset added");
      onClose(); onSaved();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={asset ? `Edit ${asset.name}` : "New asset"} onClose={onClose} width="max-w-2xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save asset</Button></>}>
      <p className="mb-4 text-xs text-zinc-600">Its cost reaches the books through the bill or journal that paid for it (on the account below): the register depreciates it.</p>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Name"><Input value={d.name} onChange={(e) => set({ name: e.target.value })} aria-label="Name" /></Field>
        <Field label="Category">
          <Select value={d.category} onChange={(e) => set({ category: e.target.value as AssetCategory })} aria-label="Category">
            {ASSET_CATEGORIES.map((c) => <option key={c} value={c}>{ASSET_CATEGORY_LABELS[c]}</option>)}
          </Select>
        </Field>
        <Field label="Account"><Select value={account} onChange={(e) => set({ accountId: e.target.value })} aria-label="Account">{usable.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select></Field>
        <Field label="Cost"><MoneyInput fils={d.costFils} onChange={(v) => set({ costFils: v })} aria-label="Cost" /></Field>
        <Field label="In use from"><Input type="date" value={d.inUseFrom} onChange={(e) => set({ inUseFrom: e.target.value })} aria-label="In use from" /></Field>
        <Field label="Life (months)"><Input inputMode="numeric" value={String(d.lifeMonths)} onChange={(e) => set({ lifeMonths: Number(e.target.value) || 0 })} aria-label="Life (months)" /></Field>
        <Field label="Residual value" hint="What it's expected to be worth at the end"><MoneyInput fils={d.residualFils} onChange={(v) => set({ residualFils: v })} aria-label="Residual value" /></Field>
        {beforeBooks && (
          <Field label="Depreciation before the books" hint="Already taken before the books started (in your opening balances)">
            <MoneyInput fils={d.openingDepreciationFils} onChange={(v) => set({ openingDepreciationFils: v })} aria-label="Depreciation before the books" />
          </Field>
        )}
        <Field label="Serial number"><Input value={d.serial ?? ""} onChange={(e) => set({ serial: e.target.value || null })} aria-label="Serial number" /></Field>
        <Field label="Note"><Input value={d.note ?? ""} onChange={(e) => set({ note: e.target.value || null })} aria-label="Note" /></Field>
      </div>
    </Modal>
  );
}
