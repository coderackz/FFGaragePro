import {
  changedProblem, checkEmail, checkEmiratesId, checkIban, checkOdometer, checkPhone, checkPlate, checkTrn, checkYear, COUNTRIES, EMIRATE_NAMES, EMIRATES, formatEmiratesId, formatIban, formatPhone,
  formatPlate, formatTrn, HOME_COUNTRY, nationalText, parsePhone, parsePlate, PLATE_EMIRATES, vinNote, type AddressParts, type Emirate,
} from "@ffgp/shared";
import clsx from "clsx";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Field, Input, Select } from "./ui";

// Boxes for what they hold. Each has its label tied to its main box only, so side boxes and buttons keep their own names.

/** Label, box, and what's wrong (or a note) beside it. */
export function FieldShell({ id, label, hint, error, note, className, children, hideLabel }: {
  id: string; label: string; hint?: string; error?: string | null; note?: ReactNode; className?: string; children: ReactNode; hideLabel?: boolean;
}) {
  return (
    <div className={clsx("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "text-[13px] font-medium text-zinc-700"}>{label}</label>
      {children}
      {error ? <span role="alert" className="text-xs text-red-700">{error}</span> : note ? <span className="text-xs text-zinc-600">{note}</span> : hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </div>
  );
}

/** A password (or other secret) that can be shown to check what was typed; hidden again when the form is sent. */
export function PasswordField({ label, hint, error, note, className, hideLabel, ...rest }: {
  label: string; hint?: string; error?: string | null; note?: string | null; className?: string; hideLabel?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id" | "className">) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = input.current?.form;
    const hide = () => setShown(false);
    form?.addEventListener("submit", hide);
    return () => form?.removeEventListener("submit", hide);
  }, []);
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} note={note} className={className} hideLabel={hideLabel}>
      <div className="relative" data-testid="password-field">
        <Input ref={input} id={id} type={shown ? "text" : "password"} spellCheck={false} autoCapitalize="none" aria-invalid={error ? true : undefined} className="pr-14" {...rest} />
        <button type="button" aria-pressed={shown} onClick={() => setShown(!shown)} className="absolute inset-y-0 right-0 rounded-r-md px-3 text-xs font-medium text-zinc-600 hover:text-zinc-900">
          {shown ? "Hide" : "Show"}
        </button>
      </div>
    </FieldShell>
  );
}

/** Beside the second box of a new password: whether it's the same as the first. */
export const passwordsMatch = (password: string, confirm: string): { error?: string; note?: string } =>
  !confirm ? {} : password === confirm ? { note: "Passwords match" } : { error: "The passwords don't match" };

type Check = (v: string) => string | null;

/** The first thing wrong with what's about to be saved; a value that was already there and wrong is left alone. */
export function firstProblem(list: [before: string | null | undefined, now: string | null | undefined, check: Check][]): string | null {
  for (const [before, now, check] of list) {
    const problem = changedProblem(before, now, check);
    if (problem) return problem;
  }
  return null;
}

interface BoxProps {
  label: string; value: string; onChange: (v: string) => void;
  /** What's stored now: not complained about until it's changed. */
  before?: string | null;
  hint?: string; disabled?: boolean; required?: boolean; autoFocus?: boolean; placeholder?: string; className?: string;
}

/** What's wrong, said once the box is left (and then kept up to date while it's put right). */
function useProblem(before: string | null | undefined, value: string, check: Check) {
  const [left, setLeft] = useState(false);
  return { error: left ? changedProblem(before, value, check) : null, onLeave: () => setLeft(true) };
}

/** One box with a check: shown grouped while it isn't being typed in. */
function CheckedField({ label, value, onChange, before, hint, className, check, shown, clean = (v) => v, note, ...rest }: BoxProps & {
  check: Check; shown?: (v: string) => string; clean?: (v: string) => string; note?: (v: string) => string | null;
} & Pick<InputHTMLAttributes<HTMLInputElement>, "inputMode" | "autoComplete" | "maxLength" | "spellCheck">) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const { error, onLeave } = useProblem(before, value, check);
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} note={note?.(value)} className={className}>
      <Input id={id} value={focused || !shown ? value : shown(value)} onChange={(e) => onChange(clean(e.target.value))} aria-invalid={error ? true : undefined}
        onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onLeave(); }} {...rest} />
    </FieldShell>
  );
}

const noSpaces = (v: string) => v.replace(/\s/g, "");

