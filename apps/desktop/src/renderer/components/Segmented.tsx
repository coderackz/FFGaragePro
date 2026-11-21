import clsx from "clsx";

/** A small switch between a few views of one page ("Suggested orders" / "Min / max levels"). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-md border border-zinc-300 bg-white p-0.5 text-sm shadow-xs">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} onClick={() => onChange(v)}
          className={clsx("rounded px-2.5 py-1 whitespace-nowrap", value === v ? "bg-ink text-white" : "text-zinc-600 hover:bg-zinc-100")}>
          {text}
        </button>
      ))}
    </div>
  );
}
