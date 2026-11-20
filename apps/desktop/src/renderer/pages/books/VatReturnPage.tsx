import { EMIRATE_BOX, SYSTEM_ACCOUNTS, type Emirate } from "@ffgp/shared";
import { FileDown, FileSpreadsheet, Stamp } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner } from "../../components/ui";
import { exportPdf, exportXlsx } from "../../books/export";
import { vatSheet, type VatRow, type VatSheetFigures } from "../../books/vatSheet";
import type { JournalPrefill } from "./JournalEditor";
import { BackToBooks } from "./ReportPage";
import { post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

interface Period { from: string; to: string; status: "open" | "due" | "filed"; filedAt: string | null; reference: string | null; payableFils: number | null }
type Row = VatRow;
interface Figures extends VatSheetFigures {
  emirate: Emirate | null; countedFrom: string;
  notInBox: (VatRow & { account: "output" | "input" })[];
  advances: { customerId: string; name: string; creditFils: number; vatInsideFils: number }[];
}
interface VatReturn extends Figures { filed: { figures: Figures; reference: string | null; filedAt: string; entryId: string | null } | null; changedSinceFiled: boolean }

const STATUS: Record<Period["status"], string> = { open: "Open", due: "Due", filed: "Filed" };

/** The VAT201 return for a period, from the books: every box drills down to its entries; filing locks the period. */
export function VatReturnPage() {
  const navigate = useNavigate();
  const { garage, settings, can, refreshGarage } = useAuth();
  const periods = useApi<{ periods: Period[] }>("/api/vat/periods");
  const [chosen, setChosen] = useState<string>("");
  const list = periods.data?.periods ?? [];
  useEffect(() => {
    // The oldest due period: returns are filed in order (the list is newest first).
    if (!chosen && list.length) setChosen((list.filter((p) => p.status === "due").at(-1) ?? list[0]!).from);
  }, [list, chosen]);
  const period = list.find((p) => p.from === chosen);
  const ret = useApi<VatReturn>(period ? `/api/vat/return?from=${period.from}&to=${period.to}` : null);
  const [open, setOpen] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);

  const header = <PageHeader back={<BackToBooks />} title="VAT return" subtitle="The VAT201 figures for each period, from the books" />;
  if (!settings?.tax.firstPeriodStart) {
    return <>{header}<Card><p className="text-sm text-zinc-700">Set when the first VAT period starts in <Link to="/settings/tax" className="text-brand-700 underline">Settings → Tax</Link>.</p></Card></>;
  }
  if (!periods.data) return <>{header}<Spinner /></>;
  if (!period) return <>{header}<Card><p className="text-sm text-zinc-700">No VAT periods inside the books yet.</p></Card></>;

  const r = ret.data;
  const f: Figures | undefined = r?.filed ? r.filed.figures : (r ?? undefined);
  const refund = (f?.payableFils ?? 0) < 0;
  const sheet = () => vatSheet(f!, { filedAt: r?.filed?.filedAt ?? null, reference: r?.filed?.reference ?? null });
  const recordPayment = () => {
    const fils = Math.abs(f!.payableFils);
    const vat = { accountId: SYSTEM_ACCOUNTS.vat_payable.id, debitFils: refund ? 0 : fils, creditFils: refund ? fils : 0 };
    const bank = { accountId: SYSTEM_ACCOUNTS.bank.id, debitFils: refund ? fils : 0, creditFils: refund ? 0 : fils };
    const prefill: JournalPrefill = { date: today(), narration: `VAT ${refund ? "refund received" : "paid"} for ${day(period.from)} – ${day(period.to)}`, lines: [vat, bank] };
    navigate("/books/journals/new", { state: { prefill } });
  };

  return (
    <>
      {header}
      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Period">
            <Select value={chosen} onChange={(e) => { setChosen(e.target.value); setOpen(null); }} aria-label="Period">
              {list.map((p) => <option key={p.from} value={p.from}>{day(p.from)} – {day(p.to)} · {STATUS[p.status]}</option>)}
            </Select>
          </Field>
          <span data-testid="period-status" className="pb-2"><Badge tone={period.status === "filed" ? "zinc" : period.status === "due" ? "red" : "brand"}>{STATUS[period.status]}</Badge></span>
          <div className="ml-auto flex gap-2">
            <Button icon={<FileSpreadsheet className="size-4" />} disabled={!f} onClick={() => void exportXlsx(`VAT return ${period.from}`, sheet())}>Excel</Button>
            <Button icon={<FileDown className="size-4" />} disabled={!f} onClick={() => void exportPdf(garage?.name ?? "", sheet())}>Print</Button>
            {period.status === "due" && can("books.lock") && <Button variant="primary" icon={<Stamp className="size-4" />} onClick={() => setFiling(true)}>Mark as filed</Button>}
          </div>
        </div>
        {!settings.garage.emirate && (
          <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Choose the garage's emirate in <Link to="/settings/garage" className="underline">Settings → Garage</Link>: box 1 is split by emirate, and the return can't be filed without it.
          </p>
        )}
        {r?.filed && (
          <p className="mt-3 text-sm text-zinc-700">
            Filed {formatDate(r.filed.filedAt)}{r.filed.reference ? <> · reference <span className="font-mono">{r.filed.reference}</span></> : null}. These are the figures as filed.
            {r.changedSinceFiled && <span className="ml-1 text-amber-700">The books changed after filing: the period now shows {formatAED(r.payableFils)}.</span>}
          </p>
        )}
        {f && f.countedFrom > f.from && (
          <p className="mt-3 text-sm text-zinc-600">
            Counted from {day(f.countedFrom)}: the books start then. VAT from before that sits in the opening balances: move it to VAT payable with a
            journal between the VAT accounts (Output VAT, Input VAT, VAT payable).
          </p>
        )}
      </Card>

      {!f ? <Spinner /> : (
        <Card padded={false} title="VAT201">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-500">
              <th className="px-4 py-2 w-14">Box</th><th className="py-2">Description</th><th className="py-2 pr-4 text-right">Amount</th><th className="py-2 pr-4 text-right">VAT</th><th className="py-2 pr-4 text-right">Adjustment</th>
            </tr></thead>
            <tbody>
              {f.boxes.map((b) => {
                const total = b.key === "8" || b.key === "11";
                const mine = !!f.emirate && EMIRATE_BOX[f.emirate] === b.key;
                return (
                  <Fragment key={b.key}>
                    <tr data-testid={`box-${b.key}`} onClick={() => b.rows.length && setOpen(open === b.key ? null : b.key)}
                      className={`border-b border-zinc-100 ${b.rows.length ? "cursor-pointer hover:bg-brand-50/60" : ""} ${total || mine ? "font-semibold" : ""}`}>
                      <td className="px-4 py-2 font-mono text-[13px]">{b.key}</td>
                      <td className="py-2">{b.label}{b.rows.length ? <span className="ml-2 text-xs text-zinc-500">{b.rows.length} entr{b.rows.length === 1 ? "y" : "ies"}</span> : null}</td>
                      <td className="py-2 pr-4 text-right tabular" data-testid={`box-${b.key}-amount`}>{formatAED(b.amountFils)}</td>
                      <td className="py-2 pr-4 text-right tabular" data-testid={`box-${b.key}-vat`}>{formatAED(b.vatFils)}</td>
                      <td className="py-2 pr-4 text-right tabular" data-testid={`box-${b.key}-adjustment`}>{formatAED(b.adjustmentFils)}</td>
                    </tr>
                    {open === b.key && (
                      <tr><td colSpan={5} className="bg-zinc-50 px-4 py-2" data-testid="box-rows">
                        <table className="w-full text-[13px]"><tbody>
                          {b.rows.map((x) => (
                            <tr key={x.entryId}>
                              <td className="w-28 py-1">{day(x.date)}</td>
                              <td className="w-28 py-1"><Link to={`/books/journals/${x.entryId}`} className="font-mono text-brand-700 hover:underline">{x.number}</Link></td>
                              <td className="py-1">{x.narration}{x.originalDate && <span className="ml-2 text-xs text-amber-700">dated {day(x.originalDate)}, posted late</span>}</td>
                              <td className="py-1 pr-4 text-right tabular">{formatAED(x.amountFils)}</td>
                              <td className="py-1 pr-4 text-right tabular">{formatAED(x.vatFils + x.adjustmentFils)}</td>
                            </tr>
                          ))}
                        </tbody></table>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              <tr className="border-b border-zinc-100"><td className="px-4 py-2 font-mono text-[13px]">12</td><td className="py-2">Total value of due tax for the period</td><td /><td className="py-2 pr-4 text-right tabular">{formatAED(f.dueFils)}</td><td /></tr>
              <tr className="border-b border-zinc-100"><td className="px-4 py-2 font-mono text-[13px]">13</td><td className="py-2">Total value of recoverable tax for the period</td><td /><td className="py-2 pr-4 text-right tabular">{formatAED(f.recoverableFils)}</td><td /></tr>
              <tr className="font-semibold" data-testid="box-14">
                <td className="px-4 py-2 font-mono text-[13px]">14</td>
                <td className="py-2">{refund ? "Refundable" : "Payable"} tax for the period</td><td />
                <td className="py-2 pr-4 text-right tabular">{formatAED(Math.abs(f.payableFils))}</td><td />
              </tr>
            </tbody>
          </table>
          {period.status === "filed" && f.payableFils !== 0 && can("books.post") && (
            <div className="border-t border-zinc-200 px-4 py-3">
              <Button onClick={recordPayment}>{refund ? "Record the refund" : "Record the payment"}</Button>
              <span className="ml-3 text-xs text-zinc-500">A journal from VAT payable {refund ? "into" : "out of"} the bank, to check and post.</span>
            </div>
          )}
        </Card>
      )}

      {f && f.notInBox.length > 0 && (
        <Card title="VAT not in any box" className="mt-5" padded={false}>
          <p className="px-4 pt-3 text-xs text-zinc-600">These entries move Output or Input VAT but no box counts them. Tag the journal's VAT line with its box, or correct it.</p>
          <RowsTable rows={f.notInBox} />
        </Card>
      )}
      {f && f.advances.length > 0 && (
        <Card title={`Customer advances unused at ${day(f.to)}`} className="mt-5" padded={false}>
          <p className="px-4 pt-3 text-xs text-zinc-600">Money received before an invoice. If VAT is due on an advance, post it by a journal tagged with box 1.</p>
          <table className="w-full text-sm"><tbody>
            {f.advances.map((a) => (
              <tr key={a.customerId} className="border-b border-zinc-100">
                <td className="px-4 py-2"><Link to={`/customers/${a.customerId}`} className="text-brand-700 hover:underline">{a.name}</Link></td>
                <td className="py-2 pr-4 text-right tabular">{formatAED(a.creditFils)}</td>
                <td className="py-2 pr-4 text-right text-zinc-600">VAT inside {formatAED(a.vatInsideFils)}</td>
              </tr>
            ))}
          </tbody></table>
        </Card>
      )}

      <FileModal open={filing} period={period} onClose={() => setFiling(false)}
        onFiled={() => { setFiling(false); void periods.reload(); void ret.reload(); void refreshGarage(); }} />
    </>
  );
}

function RowsTable({ rows }: { rows: (Row & { account: "output" | "input" })[] }) {
  return (
    <table className="w-full text-sm"><tbody>
      {rows.map((x) => (
        <tr key={`${x.entryId}:${x.account}`} className="border-b border-zinc-100">
          <td className="w-32 px-4 py-2">{day(x.date)}</td>
          <td className="w-28 py-2"><Link to={`/books/journals/${x.entryId}`} className="font-mono text-[13px] text-brand-700 hover:underline">{x.number}</Link></td>
          <td className="py-2">{x.narration}{x.originalDate && <span className="ml-2 text-xs text-amber-700">dated {day(x.originalDate)}</span>}</td>
          <td className="py-2 text-zinc-600">{x.account === "output" ? "Output VAT" : "Input VAT"}</td>
          <td className="py-2 pr-4 text-right tabular">{formatAED(x.vatFils)}</td>
        </tr>
      ))}
    </tbody></table>
  );
}

function FileModal({ open, period, onClose, onFiled }: { open: boolean; period: Period; onClose: () => void; onFiled: () => void }) {
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await post("/api/vat/returns", { from: period.from, to: period.to, reference: reference || null });
      toast.success("Return filed");
      setReference("");
      onFiled();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={`File the return for ${day(period.from)} – ${day(period.to)}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Not yet</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>File return</Button></>}>
      <p className="mb-3 text-sm text-zinc-700">This locks the books up to {day(period.to)} and posts the settlement into VAT payable. File it on the FTA's portal too: this only records it here.</p>
      <Field label="FTA reference (optional)"><Input value={reference} onChange={(e) => setReference(e.target.value)} aria-label="FTA reference (optional)" /></Field>
    </Modal>
  );
}
