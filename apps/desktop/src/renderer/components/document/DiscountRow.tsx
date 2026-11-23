import { useEffect, useState } from "react";
import { discountPct, needsConfirmation } from "@ffgp/shared";
import type { DocumentFull } from "../../lib/types";
import { formatAED, formatDate } from "../../lib/format";
import { Button, Input, MoneyInput, NumberInput, Select } from "../ui";

type Kind = "percent" | "amount";
export interface DiscountRequest { kind: Kind; value: number; confirmed?: boolean; remark?: string }

/**
 * The overall discount in the summary: "+ Add discount", the form (% or AED; above the garage's limit a tick and a
 * remark), or the discount given with who confirmed it. `baseFils`: the bill it applies to (after line discounts).
 */
export function DiscountRow({ doc, editable, baseFils, limitPct, busy, onApply, onRemove }: {
  doc: DocumentFull | null; editable: boolean; baseFils: number; limitPct: number; busy: boolean;
  onApply: (d: DiscountRequest) => Promise<boolean>; onRemove: () => void;
}) {
  const discount = doc?.discount ?? null;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("percent");
  const [value, setValue] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [remark, setRemark] = useState("");
  // A discount that grew past the limit (lines removed) asks for its confirmation again.
  useEffect(() => {
    if (discount?.needsConfirmation && editable) start();
  }, [discount?.needsConfirmation, editable]);

  function start() {
    setKind(discount?.kind ?? "percent");
    setValue(discount?.value ?? 0);
    setConfirmed(false);
    setRemark("");
    setOpen(true);
  }

  const pct = kind === "percent" ? value : discountPct(value, baseFils);
  const above = value > 0 && needsConfirmation(pct, limitPct);
  const ready = value > 0 && (!above || (confirmed && remark.trim().length >= 3));
  const apply = async () => {
    if (await onApply({ kind, value, ...(above ? { confirmed, remark: remark.trim() } : {}) })) setOpen(false);
  };

  if (!editable && !discount) return null;
  if (doc?.promo && !discount) return null;

  if (open && editable) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5" data-testid="discount-form">
        <div className="flex items-center gap-2">
          {kind === "percent"
            ? <NumberInput value={value} min={0} step={1} onChange={(n) => setValue(Math.min(100, n))} className="h-8" aria-label="Discount" />
            : <MoneyInput fils={value} onChange={setValue} className="h-8" aria-label="Discount" />}
          <Select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setValue(0); }} className="h-8 w-20" aria-label="Discount in">
            <option value="percent">%</option>
            <option value="amount">AED</option>
          </Select>
        </div>
        {above && (
          <div className="flex flex-col gap-1.5 text-sm text-amber-900">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I confirm this {pct}% discount is approved (above the {limitPct}% limit)</span>
            </label>
            <Input value={remark} maxLength={300} onChange={(e) => setRemark(e.target.value)} placeholder="Remark — why this discount" className="h-8" aria-label="Discount remark" />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" variant="primary" busy={busy} disabled={!ready} onClick={() => void apply()}>Apply discount</Button>
        </div>
      </div>
    );
  }

  if (!discount) {
    return (
      <button type="button" onClick={start} className="self-start text-sm font-medium text-brand-700 hover:underline" data-testid="add-discount">
        + Add discount
      </button>
    );
  }

  const label = `Discount${discount.kind === "percent" ? ` ${discount.value}%` : ""}`;
  return (
    <div className="flex flex-col gap-0.5 text-sm" data-testid="discount-row">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="min-w-0 text-zinc-600">
          {label}
          {editable && (
            <>
              <button type="button" className="ml-2 text-xs text-zinc-500 underline hover:text-zinc-800" onClick={start}>Change</button>
              <button type="button" className="ml-2 text-xs text-zinc-500 underline hover:text-zinc-800 disabled:opacity-50" disabled={busy} onClick={onRemove}>Remove</button>
            </>
          )}
        </dt>
        <dd className="whitespace-nowrap tabular">{discount.applied ? `−${formatAED(discount.discountFils)}` : "—"}</dd>
      </div>
      {!discount.applied && <div className="text-xs text-amber-700">Not applied: this document has a promo code</div>}
      {discount.needsConfirmation && <div className="text-xs text-amber-700">Above the {limitPct}% limit now — confirm it with a remark</div>}
      {discount.confirmedBy && discount.remark && (
        <div className="text-xs text-zinc-500" data-testid="discount-approval">
          Approved by {discount.confirmedBy}{discount.confirmedAt ? `, ${formatDate(discount.confirmedAt)}` : ""}: {discount.remark}
        </div>
      )}
    </div>
  );
}
