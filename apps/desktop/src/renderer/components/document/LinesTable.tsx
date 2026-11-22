import { PackagePlus, Trash2, TriangleAlert } from "lucide-react";
import { catalogueLinePrice, LINE_KINDS, type DocType, type LineKind } from "@ffgp/shared";
import { PartLink, PartPicker } from "../PartPicker";
import { UnitChooser } from "../trackedFields";
import { Badge, Empty, Input, MoneyInput, NumberInput, Select } from "../ui";
import { formatAED, formatDate } from "../../lib/format";
import type { DocLine } from "../../lib/types";
import { shownLineTotals } from "../../print/templates";

export const KIND_LABELS: Record<LineKind, string> = { labour: "Labour", part: "Part", other: "Other" };

export function LinesTable({ type, lines, promoFils, vehicleId, editable, vatRate, includeVat, onChange, onRemove, onRequest, showCost }: {
  /** The job's vehicle: the part search puts what fits it first. */
  vehicleId?: string | null;
  /** Each line's share of the promo as the lines stand now (worked out here while editing, before saving). */
  promoFils?: number[];
  type: DocType; lines: DocLine[]; editable: boolean; vatRate: number; includeVat: boolean; onChange: (i: number, l: Partial<DocLine>) => void; onRemove: (i: number) => void;
  onRequest?: (i: number) => void; showCost: boolean;
}) {
  if (lines.length === 0) return <Empty title="No items" />;
  return (
    <div className="overflow-x-auto">
    <table className="w-full min-w-[700px] table-fixed text-sm">
      <thead>
        <tr className="border-b border-zinc-200 bg-zinc-50/80 text-left text-xs font-medium tracking-wide text-zinc-500 uppercase">
          <th className="w-[124px] px-3 py-2 font-medium">Type</th>
          <th className="px-2 py-2 font-medium">Description</th>
          <th className="w-[64px] px-2 py-2 text-right font-medium">Qty</th>
          <th className="w-[96px] px-2 py-2 text-right font-medium">{includeVat ? "Price incl. VAT" : "Unit price"}</th>
          <th className="w-[64px] px-2 py-2 text-right font-medium">Disc %</th>
          <th className="w-[70px] px-2 py-2 text-right font-medium">VAT</th>
          <th className="w-[96px] px-3 py-2 text-right font-medium">Total</th>
          {editable && <th className="w-10" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {lines.map((line, i) => {
          const t = shownLineTotals({ type, pricesIncludeVat: includeVat }, promoFils ? { ...line, promoFils: promoFils[i] ?? 0 } : line, vatRate);
          return (
            <tr key={i} className="align-top">
              <td className="px-3 py-1.5">
                {editable ? (
                  <Select value={line.kind} onChange={(e) => onChange(i, { kind: e.target.value as LineKind })} className="h-8" aria-label="Line type">
                    {LINE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </Select>
                ) : (
                  <span className="text-zinc-600">{KIND_LABELS[line.kind]}</span>
                )}
              </td>
              <td className="px-2 py-1.5 break-words">
                {editable && line.kind === "part" ? (
                  <PartPicker line={line} vehicleId={vehicleId} onChange={(p) => onChange(i, p)} priceOf={(p) => catalogueLinePrice(p.sellPriceFils, vatRate, includeVat)} />
                ) : editable ? (
                  <Input value={line.description} onChange={(e) => onChange(i, { description: e.target.value })} placeholder={line.kind === "labour" ? "e.g. Replace front brake pads" : "Description"} className="h-8" />
                ) : (
                  line.description
                )}
                {line.kind === "part" && <PartControls vehicleId={vehicleId} line={line} editable={editable} showCost={showCost} fitsUnits={type !== "estimate"} onChange={(p) => onChange(i, p)} onRequest={onRequest && (() => onRequest(i))} />}
              </td>
              <td className="px-2 py-1.5 text-right tabular">
                {editable ? <NumberInput value={line.qty} onChange={(qty) => onChange(i, { qty })} className="h-8" aria-label="Quantity" /> : line.qty}
              </td>
              <td className="px-2 py-1.5 text-right tabular">
                {editable && line.suppliedBy !== "fleetfix" ? <MoneyInput fils={line.unitPriceFils} onChange={(unitPriceFils) => onChange(i, { unitPriceFils })} className="h-8" aria-label="Unit price" /> : formatAED(line.unitPriceFils).replace("AED ", "")}
              </td>
              <td className="px-2 py-1.5 text-right tabular">
                {editable ? <NumberInput value={line.discountPct} onChange={(discountPct) => onChange(i, { discountPct: Math.min(100, discountPct) })} className="h-8" aria-label="Discount percent" /> : line.discountPct || "—"}
              </td>
              <td className="px-2 py-1.5 text-right text-zinc-500 tabular">{formatAED(t.vatFils).replace("AED ", "")}</td>
              <td className="px-3 py-1.5 text-right font-medium tabular">{formatAED(t.grossFils).replace("AED ", "")}</td>
              {editable && (
                <td className="pr-2">
                  <button type="button" onClick={() => onRemove(i)} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove line">
                    <Trash2 className="size-4" />
                  </button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

/** The row of part details under a part line: Fleet Fix supply, order status, shelf warning, request button. */
function PartControls({ line, editable, showCost, fitsUnits, onChange, onRequest, vehicleId }: {
  line: DocLine; editable: boolean; showCost: boolean; onChange: (p: Partial<DocLine>) => void; onRequest?: () => void; vehicleId?: string | null;
  /** Job cards and invoices fit tyres and batteries one by one; estimates don't. */
  fitsUnits: boolean;
}) {
  const fleetfix = line.suppliedBy === "fleetfix";
  const short = line.partStocked && !fleetfix && line.pickedOnHand !== undefined && line.qty > line.pickedOnHand;
  const canRequest = onRequest && !fleetfix && !line.poLineId && !line.partIsKit && line.description.trim() !== "";
  const hasAny = line.partId || fleetfix || line.orderStatus || editable || (showCost && line.costFils !== undefined);
  if (!hasAny) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <PartLink line={line} editable={editable} vehicleId={vehicleId} onUnlink={() => onChange({ partId: null, partNo: null, partStocked: null, partOnHand: null, pickedOnHand: undefined, partTracking: "none", partIsKit: false, unitIds: [], units: [] })} />
      {editable ? (
        <label className="inline-flex items-center gap-1 text-zinc-600">
          <input type="checkbox" checked={fleetfix} disabled={!!line.poLineId} onChange={(e) => onChange(e.target.checked ? { suppliedBy: "fleetfix", unitPriceFils: 0, discountPct: 0 } : { suppliedBy: "garage" })} />
          Supplied by Fleet Fix
        </label>
      ) : fleetfix ? <Badge tone="brand">Supplied by Fleet Fix</Badge> : null}
      {line.orderStatus === "on_order" && <Badge tone="zinc">On order · {line.purchaseOrderNumber}</Badge>}
      {line.orderStatus === "received" && <Badge tone="brand">Received · {line.purchaseOrderNumber}</Badge>}
      {short && (
        <span className="inline-flex items-center gap-1 text-red-700"><TriangleAlert className="size-3" />Only {line.pickedOnHand} on the shelf — stock will go below zero</span>
      )}
      {showCost && line.costFils !== undefined && !fleetfix && (line.partId || line.poLineId) && (
        <span className="text-zinc-500">Cost {line.costFils === null ? "pending" : formatAED(line.costFils)}</span>
      )}
      {canRequest && (
        <button type="button" onClick={onRequest} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
          <PackagePlus className="size-3.5" />Request part
        </button>
      )}
      {fitsUnits && !fleetfix && line.partId && line.partTracking && line.partTracking !== "none" && (
        editable ? (
          <UnitChooser partId={line.partId} qty={line.qty} chosen={line.unitIds ?? []} current={line.units ?? []}
            onChange={(unitIds, units) => onChange({ unitIds, units })} />
        ) : (line.units ?? []).length > 0 && (
          <span className="text-zinc-600">
            {(line.units ?? []).map((u) => (line.partTracking === "dot" ? `DOT ${u.code}` : `${u.code}${u.warrantyEnds ? ` · warranty to ${formatDate(u.warrantyEnds)}` : ""}`)).join(", ")}
          </span>
        )
      )}
    </div>
  );
}

