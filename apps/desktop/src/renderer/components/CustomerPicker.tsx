import { formatAED } from "@ffgp/shared";
import clsx from "clsx";
import { ChevronsUpDown, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { get } from "../lib/api";
import type { Customer } from "../lib/types";
import { useDebounced } from "../lib/useApi";

/** Searchable customer select (name, phone or plate). */
export function CustomerPicker({ value, onChange, onCreate, disabled }: { value: { id: string; name: string } | null; onChange: (c: Customer | null) => void; onCreate?: (name: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [active, setActive] = useState(0);
  const query = useDebounced(q, 150);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    get<{ customers: Customer[] }>(`/api/customers?q=${encodeURIComponent(query)}`)
      .then((r) => alive && (setResults(r.customers.slice(0, 30)), setActive(0)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [query, open]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const choose = (c: Customer) => {
    onChange(c);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={box} className="relative">
      {open ? (
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            if (e.key === "Enter" && results[active]) (e.preventDefault(), choose(results[active]!));
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Search name, phone or plate…"
          className="h-9 w-full rounded-md border border-brand-700 bg-white px-2.5 text-sm ring-2 ring-brand/40 outline-none"
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="flex h-9 w-full items-center justify-between rounded-md border border-zinc-300 bg-white px-2.5 text-left text-sm shadow-xs hover:border-zinc-400 disabled:bg-zinc-50 disabled:text-zinc-500"
        >
          <span className={clsx("truncate", !value && "text-zinc-400")}>{value?.name ?? "Choose customer…"}</span>
          <ChevronsUpDown className="size-4 text-zinc-400" />
        </button>
      )}
      {open && (
        <div className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg">
          {results.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
              className={clsx("flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm", i === active && "bg-brand-50")}
            >
              <span className="truncate font-medium">{c.name}</span>
              <span className="shrink-0 text-xs text-zinc-500">
                {[c.phone, ...(c.plates ?? []).slice(0, 2)].filter(Boolean).join(" · ")}
                {!!c.balanceFils && <span className={c.overLimit ? "ml-2 font-medium text-red-700" : "ml-2 text-zinc-700"}>{formatAED(c.balanceFils)}{c.overLimit ? " · over limit" : ""}</span>}
              </span>
            </button>
          ))}
          {results.length === 0 && <div className="px-3 py-2 text-sm text-zinc-500">No customers found</div>}
          {onCreate && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreate(q);
              }}
              className="flex w-full items-center gap-2 border-t border-zinc-100 px-3 py-2 text-left text-sm font-medium text-brand-700 hover:bg-brand-50"
            >
              <Plus className="size-4" /> New customer{q ? ` “${q}”` : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
