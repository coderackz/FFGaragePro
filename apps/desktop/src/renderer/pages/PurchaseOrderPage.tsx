import { ArrowLeft, Ban, FileDown, PackageCheck, Plus, Printer, Save, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { FLEETFIX_SUPPLIER_ID, roundFils } from "@ffgp/shared";
import { PartLink, PartPicker } from "../components/PartPicker";
import { ReceiveDialog } from "../components/ReceiveDialog";
import { Button, Card, Empty, Field, MoneyInput, NumberInput, PageHeader, Select, Spinner, StatusBadge, Table, Textarea } from "../components/ui";
import { get, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatAED, formatDate, formatDateTime } from "../lib/format";
import type { DocLine, PoLine, PurchaseOrder, Supplier } from "../lib/types";
import { useApi } from "../lib/useApi";
import { printPurchaseOrder } from "../print/print";

const blankLine = (): PoLine => ({ partId: null, description: "", qty: 1, unitCostFils: 0, jobDocumentId: null });

export function PurchaseOrderPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { can, garage } = useAuth();
  const poQuery = useApi<{ purchaseOrder: PurchaseOrder }>(isNew ? null : `/api/purchase-orders/${id}`);
  const po = poQuery.data?.purchaseOrder ?? null;
  const suppliers = useApi<{ suppliers: Supplier[] }>(isNew ? "/api/suppliers" : null);
  const [supplierId, setSupplierId] = useState(FLEETFIX_SUPPLIER_ID);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<PoLine[]>([blankLine()]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const manage = can("purchases.manage");
  const showCost = can("costs.view");
  const editable = manage && (isNew || (po?.editable ?? false));

  useEffect(() => {
    if (po) {
      setNotes(po.notes ?? "");
      setLines(po.lines.length ? po.lines : po.editable ? [blankLine()] : []);
      setDirty(false);
    }
  }, [po]);

  const change = (i: number, p: Partial<PoLine>) => { setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l))); setDirty(true); };
  const clean = () => lines.filter((l) => l.description.trim() !== "");
  const net = clean().reduce((s, l) => s + roundFils(l.qty * (l.unitCostFils ?? 0)), 0);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try { await fn(); } catch (error) { toast.error((error as Error).message); } finally { setBusy(null); }
  };

  /** Saves and returns the PO id (creating it if new). */
  const save = async (): Promise<string> => {
    const body = {
      notes,
      lines: clean().map((l) => ({ id: l.id, partId: l.partId, description: l.description.trim(), qty: l.qty, unitCostFils: l.unitCostFils ?? 0, jobDocumentId: l.jobDocumentId })),
    };
    if (isNew) {
      const res = await post<{ purchaseOrder: PurchaseOrder }>("/api/purchase-orders", { supplierId, ...body, lines: body.lines.map(({ id: _, ...l }) => l) });
      setDirty(false);
      navigate(`/purchase-orders/${res.purchaseOrder.id}`, { replace: true });
      return res.purchaseOrder.id;
    }
    if (dirty && editable) poQuery.setData(await patch<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${po!.id}`, body));
    setDirty(false);
    return po!.id;
  };

  const setStatus = (status: "sent" | "cancelled") => run(status, async () => {
    if (status === "cancelled" && !window.confirm(`Cancel ${po!.number}? Job cards waiting on it can request the parts again.`)) return;
    const poId = await save();
    poQuery.setData(await patch<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${poId}`, { status }));
    toast.success(status === "sent" ? "Marked as sent" : "Purchase order cancelled");
  });

  const onPrint = (mode: "pdf" | "print") => run(mode, async () => {
    const poId = dirty ? await save() : po?.id;
    if (!poId || !garage) return;
    const { purchaseOrder } = await get<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${poId}`);
    poQuery.setData({ purchaseOrder });
    await printPurchaseOrder(purchaseOrder, garage, mode);
  });

  if (!isNew && poQuery.error) return <Empty title="Purchase order not found">{poQuery.error}</Empty>;
  if (!isNew && !po) return <Spinner />;
  const canReceive = manage && po && ["draft", "sent", "part_received"].includes(po.status) && po.lines.length > 0;
  const nothingReceived = po?.lines.every((l) => (l.receivedQty ?? 0) === 0);

  return (
    <>
      <PageHeader
        back={<Link to="/purchase-orders" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Purchase orders</Link>}
        title={<span className="flex items-center gap-3">{po ? <span className="font-mono">{po.number}</span> : "New purchase order"}{po && <StatusBadge status={po.status} />}{dirty && <span className="text-sm font-normal text-amber-700">Unsaved changes</span>}</span>}
        subtitle={po && `${po.supplier.name} · created ${formatDateTime(po.createdAt)}${po.createdBy ? ` by ${po.createdBy}` : ""}`}
        actions={
          <>
            {po && <Button icon={<Printer className="size-4" />} busy={busy === "print"} onClick={() => onPrint("print")}>Print</Button>}
            {po && <Button icon={<FileDown className="size-4" />} busy={busy === "pdf"} onClick={() => onPrint("pdf")}>PDF</Button>}
            {po && manage && nothingReceived && po.status !== "cancelled" && <Button variant="danger" icon={<Ban className="size-4" />} busy={busy === "cancelled"} onClick={() => setStatus("cancelled")}>Cancel order</Button>}
            {editable && <Button icon={<Save className="size-4" />} busy={busy === "save"} onClick={() => run("save", async () => { await save(); toast.success("Saved"); })}>Save</Button>}
            {po?.status === "draft" && manage && <Button icon={<Send className="size-4" />} busy={busy === "sent"} onClick={() => setStatus("sent")}>Mark as sent</Button>}
            {canReceive && <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => run("receive", async () => { await save(); setReceiving(true); })}>Receive delivery</Button>}
          </>
        }
      />
      <div className="flex flex-col gap-5">
        {isNew && (
          <Card title="Supplier">
            <Field label="Supplier" className="max-w-sm">
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                {(suppliers.data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </Card>
        )}
        <Card title="Items" padded={false} actions={editable && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => { setLines((ls) => [...ls, blankLine()]); setDirty(true); }}>Line</Button>}>
          {lines.length === 0 ? <Empty title="No items" /> : (
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50/80 text-left text-xs font-medium tracking-wide text-zinc-500 uppercase">
                  <th className="px-4 py-2 font-medium">Part</th>
                  <th className="w-28 px-2 py-2 font-medium">For job</th>
                  <th className="w-24 px-2 py-2 text-right font-medium">{editable ? "Qty" : "Received"}</th>
                  {showCost && <th className="w-28 px-2 py-2 text-right font-medium">Cost each</th>}
                  {showCost && <th className="w-32 px-4 py-2 text-right font-medium">Amount</th>}
                  {editable && <th className="w-10" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {lines.map((l, i) => {
                  const asDocLine: DocLine = { kind: "part", description: l.description, qty: l.qty, unitPriceFils: 0, discountPct: 0, partId: l.partId, partNo: l.partNo, partStocked: l.stocked };
                  return (
                    <tr key={l.id ?? `new-${i}`} className="align-top">
                      <td className="px-4 py-1.5">
                        {editable ? (
                          <PartPicker line={asDocLine}
                            onChange={(p) => change(i, { description: p.description ?? l.description, ...(p.partId !== undefined ? { partId: p.partId, partNo: p.partNo, stocked: p.partStocked } : {}) })}
                            onPick={(part) => !l.unitCostFils && part.avgCostFils && change(i, { unitCostFils: part.avgCostFils })} />
                        ) : <div className="py-1">{l.description}</div>}
                        {l.partId && <div className="mt-1"><PartLink line={asDocLine} editable={editable} onUnlink={() => change(i, { partId: null, partNo: null, stocked: null })} /></div>}
                      </td>
                      <td className="px-2 py-2.5">{l.jobDocumentId ? <Link className="font-mono text-[13px] text-brand-700 hover:underline" to={`/documents/${l.jobDocumentId}`}>{l.jobDocumentNumber}</Link> : <span className="text-zinc-400">—</span>}</td>
                      <td className="px-2 py-1.5 text-right tabular">
                        {editable ? <NumberInput value={l.qty} onChange={(qty) => change(i, { qty })} className="h-8" aria-label="Order quantity" /> : <div className="py-1">{l.receivedQty ?? 0} / {l.qty}</div>}
                      </td>
                      {showCost && <td className="px-2 py-1.5 text-right tabular">{editable ? <MoneyInput fils={l.unitCostFils ?? 0} onChange={(unitCostFils) => change(i, { unitCostFils })} className="h-8" aria-label="Unit cost" /> : <div className="py-1">{formatAED(l.unitCostFils ?? 0)}</div>}</td>}
                      {showCost && <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap tabular">{formatAED(roundFils(l.qty * (l.unitCostFils ?? 0)))}</td>}
                      {editable && (
                        <td className="pt-1.5 pr-2">
                          <button type="button" onClick={() => { setLines((ls) => ls.filter((_, j) => j !== i)); setDirty(true); }} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove line"><Trash2 className="size-4" /></button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {showCost && <div className="flex justify-end border-t border-zinc-100 px-4 py-2.5 text-sm"><span className="mr-6 text-zinc-500">Total before VAT</span><span className="font-semibold tabular" data-testid="po-net">{formatAED(net)}</span></div>}
        </Card>
        {(editable || notes) && (
          <Card title="Notes"><Textarea value={notes} disabled={!editable} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={2} placeholder="Shown on the printed purchase order" /></Card>
        )}
        {po?.receipts && po.receipts.length > 0 && (
          <Card title="Deliveries" padded={false}>
            <Table rows={po.receipts} rowKey={(r) => r.id}
              columns={[
                { header: "Received", cell: (r) => formatDateTime(r.createdAt) },
                { header: "By", cell: (r) => r.createdBy ?? "—" },
                { header: "Supplier invoice", cell: (r) => `${r.supplierInvoiceNo ?? "—"}${r.supplierInvoiceDate ? ` · ${formatDate(r.supplierInvoiceDate)}` : ""}` },
                { header: "Net", cell: (r) => formatAED(r.netFils), align: "right" },
                { header: "VAT", cell: (r) => formatAED(r.vatFils), align: "right" },
                { header: "Total", cell: (r) => formatAED(r.grossFils), align: "right" },
              ]} />
          </Card>
        )}
      </div>
      {po && <ReceiveDialog po={po} open={receiving} onClose={() => setReceiving(false)} onDone={(p) => poQuery.setData({ purchaseOrder: p })} />}
    </>
  );
}
