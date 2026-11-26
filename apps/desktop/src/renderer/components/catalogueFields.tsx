import { MakeModelFields } from "./MakeModelFields";
import { PART_NUMBER_KIND_LABELS, PART_NUMBER_KINDS } from "@ffgp/shared";
import { Plus, Trash2 } from "lucide-react";
import type { Part, PartCategory } from "../lib/types";
import { Button, Field, Input, Select } from "./ui";

export type Numbers = NonNullable<Part["numbers"]>;
export type Fitments = NonNullable<Part["fitments"]>;
export type Packs = NonNullable<Part["packs"]>;
const remove = <T,>(list: T[], i: number) => list.filter((_, j) => j !== i);
const Del = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" onClick={onClick} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600" aria-label={label}><Trash2 className="size-4" /></button>
);
const yearOf = (s: string) => (s.trim() ? Number.parseInt(s, 10) || null : null);

/** The category's specs on the part form. */
export function AttributeFields({ category, values, onChange }: { category: PartCategory | undefined; values: Record<string, string | number>; onChange: (v: Record<string, string | number>) => void }) {
  if (!category?.attributes.length) return null;
  const set = (k: string, v: string) => {
    const next = { ...values };
    if (v === "") delete next[k]; else next[k] = v;
    onChange(next);
  };
  return (
    <div className="col-span-2 grid grid-cols-3 gap-3 max-md:grid-cols-1">
      {category.attributes.map((a) => (
        <Field key={a.key} label={a.unit ? `${a.label} (${a.unit})` : a.label}>
          {a.type === "choice" && a.options?.length ? (
            <Select value={String(values[a.key] ?? "")} onChange={(e) => set(a.key, e.target.value)} aria-label={a.label}>
              <option value="">—</option>
              {a.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          ) : (
            <Input value={String(values[a.key] ?? "")} inputMode={a.type === "number" ? "decimal" : undefined} onChange={(e) => set(a.key, e.target.value)} aria-label={a.label} />
          )}
        </Field>
      ))}
    </div>
  );
}

/** Other numbers: OEM, aftermarket, supplier codes, old numbers. */
export function NumberRows({ rows, onChange }: { rows: Numbers; onChange: (r: Numbers) => void }) {
  const set = (i: number, p: Partial<Numbers[number]>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Section title="Other numbers" hint="OEM and other brands' numbers for the same part; searching any of them finds it."
      add={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { number: "", kind: "oem", brand: null }])}>Add number</Button>}>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_150px_1fr_auto] gap-2">
          <Input value={r.number} onChange={(e) => set(i, { number: e.target.value })} aria-label={`Other number ${i + 1}`} placeholder="04152-YZZA1" />
          <Select value={r.kind} onChange={(e) => set(i, { kind: e.target.value as Numbers[number]["kind"] })} aria-label={`Kind ${i + 1}`}>
            {PART_NUMBER_KINDS.map((k) => <option key={k} value={k}>{PART_NUMBER_KIND_LABELS[k]}</option>)}
          </Select>
          <Input value={r.brand ?? ""} onChange={(e) => set(i, { brand: e.target.value || null })} aria-label={`Number brand ${i + 1}`} placeholder="Brand (optional)" />
          <Del onClick={() => onChange(remove(rows, i))} label={`Remove number ${i + 1}`} />
        </div>
      ))}
    </Section>
  );
}

/** The vehicles it fits: make, model, years, engine (blank = any). */
export function FitmentRows({ rows, onChange }: { rows: Fitments; onChange: (r: Fitments) => void }) {
  const set = (i: number, p: Partial<Fitments[number]>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Section title="Fits these vehicles" hint="Blank model, years or engine means any. Job cards for these vehicles show the part first."
      add={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { make: "", model: null, yearFrom: null, yearTo: null, engine: null, note: null }])}>Add vehicle</Button>}>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_80px_80px_1fr_auto] gap-2">
          <MakeModelFields layout="row" make={r.make} model={r.model ?? ""} label={{ make: `Make ${i + 1}`, model: `Model ${i + 1}` }}
            onChange={(p) => set(i, { ...(p.make !== undefined ? { make: p.make } : {}), ...(p.model !== undefined ? { model: p.model || null } : {}) })} />
          <Input value={r.yearFrom ?? ""} inputMode="numeric" onChange={(e) => set(i, { yearFrom: yearOf(e.target.value) })} aria-label={`From ${i + 1}`} placeholder="From" />
          <Input value={r.yearTo ?? ""} inputMode="numeric" onChange={(e) => set(i, { yearTo: yearOf(e.target.value) })} aria-label={`To ${i + 1}`} placeholder="To" />
          <Input value={r.engine ?? ""} onChange={(e) => set(i, { engine: e.target.value || null })} aria-label={`Engine ${i + 1}`} placeholder="Engine" />
          <Del onClick={() => onChange(remove(rows, i))} label={`Remove vehicle ${i + 1}`} />
        </div>
      ))}
    </Section>
  );
}

/** Packs it's bought in (a box of 10, a 208 L drum): only for purchase orders; stock stays in the part's unit. */
export function PackRows({ rows, unit, onChange }: { rows: Packs; unit: string; onChange: (r: Packs) => void }) {
  const set = (i: number, p: Partial<Packs[number]>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Section title="Bought in packs" hint={`Ordered by the pack; counted and sold by the ${unit}.`}
      add={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { name: "", size: 0 }])}>Add pack</Button>}>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_140px_auto] items-center gap-2">
          <Input value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={`Pack name ${i + 1}`} placeholder="Box of 10, Drum 208 L…" />
          <div className="flex items-center gap-1.5 text-sm text-zinc-500">
            <Input value={r.size || ""} inputMode="decimal" onChange={(e) => set(i, { size: Number(e.target.value) || 0 })} aria-label={`Holds ${i + 1}`} />
            <span className="shrink-0">{unit}</span>
          </div>
          <Del onClick={() => onChange(remove(rows, i))} label={`Remove pack ${i + 1}`} />
        </div>
      ))}
    </Section>
  );
}

function Section({ title, hint, add, children }: { title: string; hint: string; add: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="col-span-2 rounded-lg border border-zinc-200 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div><div className="text-sm font-medium text-zinc-900">{title}</div><div className="text-xs text-zinc-500">{hint}</div></div>
        {add}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** "Toyota Land Cruiser 2016–2021 · 1GR-FE". */
export const fitmentText = (f: Fitments[number]) => {
  const years = f.yearFrom && f.yearTo ? (f.yearFrom === f.yearTo ? `${f.yearFrom}` : `${f.yearFrom}–${f.yearTo}`) : f.yearFrom ? `${f.yearFrom}–` : f.yearTo ? `–${f.yearTo}` : "";
  return [f.make, f.model, years].filter(Boolean).join(" ") + (f.engine ? ` · ${f.engine}` : "");
};
