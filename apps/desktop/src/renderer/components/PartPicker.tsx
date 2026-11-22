import clsx from "clsx";
import { Link2Off } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { get, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DocLine, Part } from "../lib/types";
import { useDebounced } from "../lib/useApi";
import { Input } from "./ui";

/**
 * Description field for a part line. Typing searches the parts list; picking a part links the line to it
 * (stock and cost follow it). Typing without picking keeps a free-text line.
 */
export function PartPicker({ line, onChange, onPick, priceOf, vehicleId }: {
  line: DocLine; onChange: (patch: Partial<DocLine>) => void; onPick?: (p: Part) => void;
  /** The job's vehicle: parts that fit it come first (and with nothing typed, those are offered). */
  vehicleId?: string | null;
  /** The line price for a picked part (a document whose prices include VAT adds it). Default: its selling price. */
  priceOf?: (p: Part) => number;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Part[]>([]);
  const [active, setActive] = useState(0);
  const q = useDebounced(line.description, 150);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const typed = q.trim();
    if (!open || line.partId || (typed.length < 2 && !(typed === "" && vehicleId))) {
      setResults([]);
      return;
    }
    let live = true;
    const url = `/api/parts?active=1&picker=1&q=${encodeURIComponent(typed)}${vehicleId ? `&vehicleId=${vehicleId}` : ""}`;
    get<{ parts: Part[] }>(url).then((r) => live && (setResults(r.parts.slice(0, 8)), setActive(0))).catch(() => undefined);
    return () => { live = false; };
  }, [q, open, line.partId, vehicleId]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (p: Part) => {
    onChange({
      partId: p.id, partNo: p.partNo, partStocked: p.stocked, partOnHand: p.onHand, partUnit: p.unit, pickedOnHand: p.onHand,
      partTracking: p.stocked ? p.tracking ?? "none" : "none", partIsKit: !!p.isKit, unitIds: [], units: [],
      description: `${p.name} (${p.partNo})`, unitPriceFils: line.suppliedBy === "fleetfix" ? 0 : priceOf ? priceOf(p) : p.sellPriceFils,
    });
    onPick?.(p);
    setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <Input
        value={line.description}
        className="h-8"
        placeholder="Search parts or type a description"
        aria-label="Part"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setOpen(true); onChange({ description: e.target.value }); }}
        onKeyDown={(e) => {
          if (!results.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); pick(results[active]!); }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <ul role="listbox" className="absolute top-full right-0 left-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg">
          {results.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(p); }}
              onMouseEnter={() => setActive(i)}
              className={clsx("flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm", i === active && "bg-brand-50")}>
              <span className="w-24 shrink-0 truncate font-mono text-xs text-zinc-500">{p.partNo}</span>
              <span className="min-w-0 flex-1 truncate">
                {p.name}{p.brand ? <span className="text-zinc-400"> · {p.brand}</span> : null}
                {p.fitsVehicle && <span className="ml-1.5 rounded bg-emerald-50 px-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">Fits</span>}
                {p.replacesPartNo && <span className="ml-1.5 text-xs text-amber-700">replaces {p.replacesPartNo}</span>}
                {p.matchedBy && <span className="ml-1.5 text-xs text-zinc-500">{p.matchedBy}</span>}
              </span>
              <span className={clsx("shrink-0 text-xs tabular", !p.stocked ? "text-zinc-400" : p.onHand <= 0 ? "text-red-700" : "text-zinc-500")}>
                {p.stocked ? `${p.onHand} on shelf` : "per job"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Linked to OF-1001 · 9 on shelf" chip shown under a linked part line, with a way to unlink. */
export function PartLink({ line, editable, onUnlink, vehicleId }: { line: DocLine; editable: boolean; onUnlink: () => void; vehicleId?: string | null }) {
  const { can } = useAuth();
  const [added, setAdded] = useState(false);
  if (!line.partId) return null;
  const addFit = async () => {
    try {
      await post(`/api/parts/${line.partId}/fitments/from-vehicle`, { vehicleId });
      setAdded(true);
      toast.success("Saved: this part fits this vehicle");
    } catch (e) { toast.error((e as Error).message); }
  };
  const shelf = line.partIsKit ? "kit (its parts come off the shelf)" : line.partStocked ? `${line.partOnHand ?? 0} on shelf` : "bought per job";
  return (
    // Each piece stays whole ("OF-1001", "9 on shelf"); a narrow column moves a whole piece to the next line.
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
      <span className="font-mono whitespace-nowrap">{line.partNo}{" "}</span>
      <span className={clsx("whitespace-nowrap", line.partStocked && (line.partOnHand ?? 0) < 0 && "text-red-700")}>· {shelf}</span>
      {editable && (
        <button type="button" onClick={onUnlink} className="ml-0.5 text-zinc-400 hover:text-zinc-700" title="Unlink from the parts list" aria-label="Unlink part">
          <Link2Off className="size-3" />
        </button>
      )}
      {vehicleId && can("inventory.edit") && !added && (
        <button type="button" onClick={() => void addFit()} className="whitespace-nowrap text-zinc-500 underline hover:text-zinc-800" title="Add this vehicle to the part's fitment">Fits this vehicle</button>
      )}
    </span>
  );
}
