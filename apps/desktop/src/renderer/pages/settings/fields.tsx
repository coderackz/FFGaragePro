import { filsToInput, parseAED } from "@ffgp/shared";
import clsx from "clsx";
import { useEffect, useState, type ReactNode } from "react";
import { Input } from "../../components/ui";

/** AED amount that may be left empty (null). */
export function OptionalMoney({ fils, onChange, ...rest }: { fils: number | null; onChange: (fils: number | null) => void; "aria-label"?: string; placeholder?: string }) {
  const [text, setText] = useState(fils == null ? "" : filsToInput(fils));
  useEffect(() => setText(fils == null ? "" : filsToInput(fils)), [fils]);
  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = e.target.value.trim();
        if (!v) return onChange(null);
        const parsed = parseAED(v);
        if (parsed !== null && parsed >= 0) onChange(parsed);
      }}
    />
  );
}

/** Whole or decimal number that may be left empty (null). */
export function OptionalNumber({ value, onChange, ...rest }: { value: number | null; onChange: (n: number | null) => void; "aria-label"?: string; placeholder?: string; max?: number }) {
  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={value == null ? "" : String(value)}
      onChange={(e) => {
        const v = e.target.value.trim();
        if (!v) return onChange(null);
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) onChange(n);
      }}
    />
  );
}

/** A set of radio choices shown as cards, each with a line of explanation. */
export function Choice<T extends string>({ name, value, onChange, options }: {
  name: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; hint?: ReactNode }[];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <label
          key={o.value}
          className={clsx(
            "flex cursor-pointer gap-3 rounded-lg border p-3 text-sm transition",
            value === o.value ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white hover:border-zinc-300",
          )}
        >
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 accent-zinc-900" />
          <span>
            <span className="block font-medium text-zinc-900">{o.label}</span>
            {o.hint && <span className="mt-0.5 block text-zinc-600">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-zinc-900" />
      <span>
        <span className="block font-medium text-zinc-900">{label}</span>
        {hint && <span className="block text-zinc-600">{hint}</span>}
      </span>
    </label>
  );
}
