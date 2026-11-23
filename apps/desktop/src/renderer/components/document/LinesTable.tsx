import { PackagePlus, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { catalogueLinePrice, defaultUnit, LINE_KINDS, UNIT_SUGGESTIONS, type DocType, type LineKind } from "@ffgp/shared";
import { PartLink, PartPicker } from "../PartPicker";
import { UnitChooser } from "../trackedFields";
import { Badge, Empty, Input, MoneyInput, NumberInput, Select, Textarea } from "../ui";
import { lineCounts } from "../../lib/documentDraft";
import { formatAED, formatDate } from "../../lib/format";
import type { DocLine } from "../../lib/types";
import { shownLineTotals } from "../../print/templates";

export const KIND_LABELS: Record<LineKind, string> = { labour: "Labour", part: "Part", other: "Other" };

export function LinesTable({ type, lines, promoFils, vehicleId, editable, vatRate, includeVat, onChange, onRemove, onRequest, onAdd, showCost }: {
  /** The job's vehicle: the part search puts what fits it first. */
  vehicleId?: string | null;
  /** Each line's share of the promo or discount as the lines stand now (worked out while editing, before saving). */
  promoFils?: number[];
  type: DocType; lines: DocLine[]; editable: boolean; vatRate: number; includeVat: boolean; onChange: (i: number, l: Partial<DocLine>) => void; onRemove: (i: number) => void;
  onRequest?: (i: number) => void; showCost: boolean;
  /** Adds a line of that kind (the buttons under the last line). */
  onAdd?: (kind: LineKind) => void;
}) {
  const [describing, setDescribing] = useState<Set<number>>(new Set());
  // Removing a line moves the ones under it up: their open description boxes move with them.
  const remove = (i: number) => {
    setDescribing((d) => new Set([...d].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x))));
    onRemove(i);
  };
  // SL No: 1, 2, 3… over the lines that will be saved.
  const numbers = useMemo(() => {
    let n = 0;
    return lines.map((l) => (lineCounts(l) ? ++n : null));
  }, [lines]);
  // A unit still at its kind's default follows a change of kind or part; one the advisor typed stays.
  const untouched = (l: DocLine) => !l.unit || l.unit === defaultUnit(l.kind, l.partUnit);
  const addButtons = editable && onAdd && (
    <div className="flex items-center gap-4 border-t border-zinc-100 px-3 py-2 text-sm">
      {LINE_KINDS.map((k) => (
        <button key={k} type="button" onClick={() => onAdd(k)} className="font-medium text-brand-700 hover:underline">+ {KIND_LABELS[k]}</button>
      ))}
    </div>
  );
  if (lines.length === 0) return <>{editable ? addButtons : <Empty title="No items" />}</>;
  return (
    <div className="overflow-x-auto">
    <datalist id="unit-suggestions">{UNIT_SUGGESTIONS.map((u) => <option key={u} value={u} />)}</datalist>
    <table className="w-full min-w-[700px] table-fixed text-sm">
      <thead>
        <tr className="border-b border-zinc-200 bg-zinc-50/80 text-left text-xs font-medium tracking-wide whitespace-nowrap text-zinc-500 uppercase">
          <th className="w-8 py-2 pl-1 text-right font-medium">#</th>
          <th className="w-[92px] px-1.5 py-2 font-medium">Type</th>
          <th className="px-2 py-2 font-medium">Description</th>
          <th className="w-[60px] px-1.5 py-2 text-right font-medium">Qty</th>
          <th className="w-[56px] px-1.5 py-2 font-medium">Unit</th>
          <th className="w-[88px] px-1.5 py-2 text-right font-medium">{includeVat ? "Price incl. VAT" : "Unit price"}</th>
          <th className="w-[56px] px-1.5 py-2 text-right font-medium">Disc %</th>
          <th className="w-[60px] px-1.5 py-2 text-right font-medium">VAT</th>
          <th className="w-[84px] px-2 py-2 text-right font-medium">Total</th>
          {editable && <th className="w-8" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {lines.map((line, i) => {
          const t = shownLineTotals({ type, pricesIncludeVat: includeVat }, promoFils ? { ...line, promoFils: promoFils[i] ?? 0 } : line, vatRate);
          const hasDetails = line.kind !== "part";
          const showDetails = hasDetails && (!!line.details || describing.has(i));
          return (
            <tr key={i} className="align-top">
              <td className="py-1.5 pl-1 text-right leading-8 text-zinc-500 tabular" data-testid="line-number">{numbers[i] ?? ""}</td>
              <td className="px-1.5 py-1.5">
                {editable ? (
                  <Select value={line.kind} onChange={(e) => {
                    const kind = e.target.value as LineKind;
                    onChange(i, { kind, ...(untouched(line) ? { unit: defaultUnit(kind) } : {}) });
                  }} className="h-8 pr-0.5 pl-2 text-[13px]" aria-label="Line type">
                    {LINE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </Select>
                ) : (
                  <span className="leading-8 text-zinc-600">{KIND_LABELS[line.kind]}</span>
                )}
              </td>
              <td className="px-2 py-1.5 break-words">
                {editable && line.kind === "part" ? (
                  <PartPicker line={line} vehicleId={vehicleId} priceOf={(p) => catalogueLinePrice(p.sellPriceFils, vatRate, includeVat)}
                    onChange={(p) => onChange(i, p.partUnit !== undefined && untouched(line) ? { ...p, unit: defaultUnit("part", p.partUnit) } : p)} />
                ) : editable ? (
                  <Input value={line.description} onChange={(e) => onChange(i, { description: e.target.value })} placeholder={line.kind === "labour" ? "e.g. Replace front brake pads" : "Description"} className="h-8" aria-label="Line title" />
                ) : (
                  <div className="leading-8">{line.description}</div>
                )}
                {hasDetails && editable && (showDetails ? (
                  <Textarea value={line.details ?? ""} maxLength={2000} autoFocus={!line.details && describing.has(i)}
                    rows={Math.min(8, Math.max(2, (line.details ?? "").split("\n").length + 1))}
                    onChange={(e) => onChange(i, { details: e.target.value })}
                    onBlur={() => { if (!line.details?.trim()) setDescribing((d) => { const n = new Set(d); n.delete(i); return n; }); }}
                    placeholder="The work in detail — printed under the title" className="mt-1 min-h-0 text-sm" aria-label="Line description" />
                ) : (
                  <button type="button" onClick={() => setDescribing((d) => new Set(d).add(i))} className="mt-0.5 text-xs font-medium text-zinc-500 hover:text-zinc-800 hover:underline">
                    Add description
                  </button>
                ))}
                {hasDetails && !editable && line.details && <div className="mt-0.5 text-xs whitespace-pre-line text-zinc-600">{line.details}</div>}
                {line.kind === "part" && <PartControls vehicleId={vehicleId} line={line} editable={editable} showCost={showCost} fitsUnits={type !== "estimate"} onChange={(p) => onChange(i, p)} onRequest={onRequest && (() => onRequest(i))} />}
              </td>
              <td className="px-1.5 py-1.5 text-right tabular">
                {editable ? <NumberInput value={line.qty} onChange={(qty) => onChange(i, { qty })} className="h-8" aria-label="Quantity" /> : <span className="leading-8">{line.qty}</span>}
              </td>
              <td className="px-1.5 py-1.5">
                {editable
                  ? <Input value={line.unit ?? ""} list="unit-suggestions" maxLength={12} onChange={(e) => onChange(i, { unit: e.target.value })} className="h-8 px-1.5! text-center" aria-label="Unit" />
                  : <span className="leading-8 text-zinc-600">{line.unit ?? ""}</span>}
              </td>
              <td className="px-1.5 py-1.5 text-right tabular">
                {editable && line.suppliedBy !== "fleetfix" ? <MoneyInput fils={line.unitPriceFils} onChange={(unitPriceFils) => onChange(i, { unitPriceFils })} className="h-8" aria-label="Unit price" /> : <span className="leading-8">{formatAED(line.unitPriceFils).replace("AED ", "")}</span>}
              </td>
              <td className="px-1.5 py-1.5 text-right tabular">
                {editable ? <NumberInput value={line.discountPct} onChange={(discountPct) => onChange(i, { discountPct: Math.min(100, discountPct) })} className="h-8" aria-label="Discount percent" /> : <span className="leading-8">{line.discountPct || "—"}</span>}
              </td>
              <td className="px-1.5 py-1.5 text-right leading-8 text-zinc-500 tabular">{formatAED(t.vatFils).replace("AED ", "")}</td>
              <td className="px-2 py-1.5 text-right leading-8 font-medium tabular">{formatAED(t.grossFils).replace("AED ", "")}</td>
              {editable && (
                <td className="py-1.5 pr-1">
                  <div className="flex h-8 items-center">
                    <button type="button" onClick={() => remove(i)} className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove line">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
    {addButtons}
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