// A plain text box: the browser's own email check would refuse an old record that nobody touched.
export const EmailField = (p: BoxProps) => <CheckedField {...p} check={checkEmail} inputMode="email" spellCheck={false} autoComplete="off" />;
export const TrnField = (p: BoxProps) => (
  <CheckedField {...p} check={checkTrn} clean={noSpaces} shown={(v) => (checkTrn(v) ? v : formatTrn(v))} inputMode="numeric"
    note={(v) => (/^\d{1,14}$/.test(v) && v !== p.before ? `${v.length} of 15 digits` : null)} />
);
export const IbanField = (p: BoxProps) => (
  <CheckedField {...p} check={checkIban} shown={(v) => (checkIban(v) ? v : formatIban(v))} spellCheck={false} placeholder={p.placeholder ?? "AE07 0331 2345 6789 0123 456"} />
);
export const VinField = (p: BoxProps) => <CheckedField {...p} check={() => null} clean={(v) => v.toUpperCase()} note={vinNote} spellCheck={false} />;
export const YearField = (p: BoxProps) => <CheckedField {...p} check={checkYear} inputMode="numeric" maxLength={4} />;
export const OdometerField = (p: BoxProps) => <CheckedField {...p} check={checkOdometer} inputMode="numeric" />;
export const EmiratesIdField = (p: BoxProps) => (
  <CheckedField {...p} check={checkEmiratesId} shown={formatEmiratesId} inputMode="numeric" placeholder="784-XXXX-XXXXXXX-X" />
);

/**
 * A phone: country code and number, kept as +971 50 123 4567. A whole number typed or pasted in the box is sorted.
 * A stored phone that isn't exactly one number (two numbers, words) is kept as it is, in one plain box.
 */
export function PhoneField({ label, value, onChange, before, hint, className, disabled, ...rest }: BoxProps) {
  const id = useId();
  const read = (v: string) => {
    const p = parsePhone(v);
    return p ? { plain: false, iso: p.iso, text: nationalText(p) } : { plain: v.trim() !== "", iso: "AE", text: v };
  };
  const [box, setBox] = useState(() => read(value));
  // What this box last said: any other value came from outside (another record, a reload).
  const said = useRef(value);
  useEffect(() => {
    if (value === said.current) return;
    said.current = value;
    setBox(read(value));
  }, [value]);
  const { error, onLeave } = useProblem(before, value, checkPhone);
  const say = (next: typeof box) => {
    const dial = COUNTRIES.find((c) => c.iso === next.iso)!.dial;
    const whole = next.plain || next.iso === "AE" || !next.text.trim() ? next.text : `+${dial} ${next.text}`;
    const p = parsePhone(whole);
    const v = p ? formatPhone(p) : whole.trim();
    setBox(next);
    said.current = v;
    if (v !== value) onChange(v);
  };
  const type = (text: string) => {
    const p = !box.plain && /^\s*(\+|00)/.test(text) ? parsePhone(text) : null;
    say(p ? { plain: false, iso: p.iso, text: nationalText(p) } : { ...box, text });
  };
  const leave = () => {
    onLeave();
    const p = parsePhone(value);
    if (p) setBox({ plain: false, iso: p.iso, text: nationalText(p) });
    else if (!value) setBox((b) => ({ ...b, plain: false, text: "" }));
  };
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={className}>
      <div className="flex gap-1.5">
        {!box.plain && (
          // Closed it shows the code alone; the list names the countries.
          <div className="relative w-[76px] shrink-0">
            <Select value={box.iso} disabled={disabled} onChange={(e) => say({ ...box, iso: e.target.value })} className="text-transparent!" aria-label="Country code">
              {COUNTRIES.map((c) => <option key={c.iso} value={c.iso} className="text-zinc-900">+{c.dial} {c.name}</option>)}
            </Select>
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-zinc-900 tabular">+{COUNTRIES.find((c) => c.iso === box.iso)!.dial}</span>
          </div>
        )}
        <Input id={id} inputMode="tel" value={box.text} disabled={disabled} onChange={(e) => type(e.target.value)} onBlur={leave} aria-invalid={error ? true : undefined}
          placeholder={box.iso === "AE" && !box.plain ? "50 123 4567" : undefined} {...rest} />
      </div>
    </FieldShell>
  );
}

const OTHER = "other";

