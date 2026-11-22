import { dotAgeMonths, splitUnitCodes } from "@ffgp/shared";
import { Plus, Trash2 } from "lucide-react";
import type { Part, StockUnit } from "../lib/types";
import { useApi } from "../lib/useApi";
import { Button, Field, Input, NumberInput, Select, Textarea } from "./ui";
import { ALL } from "./ShowMore";

// Tyres by DOT, batteries by serial, and kits (inventory v2, Part 2): the bits of the screens that deal with them.

export type Tracking = "none" | "dot" | "serial";
export type KitRow = { partId: string; partNo: string; qty: number };

/** Part form: track each unit (none / DOT / serial), a battery's warranty, and "This is a kit" with its parts. */
export function TrackingFields({ stocked, tracking, warrantyMonths, isKit, components, lockedKit, onChange }: {
  stocked: boolean; tracking: Tracking; warrantyMonths: number; isKit: boolean; components: KitRow[];
  /** The part has stock or is in a kit: it can't become a kit. */
  lockedKit: boolean;
  onChange: (p: Partial<{ stocked: boolean; tracking: Tracking; warrantyMonths: number; isKit: boolean; components: KitRow[] }>) => void;
}) {
  return (
    <>
      {!isKit && stocked && (
        <Field label="Track each unit" hint={tracking === "dot" ? "Each tyre's DOT (week and year made) is entered when it arrives and picked on the job." : tracking === "serial" ? "Each battery's serial is entered when it arrives and picked on the job." : "Counted only (most parts)."}>
          <Select value={tracking} onChange={(e) => onChange({ tracking: e.target.value as Tracking })} aria-label="Track each unit">
            <option value="none">No</option>
            <option value="dot">Tyres — by DOT</option>
            <option value="serial">Batteries — by serial</option>
          </Select>
        </Field>
      )}
      {!isKit && stocked && tracking === "serial" && (
        <Field label="Warranty (months)" hint="Runs from the day it's fitted; printed on the invoice">
          <NumberInput value={warrantyMonths} onChange={(v) => onChange({ warrantyMonths: Math.max(0, Math.round(v)) })} aria-label="Warranty months" />
        </Field>
      )}
      <label className="col-span-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isKit} disabled={lockedKit && !isKit}
          onChange={(e) => onChange(e.target.checked ? { isKit: true, stocked: false, tracking: "none" } : { isKit: false, components: [] })} />
        This is a kit (a service package made of other parts)
      </label>
      {isKit && <KitRows rows={components} onChange={(components) => onChange({ components })} />}
    </>
  );
}

/** A kit's parts: a stocked part (typed by its number) and how many of it. */
function KitRows({ rows, onChange }: { rows: KitRow[]; onChange: (rows: KitRow[]) => void }) {
  const parts = useApi<{ parts: Part[] }>(`/api/parts?active=1&limit=${ALL}`);
  const stocked = (parts.data?.parts ?? []).filter((p) => p.stocked && !p.isKit);
  const set = (i: number, p: Partial<KitRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="col-span-2 rounded-md border border-zinc-200 p-3">
      <div className="mb-2 text-sm font-medium text-zinc-700">Parts in the kit</div>
      <datalist id="kit-parts">{stocked.map((p) => <option key={p.id} value={p.partNo}>{p.name}</option>)}</datalist>
      <div className="space-y-2">
        {rows.map((r, i) => {
          const known = stocked.find((p) => p.id === r.partId);
          return (
            <div key={i} className="flex items-center gap-2">
              <Input list="kit-parts" value={r.partNo} aria-label="Kit part number" className="flex-1" placeholder="Part number"
                onChange={(e) => {
                  const p = stocked.find((x) => x.partNo.toLowerCase() === e.target.value.trim().toLowerCase());
                  set(i, { partNo: e.target.value, partId: p?.id ?? "" });
                }} />
              <span className="w-48 truncate text-xs text-zinc-500">{known ? `${known.name} · ${known.onHand} ${known.unit}` : r.partNo ? "Not a stocked part" : ""}</span>
              <span className="w-20"><NumberInput value={r.qty} min={0} onChange={(qty) => set(i, { qty })} aria-label="Kit part quantity" /></span>
              <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="rounded p-1.5 text-zinc-400 hover:text-red-600" aria-label="Remove kit part">
                <Trash2 className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { partId: "", partNo: "", qty: 1 }])}>Add a part</Button>
    </div>
  );
}

/** Codes typed or pasted: see splitUnitCodes ("25 24" is one DOT). */
export const splitCodes = (text: string, tracking: Tracking) => splitUnitCodes(text, tracking === "none" ? "serial" : tracking);

/** A box for each unit's DOT code or serial coming in, with a count against the quantity. */
export function UnitCodesInput({ tracking, qty, value, onChange, label }: { tracking: Tracking; qty: number; value: string; onChange: (v: string) => void; label: string }) {
  const n = splitCodes(value, tracking).length;
  return (
    <div className="mt-1">
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} aria-label={label} className="font-mono text-xs"
        placeholder={tracking === "dot" ? "DOT codes, e.g. 2524 2524 2624 1025" : "Serial numbers, one per line"} />
      <div className={`text-xs ${n === qty ? "text-zinc-500" : "text-amber-700"}`}>{n} of {qty} {tracking === "dot" ? "DOT codes" : "serials"}</div>
    </div>
  );
}

/** A DOT's age in words ("17 months old"), or nothing for a serial. */
export const dotAge = (code: string) => {
  const m = dotAgeMonths(code);
  return m === null ? "" : m < 12 ? `${m} month${m === 1 ? "" : "s"} old` : `${Math.floor(m / 12)} yr ${m % 12} mo old`;
};

/**
 * A job card or invoice line's tyres or batteries: the ones on the shelf (oldest DOT first) and the ones this line
 * already has, ticked. "Pick the oldest" ticks as many as the quantity.
 */
export function UnitChooser({ partId, qty, chosen, current, onChange }: {
  partId: string; qty: number; chosen: string[]; current: StockUnit[]; onChange: (ids: string[], units: StockUnit[]) => void;
}) {
  const shelf = useApi<{ units: StockUnit[] }>(`/api/parts/${partId}/units?status=in_stock`);
  const options = [...current.filter((u) => chosen.includes(u.id)), ...(shelf.data?.units ?? []).filter((u) => !current.some((c) => c.id === u.id))];
  const want = Math.max(0, Math.floor(qty));
  const pick = (ids: string[]) => onChange(ids, ids.map((id) => options.find((u) => u.id === id)!).filter(Boolean));
  if (!options.length) return <span className="text-amber-700">None on the shelf to pick</span>;
  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-zinc-600">{chosen.length} of {want} picked</span>
        {chosen.length < want && (
          <button type="button" className="font-medium text-brand-700 hover:underline"
            onClick={() => pick([...chosen, ...options.filter((u) => !chosen.includes(u.id)).slice(0, want - chosen.length).map((u) => u.id)])}>
            Pick the oldest {want - chosen.length}
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {options.map((u) => {
          const on = chosen.includes(u.id);
          return (
            <label key={u.id} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${on ? "border-brand-700 bg-brand/10" : "border-zinc-200"}`}>
              <input type="checkbox" checked={on} aria-label={`Unit ${u.code}`} disabled={!on && chosen.length >= want}
                onChange={(e) => pick(e.target.checked ? [...chosen, u.id] : chosen.filter((x) => x !== u.id))} />
              <span className="font-mono">{u.code}</span>
              {dotAge(u.code) && <span className="text-zinc-500">{dotAge(u.code)}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}
