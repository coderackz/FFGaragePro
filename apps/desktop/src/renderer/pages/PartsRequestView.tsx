import { ArrowLeft, Ban, Check, Save, ShoppingCart, Trash2, TriangleAlert, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { filsToInput, parseAED } from "@ffgp/shared";
import { AskVendorsDialog } from "../components/AskVendorsDialog";
import { Badge, Button, Card, Empty, Input, PageHeader } from "../components/ui";
import { patch, post, put } from "../lib/api";
import { formatAED, formatDateTime } from "../lib/format";
import type { PurchaseOrder } from "../lib/types";
import { vendorVehicle } from "../print/templates";

const key = (supplierId: string, lineId: string) => `${supplierId}:${lineId}`;

/** Each part's cheapest vendor with a price, or none. */
function cheapest(po: PurchaseOrder, prices: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of po.lines) {
    let best: { id: string; fils: number } | null = null;
    for (const q of po.quotes ?? []) {
      const fils = parseAED(prices[key(q.supplierId, l.id!)] ?? "");
      if (fils !== null && (!best || fils < best.fils)) best = { id: q.supplierId, fils };
    }
    if (best) out[l.id!] = best.id;
  }
  return out;
}

/**
 * A job card's request: the vehicle vendors need, the parts with each vendor's price, and ordering the parts from
 * the vendors chosen (the cheapest to start).
 */