/** A plate: emirate, code and number, kept as DXB K 48213. A whole plate typed in the box is sorted; "Other" is as typed. */
export function PlateField({ label, value, onChange, before, hint, className, disabled, defaultEmirate, ...rest }: BoxProps & { defaultEmirate?: Emirate | null }) {
  const id = useId();
  const home = PLATE_EMIRATES.find((e) => e.emirate === defaultEmirate)?.code ?? "DXB";
  const read = (v: string) => parsePlate(v) ?? (v.trim() ? { emirate: OTHER, code: "", number: v } : { emirate: home, code: "", number: "" });
  const [box, setBox] = useState(() => read(value));
  const said = useRef(value);
  useEffect(() => {
    if (value === said.current) return;
    said.current = value;
    setBox(read(value));
  }, [value]);
  const { error, onLeave } = useProblem(before, value, checkPlate);
  const say = (next: typeof box) => {
    const number = next.number.trim().toUpperCase();
    const v = next.emirate === OTHER ? number : number || next.code ? formatPlate({ ...next, code: next.code.trim(), number }) : "";
    setBox(next);
    said.current = v;
    if (v !== value) onChange(v);
  };
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={className}>
      <div className="flex gap-1.5">
        <Select value={box.emirate} disabled={disabled} onChange={(e) => say({ ...box, emirate: e.target.value, ...(e.target.value === OTHER ? { code: "", number: [box.code, box.number].filter(Boolean).join(" ") } : {}) })}
          className="w-[132px]! shrink-0" aria-label="Plate emirate">
          {PLATE_EMIRATES.map((e) => <option key={e.code} value={e.code}>{EMIRATE_NAMES[e.emirate]}</option>)}
          <option value={OTHER}>Other</option>
        </Select>
        {box.emirate !== OTHER && (
          <Input value={box.code} disabled={disabled} maxLength={2} onChange={(e) => say({ ...box, code: e.target.value.toUpperCase() })} onBlur={onLeave} className="w-14! shrink-0 px-1.5! text-center uppercase" placeholder="Code" aria-label="Plate code" />
        )}
        <Input id={id} value={box.number} disabled={disabled} onChange={(e) => say(parsePlate(e.target.value) ?? { ...box, number: e.target.value })} onBlur={onLeave}
          aria-invalid={error ? true : undefined} className="uppercase" placeholder={box.emirate === OTHER ? "As on the plate" : "12345"} {...rest} />
      </div>
    </FieldShell>
  );
}

/** An address in parts; `country` for suppliers, who may be abroad (then there's no emirate). */
export function AddressFields({ value, onChange, country, emirateHint, className }: {
  value: AddressParts; onChange: (p: AddressParts) => void; country?: boolean; emirateHint?: string; className?: string;
}) {
  const box = (k: "unit" | "building" | "street" | "area" | "poBox", label: string, width: string, placeholder?: string) => (
    <Field label={label} className={width}>
      <Input value={value[k] ?? ""} maxLength={k === "street" ? 500 : 100} placeholder={placeholder} onChange={(e) => onChange({ ...value, [k]: e.target.value || null })} />
    </Field>
  );
  const home = !value.country || value.country === HOME_COUNTRY;
  const countries = COUNTRIES.map((c) => c.name);
  return (
    <fieldset className={clsx("grid grid-cols-6 gap-3", className)}>
      <legend className="mb-1.5 text-[13px] font-semibold text-zinc-800">Address</legend>
      {box("unit", "Unit / shop no.", "col-span-2", "e.g. Warehouse 12")}
      {box("building", "Building", "col-span-4")}
      {box("street", "Street", "col-span-6")}
      {box("area", "Area", "col-span-2", "e.g. Al Quoz 3")}
      {home && (
        <Field label="Emirate" hint={emirateHint} className="col-span-2">
          <Select aria-label="Emirate" value={value.emirate ?? ""} onChange={(e) => onChange({ ...value, emirate: (e.target.value || null) as Emirate | null })}>
            <option value="">Choose…</option>
            {EMIRATES.map((m) => <option key={m} value={m}>{EMIRATE_NAMES[m]}</option>)}
          </Select>
        </Field>
      )}
      {box("poBox", "PO Box", "col-span-2")}
      {country && (
        <Field label="Country" className="col-span-3">
          <Select aria-label="Country" value={value.country ?? HOME_COUNTRY} onChange={(e) => onChange({ ...value, ...(e.target.value === HOME_COUNTRY ? { country: null } : { country: e.target.value, emirate: null }) })}>
            {value.country && !countries.includes(value.country) && <option value={value.country}>{value.country}</option>}
            {countries.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      )}
    </fieldset>
  );
}
