import clsx from "clsx";
import { X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { STATUS_LABELS, filsToInput, parseAED } from "@ffgp/shared";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "dark";

const variants: Record<Variant, string> = {
  primary: "bg-brand text-ink hover:bg-brand-600 border border-brand-700/30 font-semibold shadow-sm",
  secondary: "bg-white text-zinc-800 hover:bg-zinc-50 border border-zinc-300 shadow-sm",
  ghost: "text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900",
  danger: "bg-white text-red-700 hover:bg-red-50 border border-red-200",
  dark: "bg-ink text-white hover:bg-ink-2 border border-black shadow-sm",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; icon?: ReactNode; busy?: boolean }
>(function Button({ variant = "secondary", size = "md", icon, busy, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none",
        size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner className="size-3.5" /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx("inline-block animate-spin rounded-full border-2 border-current border-r-transparent", className ?? "size-4")} />;
}

const fieldBase =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 shadow-xs focus:border-brand-700 focus:ring-2 focus:ring-brand/40 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-500";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(fieldBase, "h-9", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx(fieldBase, "py-2 min-h-20", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={clsx(fieldBase, "h-9 pr-1", className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-1", className)}>
      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-zinc-700">{label}</span>
        {children}
      </label>
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </div>
  );
}

/** Money input in AED; keeps the typed text while focused and reports fils. */
export function MoneyInput({ fils, onChange, className, ...rest }: { fils: number; onChange: (fils: number) => void; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value">) {
  const [text, setText] = useState(filsToInput(fils));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(filsToInput(fils));
  }, [fils, focused]);
  return (
    <Input
      inputMode="decimal"
      className={clsx("text-right tabular", className)}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onBlur={() => {
        setFocused(false);
        setText(filsToInput(fils));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = parseAED(e.target.value === "" ? "0" : e.target.value);
        if (parsed !== null && parsed >= 0) onChange(parsed);
      }}
      {...rest}
    />
  );
}

export function NumberInput({ value, onChange, min = 0, step, className, ...rest }: { value: number; onChange: (n: number) => void; min?: number; step?: number; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value">) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  return (
    <Input
      inputMode="decimal"
      className={clsx("text-right tabular", className)}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(/,/g, ""));
        if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min) onChange(step ? Math.round(n / step) * step : n);
      }}
      {...rest}
    />
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={clsx("rounded-lg border border-zinc-200 bg-white shadow-xs", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={clsx(padded && "p-4")}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div className="min-w-0">
        {back}
        <h1 className="truncate text-[22px] font-semibold tracking-tight text-zinc-900">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-zinc-500">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

const statusTone: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700 ring-zinc-300",
  sent: "bg-sky-50 text-sky-700 ring-sky-200",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  converted: "bg-violet-50 text-violet-700 ring-violet-200",
  open: "bg-amber-50 text-amber-800 ring-amber-200",
  in_progress: "bg-sky-50 text-sky-700 ring-sky-200",
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  issued: "bg-sky-50 text-sky-700 ring-sky-200",
  part_paid: "bg-amber-50 text-amber-800 ring-amber-200",
  paid: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", statusTone[status] ?? statusTone.draft)}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "brand" | "red" }) {
  const tones = { zinc: "bg-zinc-100 text-zinc-700", brand: "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand/50", red: "bg-red-50 text-red-700" };
  return <span className={clsx("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="text-zinc-300">{icon}</div>}
      <div className="font-medium text-zinc-700">{title}</div>
      {children && <div className="max-w-sm text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer, width = "max-w-lg" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={id} className={clsx("w-full rounded-xl bg-white shadow-2xl ring-1 ring-black/5", width)}>
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
          <h2 id={id} className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" aria-label="Close">
            <X className="size-4" />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 rounded-b-xl border-t border-zinc-100 bg-zinc-50 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Plain data table with row click. */
export function Table<T>({
  rows,
  columns,
  onRowClick,
  empty,
  rowKey,
}: {
  rows: T[];
  columns: { header: string; cell: (row: T) => ReactNode; className?: string; align?: "right" }[];
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  rowKey: (row: T) => string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-zinc-200 bg-zinc-50/80 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
          {columns.map((c) => (
            <th key={c.header} className={clsx("px-4 py-2 font-medium", c.align === "right" && "text-right", c.className)}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {rows.map((row) => (
          <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={clsx(onRowClick && "cursor-pointer hover:bg-brand-50/60")}>
            {columns.map((c) => (
              <td key={c.header} className={clsx("px-4 py-2.5", c.align === "right" && "text-right tabular", c.className)}>
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-80">
      <svg className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-8" autoFocus />
    </div>
  );
}
