import { ASSET_CATEGORY_LABELS } from "@ffgp/shared";
import { ArrowLeft, Pencil } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner } from "../../components/ui";
import { post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatAED } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import type { MoneyAccount } from "../../payables/types";
import { AssetForm, day, POLICY, type Asset } from "./AssetsPage";

interface AssetFull extends Asset { schedule: { month: string; chargeFils: number; totalFils: number; posted: boolean }[] }
const monthName = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

/** One asset: details, its depreciation month by month, and selling or writing it off. */
export function AssetPage() {
  const { id } = useParams();
  const { canSee } = useAuth();
  const { data, reload } = useApi<{ asset: AssetFull }>(`/api/assets/${id}`);
  const [editing, setEditing] = useState(false);
  const [selling, setSelling] = useState(false);
  if (!data) return <Spinner />;
  const a = data.asset;
  const can = canSee("books.post") && !a.disposedOn;
  return (
    <>
      <PageHeader back={<Link to="/books/assets" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Fixed assets</Link>}
        title={a.name} subtitle={`${ASSET_CATEGORY_LABELS[a.category]} · in use from ${day(a.inUseFrom)} · ${a.lifeMonths} months${a.serial ? ` · ${a.serial}` : ""}`}
        actions={can && <>
          <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
          <Button onClick={() => setSelling(true)}>Sell or write off</Button>
        </>} />
      <div className="mb-5 grid grid-cols-4 gap-4 max-md:grid-cols-2">
        {[["Cost", a.costFils], ["Depreciated", a.postedFils], ["Book value", a.bookValueFils], ["Monthly", a.monthlyFils]].map(([l, v]) => (
          <Card key={l as string}><div className="text-xs text-zinc-500">{l}</div><div className="text-lg font-semibold tabular">{formatAED(v as number)}</div></Card>
        ))}
      </div>
      {a.disposedOn && (
        <Card className="mb-5">
          <p className="text-sm">{a.proceedsFils ? `Sold for ${formatAED(a.proceedsFils)}` : "Written off"} on {day(a.disposedOn)}{a.disposalNote ? ` · ${a.disposalNote}` : ""}.{" "}
            <span data-testid="disposal-gain" className={a.gainFils! >= 0 ? "font-medium text-emerald-700" : "font-medium text-red-700"}>{a.gainFils! >= 0 ? "Gain" : "Loss"} {formatAED(Math.abs(a.gainFils!))}</span>
          </p>
        </Card>
      )}
      <Card title="Depreciation" padded={false}>
        <p className="px-4 pt-3 text-xs text-zinc-600">{POLICY}{a.openingDepreciationFils ? ` ${formatAED(a.openingDepreciationFils)} was taken before the books started.` : ""}</p>
        <table className="w-full text-sm"><tbody>
          {a.schedule.map((m) => (
            <tr key={m.month} data-testid="schedule-row" className="border-b border-zinc-100">
              <td className="px-4 py-1.5">{monthName(m.month)}</td>
              <td className="py-1.5 text-right tabular">{formatAED(m.chargeFils)}</td>
              <td className="py-1.5 text-right tabular text-zinc-600">{formatAED(m.totalFils)}</td>
              <td className="px-4 py-1.5 text-right">{m.posted ? <Badge>Posted</Badge> : <span className="text-xs text-zinc-500">Coming</span>}</td>
            </tr>
          ))}
        </tbody></table>
      </Card>
      <AssetForm open={editing} asset={a} onClose={() => setEditing(false)} onSaved={() => void reload()} />
      <SellModal open={selling} asset={a} onClose={() => setSelling(false)} onDone={() => void reload()} />
    </>
  );
}

function SellModal({ open, asset, onClose, onDone }: { open: boolean; asset: Asset; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<{ accounts: MoneyAccount[] }>(open ? "/api/money-accounts" : null);
  const usable = (accounts.data?.accounts ?? []).filter((x) => x.moneyKind === "cash" || x.moneyKind === "bank");
  const [date, setDate] = useState(new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10));
  const [proceeds, setProceeds] = useState(0);
  const [into, setInto] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const account = into || usable[0]?.id || "";
  const save = async () => {
    setBusy(true);
    try {
      await post(`/api/assets/${asset.id}/dispose`, { date, proceedsFils: proceeds, proceedsAccountId: proceeds ? account : null, note: note || null });
      toast.success(proceeds ? "Sale recorded" : "Written off");
      onClose(); onDone();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={`Sell or write off: ${asset.name}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>{proceeds ? "Record sale" : "Write off"}</Button></>}>
      <p className="mb-3 text-xs text-zinc-600">Depreciation runs through the month of the sale; then its cost and depreciation leave the books, with the gain or loss. Proceeds 0 writes it off.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" /></Field>
        <Field label="Proceeds"><MoneyInput fils={proceeds} onChange={setProceeds} aria-label="Proceeds" /></Field>
        {proceeds > 0 && <Field label="Into"><Select value={account} onChange={(e) => setInto(e.target.value)} aria-label="Into">{usable.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</Select></Field>}
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" /></Field>
      </div>
    </Modal>
  );
}