export function PartsRequestView({ po, onChange, onOrdered }: { po: PurchaseOrder; onChange: (po: PurchaseOrder) => void; onOrdered: (pos: PurchaseOrder[]) => void }) {
  const quotes = po.quotes ?? [];
  const saved = useMemo(() => {
    const p: Record<string, string> = {};
    for (const q of quotes) for (const x of q.prices ?? []) p[key(q.supplierId, x.poLineId)] = x.unitCostFils === null ? "" : filsToInput(x.unitCostFils);
    return p;
  }, [po]); // eslint-disable-line react-hooks/exhaustive-deps
  const [prices, setPrices] = useState(saved);
  // Vendors the buyer chose by hand; every other part goes to its cheapest vendor, following the prices as they're typed.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    setPrices(saved);
    setPicked({});
    setDirty(false);
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try { await fn(); } catch (error) { toast.error((error as Error).message); } finally { setBusy(null); }
  };
  const setPrice = (lineId: string, supplierId: string, text: string) => {
    setPrices((p) => ({ ...p, [key(supplierId, lineId)]: text }));
    setDirty(true);
  };
  /** Each part's vendor: the one picked while it has a price, else the cheapest. */
  const choices = useMemo(() => {
    const out = cheapest(po, prices);
    for (const [lineId, supplierId] of Object.entries(picked)) if (parseAED(prices[key(supplierId, lineId)] ?? "") !== null) out[lineId] = supplierId;
    return out;
  }, [po, prices, picked]);
  const bad = Object.entries(prices).find(([, v]) => v.trim() !== "" && parseAED(v) === null);

  /** Saves the prices typed; returns the request as it now stands. */
  const savePrices = async (): Promise<PurchaseOrder> => {
    if (!dirty) return po;
    if (bad) throw new Error(`"${bad[1]}" isn't an amount`);
    const body = quotes.flatMap((q) => po.lines.map((l) => ({ supplierId: q.supplierId, poLineId: l.id!, unitCostFils: parseAED(prices[key(q.supplierId, l.id!)] ?? "") })));
    const res = await put<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${po.id}/quote-prices`, { prices: body });
    setDirty(false);
    onChange(res.purchaseOrder);
    return res.purchaseOrder;
  };

  const chosen = po.lines.filter((l) => choices[l.id!]);
  const byVendor = quotes
    .map((q) => ({ q, lines: chosen.filter((l) => choices[l.id!] === q.supplierId) }))
    .filter((g) => g.lines.length)
    // In the order of each vendor's first part: the order the purchase orders are numbered in.
    .sort((a, b) => po.lines.indexOf(a.lines[0]!) - po.lines.indexOf(b.lines[0]!))
    .map((g) => ({ ...g, fils: g.lines.reduce((s, l) => s + Math.round(l.qty * (parseAED(prices[key(g.q.supplierId, l.id!)] ?? "") ?? 0)), 0) }));

  const order = () => run("order", async () => {
    if (!chosen.length) throw new Error("Choose a vendor for at least one part");
    const left = po.lines.length - chosen.length;
    const summary = byVendor.map((g) => `${g.lines.length === 1 ? "1 part" : `${g.lines.length} parts`} from ${g.q.name} (${formatAED(g.fils)})`).join(" and ");
    if (!window.confirm(`Order ${summary}?${left ? ` ${left === 1 ? "1 part without a vendor stays" : `${left} parts without a vendor stay`} on a new request.` : ""}`)) return;
    const current = await savePrices();
    const res = await post<{ purchaseOrders: PurchaseOrder[] }>(`/api/purchase-orders/${po.id}/order`, {
      version: current.version, choices: chosen.map((l) => ({ poLineId: l.id!, supplierId: choices[l.id!]! })),
    });
    onOrdered(res.purchaseOrders);
  });

  const removeLine = (id: string) => run(`remove:${id}`, async () => {
    const line = po.lines.find((l) => l.id === id)!;
    if (!window.confirm(`Take ${line.description} off ${po.number}?${line.onJob ? " The job card can request it again." : ""}`)) return;
    const lines = po.lines.filter((l) => l.id !== id).map((l) => ({ id: l.id, partId: l.partId, description: l.description, qty: l.qty, unitCostFils: 0, jobDocumentId: l.jobDocumentId, packName: null, packSize: null, packCostFils: null }));
    onChange((await patch<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${po.id}`, { version: po.version, lines })).purchaseOrder);
  });

  const cancel = () => run("cancel", async () => {
    if (!window.confirm(`Cancel ${po.number}? Its job card can request the parts again.`)) return;
    onChange((await patch<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${po.id}`, { version: po.version, status: "cancelled" })).purchaseOrder);
  });

  const v = po.job?.vehicle;
  return (
    <>
      <PageHeader
        back={<Link to="/purchase-orders" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Purchase orders</Link>}
        title={<span className="flex items-center gap-3"><span className="font-mono">{po.number}</span><Badge tone="amber">Request</Badge>{dirty && <span className="text-sm font-normal text-amber-700">Prices not saved</span>}</span>}
        subtitle={<>Vendor not chosen yet{po.job && <> · for <Link className="font-mono text-brand-700 hover:underline" to={`/documents/${po.job.id}`}>{po.job.number}</Link></>} · requested {formatDateTime(po.createdAt)}{po.createdBy ? ` by ${po.createdBy}` : ""}</>}
        actions={<>
          <Button variant="danger" icon={<Ban className="size-4" />} busy={busy === "cancel"} onClick={cancel}>Cancel request</Button>
          {dirty && <Button icon={<Save className="size-4" />} busy={busy === "save"} onClick={() => void run("save", async () => { await savePrices(); toast.success("Prices saved"); })}>Save prices</Button>}
          <Button variant={quotes.length ? "secondary" : "primary"} icon={<Users className="size-4" />} onClick={() => setAsking(true)}>Ask vendors for prices</Button>
          <Button variant={quotes.length ? "primary" : "secondary"} icon={<ShoppingCart className="size-4" />} disabled={!chosen.length} busy={busy === "order"} onClick={order}>Order</Button>
        </>}
      />
      <div className="flex flex-col gap-5">
        <Card title="Vehicle">
          {v ? (
            <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm" data-testid="request-vehicle">
              <span><span className="text-zinc-500">Vehicle </span>{vendorVehicle(v) || "—"} <span className="text-zinc-400">· {v.plate}</span></span>
              <span><span className="text-zinc-500">VIN </span>{v.vin ? <span className="font-mono">{v.vin}</span> : <span className="text-amber-700">not saved — add it on the vehicle</span>}</span>
              <span><span className="text-zinc-500">Mulkiya </span>{v.mulkiya.front || v.mulkiya.back ? [v.mulkiya.front && "front", v.mulkiya.back && "back"].filter(Boolean).join(" and ") : <span className="text-zinc-500">no photo</span>}</span>
            </div>
          ) : <span className="text-sm text-zinc-500">The job card has no vehicle.</span>}
        </Card>

        <Card title="Parts and prices" padded={false}>
          {po.lines.length === 0 ? <Empty title="Nothing on this request" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50/80 text-left text-xs font-medium tracking-wide text-zinc-500 uppercase">
                    <th className="px-4 py-2 font-medium">Part</th>
                    <th className="w-16 px-2 py-2 text-right font-medium">Qty</th>
                    {quotes.map((q) => (
                      <th key={q.supplierId} className="w-40 px-2 py-2 font-medium normal-case">
                        <div className="text-zinc-800">{q.name}</div>
                        <div className="text-[11px] font-normal text-zinc-500">{q.askedAt ? `Asked ${formatDateTime(q.askedAt)}` : "Not sent yet"}</div>
                      </th>
                    ))}
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {po.lines.map((l) => (
                    <tr key={l.id} className="align-top">
                      <td className="px-4 py-2.5">
                        {l.description}
                        {!l.onJob && <div className="mt-0.5 flex items-center gap-1 text-xs text-amber-700"><TriangleAlert className="size-3" />No longer on the job card</div>}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular">{l.qty}</td>
                      {quotes.map((q) => {
                        const k = key(q.supplierId, l.id!);
                        const has = parseAED(prices[k] ?? "") !== null;
                        const notSent = (q.notSent ?? []).includes(l.id!);
                        return (
                          <td key={q.supplierId} className="px-2 py-1.5">
                            <div className="flex items-center gap-2">
                              <input type="radio" name={`choice-${l.id}`} disabled={!has} checked={choices[l.id!] === q.supplierId}
                                onChange={() => setPicked((c) => ({ ...c, [l.id!]: q.supplierId }))} aria-label={`Order ${l.description} from ${q.name}`} />
                              <Input value={prices[k] ?? ""} placeholder="—" inputMode="decimal" className="h-8 text-right tabular" aria-label={`${q.name} price for ${l.description}`}
                                onChange={(e) => setPrice(l.id!, q.supplierId, e.target.value)} />
                            </div>
                            {notSent && !has && <div className="mt-0.5 pl-6 text-[11px] text-amber-700">Not sent to them yet</div>}
                          </td>
                        );
                      })}
                      <td className="pt-2 pr-2">
                        <button type="button" onClick={() => void removeLine(l.id!)} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${l.description}`}><Trash2 className="size-4" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-4 py-2.5 text-sm">
            <span className="text-zinc-500">
              {quotes.length ? "Type each vendor's price per part (blank: they don't have it). The cheapest is chosen; choose another with its button." : "Ask vendors for prices to compare them here."}
              {quotes.some((q) => q.notSent?.length) && <span className="ml-1 text-amber-700">Some parts were requested after vendors were asked: send the request again to include them.</span>}
            </span>
            {byVendor.length > 0 && <span className="flex flex-wrap gap-4" data-testid="order-summary">{byVendor.map((g) => <span key={g.q.supplierId}><Check className="mr-1 inline size-3.5 text-emerald-600" />{g.q.name}: <b className="tabular">{formatAED(g.fils)}</b></span>)}</span>}
          </div>
        </Card>

        {!!po.messages?.length && <VendorMessages po={po} />}
      </div>
      <AskVendorsDialog po={po} open={asking} onClose={() => setAsking(false)} onChanged={onChange} />
    </>
  );
}

/** What was sent to vendors about this order or request. */
export function VendorMessages({ po }: { po: PurchaseOrder }) {
  const names = new Map((po.quotes ?? []).map((q) => [q.supplierId, q.name]));
  if (po.supplier) names.set(po.supplier.id, po.supplier.name);
  return (
    <Card title="Sent to vendors">
      <ul className="flex flex-col gap-1.5 text-sm" data-testid="vendor-messages">
        {po.messages!.map((m) => (
          <li key={m.id} className="flex flex-wrap gap-x-3 text-zinc-700">
            <span className="text-zinc-500">{formatDateTime(m.createdAt)}</span>
            <span>{m.event === "parts_request" ? "Asked for prices" : "Order sent"}: {names.get(m.supplierId ?? "") ?? m.recipient}</span>
            <span className="text-zinc-500">by {m.channel === "email" ? `email (${m.status === "sent" ? "sent" : m.status === "failed" ? "failed" : "waiting"})` : "WhatsApp"}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
