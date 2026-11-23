import clsx from "clsx";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Input } from "./ui";

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
