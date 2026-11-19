import { billTotals, dubaiDate, type BillVat } from "@ffgp/shared";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Table } from "../../components/ui";
import type { Account } from "../../books/types";
import { toFils } from "../../books/types";
import { post } from "../../lib/api";
import { formatAED, formatDate } from "../../lib/format";
import type { Supplier } from "../../lib/types";
import { useApi } from "../../lib/useApi";
import type { Bill } from "../../payables/types";

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);
/** Accounts a bill can be for: expenses, costs and assets that aren't kept by the app. */
export const billAccounts = (accounts: Account[]) =>
  accounts.filter((a) => a.active && !a.systemKey && !a.moneyKind && ["expense", "cost_of_sales", "asset"].includes(a.type));

/** Supplier bills for anything that isn't parts on a purchase order (rent, utilities, outside work, tools). */
export function BillsPage() {
  const navigate = useNavigate();
  const { data, reload } = useApi<{ bills: Bill[] }>("/api/bills");
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Bills" subtitle="Suppliers' bills for rent, utilities, outside work and other costs (parts bills come from Purchases)"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New bill</Button>} />
      <Card padded={false}>
        {!data ? <Spinner /> : (
          <Table rows={data.bills} rowKey={(b) => b.id} onRowClick={(b) => navigate(`/suppliers/${b.supplierId}`)}
            empty={<Empty title="No bills yet" />}
            columns={[
              { header: "Date", cell: (b) => day(b.billDate) },
              { header: "Supplier", cell: (b) => b.supplierName },
              { header: "Their invoice", cell: (b) => <span className="font-mono text-[13px]">{b.supplierInvoiceNo}</span> },
              { header: "Status", cell: (b) => (b.status === "cancelled" ? <Badge tone="red">Cancelled</Badge> : b.owedFils === 0 ? <Badge>Paid</Badge> : <Badge tone="brand">Owed {formatAED(b.owedFils)}</Badge>) },
              { header: "Total", cell: (b) => formatAED(b.grossFils), align: "right" },
            ]} />
        )}
      </Card>
      <BillEditor open={open} onClose={() => setOpen(false)} onSaved={() => void reload()} />
    </>
  );
}

interface Line { accountId: string; description: string; net: string; vat: BillVat }
const blank = (): Line => ({ accountId: "", description: "", net: "", vat: "standard" });

export function BillEditor({ open, onClose, onSaved, supplierId }: { open: boolean; onClose: () => void; onSaved: () => void; supplierId?: string }) {
  const suppliers = useApi<{ suppliers: Supplier[] }>(open ? "/api/suppliers" : null);
  const accounts = useApi<{ accounts: Account[] }>(open ? "/api/books/accounts" : null);
  const [v, setV] = useState({ supplierId: supplierId ?? "", invoiceNo: "", billDate: dubaiDate(new Date().toISOString()), dueDate: "" });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const totals = billTotals(lines.map((l) => ({ netFils: toFils(l.net), vat: l.vat })));

  const save = async () => {
    setBusy(true);
    try {
      await post("/api/bills", {
        supplierId: v.supplierId, supplierInvoiceNo: v.invoiceNo, billDate: v.billDate, dueDate: v.dueDate || null,
        lines: lines.filter((l) => l.accountId || l.description || l.net).map((l) => ({ accountId: l.accountId, description: l.description, netFils: toFils(l.net), vat: l.vat })),
      });
      toast.success("Bill saved");
      onSaved();
      onClose();
      setLines([blank()]);
      setV((x) => ({ ...x, invoiceNo: "", dueDate: "" }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New bill" width="max-w-3xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!v.supplierId || !v.invoiceNo || totals.grossFils <= 0} onClick={() => void save()}>Save bill</Button></>}>
      <div className="mb-4 grid grid-cols-4 gap-3">
        <Field label="Supplier" className="col-span-2">
          <Select value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} aria-label="Supplier">
            <option value="">Choose…</option>
            {suppliers.data?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Supplier's invoice number" className="col-span-2"><Input value={v.invoiceNo} onChange={(e) => setV({ ...v, invoiceNo: e.target.value })} aria-label="Supplier's invoice number" /></Field>
        <Field label="Bill date"><Input type="date" value={v.billDate} onChange={(e) => setV({ ...v, billDate: e.target.value })} aria-label="Bill date" /></Field>
        <Field label="Due date" hint="Blank: by the supplier's terms"><Input type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} aria-label="Due date" /></Field>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-zinc-500"><th className="pb-1">Account</th><th className="pb-1">Description</th><th className="w-28 pb-1 text-right">Net (AED)</th><th className="w-32 pb-1">VAT</th><th className="w-8" /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="py-1 pr-2">
                <Select value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })} aria-label={`Account, line ${i + 1}`}>
                  <option value="">Choose…</option>
                  {billAccounts(accounts.data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </Select>
              </td>
              <td className="py-1 pr-2"><Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label={`Description, line ${i + 1}`} /></td>
              <td className="py-1 pr-2"><Input inputMode="decimal" className="text-right" value={l.net} onChange={(e) => setLine(i, { net: e.target.value })} aria-label={`Net, line ${i + 1}`} /></td>
              <td className="py-1 pr-2">
                <Select value={l.vat} onChange={(e) => setLine(i, { vat: e.target.value as BillVat })} aria-label={`VAT, line ${i + 1}`}>
                  <option value="standard">5% VAT</option>
                  <option value="none">No VAT</option>
                </Select>
              </td>
              <td>{lines.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} className="text-zinc-400 hover:text-red-700" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between">
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setLines((ls) => [...ls, blank()])}>Add line</Button>
        <div className="text-right text-sm">
          <div className="text-zinc-600">Net {formatAED(totals.netFils)} · VAT {formatAED(totals.vatFils)}</div>
          <div className="font-semibold" data-testid="bill-total">{formatAED(totals.grossFils)}</div>
        </div>
      </div>
    </Modal>
  );
}
