import { MESSAGE_EVENTS, PLACEHOLDERS, unknownPlaceholders, type MessageEvent, type MessageEventSettings } from "@ffgp/shared";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Card, Field, Input, NumberInput, Select, Textarea } from "../../../components/ui";
import { PasswordField } from "../../../components/fields";
import { get, post, put } from "../../../lib/api";
import { useApi } from "../../../lib/useApi";
import type { Message } from "../../../lib/types";
import { Toggle } from "../fields";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";
import { EVENT_LABELS } from "../../../messages/labels";

const EVENT_HINTS: Record<MessageEvent, string> = {
  vehicle_received: "When a job card is opened · to the driver, or the vehicle-ready contacts",
  estimate_ready: "From Send on an estimate · to the approvals contacts · estimate PDF",
  estimate_resent: "An estimate sent again · to the approvals contacts · estimate PDF",
  vehicle_ready: "When a job card is completed · to the driver, or the vehicle-ready contacts",
  invoice_issued: "When an invoice is issued · to the invoices contacts · invoice PDF",
  payment_received: "When a payment is recorded · to the invoices contacts · receipt PDF",
  payment_due: "Automatic email before the due date · to the invoices contacts",
  payment_overdue: "Automatic email after the due date · to the invoices contacts",
  statement: "From the dashboard each month · to the statements contacts · statement PDF",
  payslip: "From an approved payroll · to each employee · payslip PDF (only payroll staff see these)",
};

const REMINDERS: MessageEvent[] = ["payment_due", "payment_overdue"];

/** Settings → Messages: the garage's own mailbox, reminders, and each message's text. */
export function MessagesSection() {
  const form = useSectionForm("messages");
  const m = form.value;
  const overview = useApi<{ messages?: { passwordSet: boolean } }>("/api/settings/overview");
  const setEvent = (e: MessageEvent, patch: Partial<MessageEventSettings>) => form.set({ [e]: { ...m[e], ...patch } } as Partial<typeof m>);
  const badText = MESSAGE_EVENTS.some((e) => [m[e].subjectEn, m[e].textEn].some((t) => unknownPlaceholders(t).length || !t.trim()));

  return (
    <SectionShell
      title="Messages" subtitle="WhatsApp and email to customers, sent from your own mailbox"
      dirty={form.dirty} busy={form.busy}
      onSave={() => (badText ? toast.error("Fix the message texts marked in red first") : void form.save())}
      onDiscard={() => form.setValue(form.saved)}
    >
      <Card title="Email (your mailbox)">
        <p className="mb-3 text-sm text-zinc-600">
          Emails go out from your garage's own email address. Your email provider gives these details (for Gmail and Outlook, use an app password).
        </p>
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <Field label="Mail server" hint="e.g. smtp.gmail.com, smtp.hostinger.com"><Input value={m.smtpHost ?? ""} onChange={(e) => form.set({ smtpHost: e.target.value || null })} aria-label="Mail server" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port"><NumberInput value={m.smtpPort} min={1} step={1} onChange={(n) => form.set({ smtpPort: Math.min(65535, Math.max(1, Math.round(n))) })} aria-label="Port" /></Field>
            <Field label="Security">
              <Select value={m.smtpSecurity} onChange={(e) => form.set({ smtpSecurity: e.target.value as typeof m.smtpSecurity })} aria-label="Security">
                <option value="starttls">STARTTLS (587)</option>
                <option value="ssl">SSL/TLS (465)</option>
                <option value="none">None</option>
              </Select>
            </Field>
          </div>
          <Field label="Username" hint="Usually your email address"><Input value={m.smtpUser ?? ""} onChange={(e) => form.set({ smtpUser: e.target.value || null })} aria-label="Username" autoComplete="off" /></Field>
          <SmtpPassword set={overview.data?.messages?.passwordSet ?? false} onChanged={() => void overview.reload()} />
          <Field label="From name" hint="What customers see, e.g. your garage's name"><Input value={m.fromName ?? ""} onChange={(e) => form.set({ fromName: e.target.value || null })} aria-label="From name" /></Field>
          <Field label="From address"><Input type="email" value={m.fromAddress ?? ""} onChange={(e) => form.set({ fromAddress: e.target.value || null })} aria-label="From address" /></Field>
        </div>
        <TestEmail disabled={form.dirty} />
      </Card>

      <Card title="Reminders">
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <Field label="Payment due soon: days before" hint="Turn on below, under Payment due soon">
            <NumberInput value={m.dueSoonDays} min={1} step={1} onChange={(n) => form.set({ dueSoonDays: Math.min(60, Math.max(1, Math.round(n))) })} aria-label="Days before due" />
          </Field>
          <Field label="Payment overdue: days after" hint="Turn on below, under Payment overdue">
            <NumberInput value={m.overdueDays} min={1} step={1} onChange={(n) => form.set({ overdueDays: Math.min(120, Math.max(1, Math.round(n))) })} aria-label="Days after due" />
          </Field>
        </div>
      </Card>

      <Card title="Messages and their text">
        <p className="mb-3 text-sm text-zinc-600">
          You can use {PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}. WhatsApp always waits for someone to press Send.
        </p>
        <div className="divide-y divide-zinc-100">
          {MESSAGE_EVENTS.map((e) => <EventCard key={e} event={e} value={m[e]} onChange={(patch) => setEvent(e, patch)} />)}
        </div>
      </Card>
    </SectionShell>
  );
}

function EventCard({ event, value: v, onChange }: { event: MessageEvent; value: MessageEventSettings; onChange: (p: Partial<MessageEventSettings>) => void }) {
  const label = EVENT_LABELS[event];
  const reminder = REMINDERS.includes(event);
  const text = (key: "subjectEn" | "textEn", title: string, multi: boolean) => {
    const unknown = unknownPlaceholders(v[key]);
    const error = !v[key].trim() ? "Enter the text" : unknown.length ? `Unknown placeholder ${unknown.map((n) => `{${n}}`).join(", ")}` : null;
    const props = { value: v[key], "aria-label": `${label} — ${title}`, "aria-invalid": !!error };
    return (
      <div>
        <div className="mb-1 text-xs font-medium text-zinc-600">{title}</div>
        {multi ? <Textarea rows={3} {...props} onChange={(e) => onChange({ [key]: e.target.value })} /> : <Input {...props} onChange={(e) => onChange({ [key]: e.target.value })} />}
        {error && <div className="mt-1 text-xs text-red-700">{error}</div>}
      </div>
    );
  };
  return (
    <details className="group py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-1">
        <span>
          <span className="text-sm font-medium text-zinc-900">{label}</span>
          <span className="block text-xs text-zinc-500">{EVENT_HINTS[event]}</span>
        </span>
        <span className={v.on ? "text-xs text-emerald-700" : "text-xs text-zinc-500"}>{v.on ? (v.mode === "auto" ? "Automatic" : "Asks first") : "Off"}</span>
      </summary>
      <div className="mt-3 space-y-3">
        <Toggle label="Send this message" checked={v.on} onChange={(on) => onChange({ on })} />
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <Field label="When">
            <Select value={v.mode} disabled={reminder || event === "statement"} onChange={(e) => onChange({ mode: e.target.value as MessageEventSettings["mode"] })} aria-label={`${label} — when`}>
              <option value="auto">Automatically (email)</option>
              <option value="ask">Ask first</option>
            </Select>
          </Field>
          <Field label="By">
            <Select value={v.channel} disabled={reminder} onChange={(e) => onChange({ channel: e.target.value as MessageEventSettings["channel"] })} aria-label={`${label} — by`}>
              <option value="both">WhatsApp and email</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
            </Select>
          </Field>
        </div>
        <div className="space-y-2">
          {text("subjectEn", "Email subject", false)}
          {text("textEn", "Text", true)}
        </div>
      </div>
    </details>
  );
}

/** The mailbox password: never shown or sent back; "Set" / "Not set" and a way to replace it. */
function SmtpPassword({ set, onChanged }: { set: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put("/api/settings/messages/password", { password: value });
      toast.success("Password saved");
      setEditing(false);
      setValue("");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Not a <Field>: its <label> would name the buttons inside it.
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-medium text-zinc-700">Password</span>
      {editing ? (
        <div className="flex gap-2">
          <PasswordField label="New password" hideLabel className="flex-1" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" autoFocus />
          <Button variant="primary" busy={busy} disabled={!value} onClick={() => void save()}>Save password</Button>
          <Button onClick={() => { setEditing(false); setValue(""); }}>Cancel</Button>
        </div>
      ) : (
        <div className="flex h-9 items-center gap-3">
          <span data-testid="smtp-password" className={set ? "text-sm text-emerald-700" : "text-sm text-amber-700"}>{set ? "Set" : "Not set"}</span>
          <Button size="sm" onClick={() => setEditing(true)}>{set ? "Replace password" : "Set password"}</Button>
        </div>
      )}
    </div>
  );
}

/** Queues a real test email (through the real sender: this PC, the main computer or the cloud) and follows it. */
function TestEmail({ disabled }: { disabled: boolean }) {
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  useEffect(() => {
    if (!message || (message.status !== "queued" && message.status !== "sending")) return;
    const timer = setTimeout(() => void get<{ message: Message }>(`/api/messages/${message.id}`).then((r) => setMessage(r.message), () => undefined), 1500);
    return () => clearTimeout(timer);
  }, [message]);
  const send = async () => {
    try {
      setMessage((await post<{ message: Message }>("/api/messages/test", { to })).message);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const status = !message ? null
    : message.status === "sent" ? "Sent"
    : message.status === "failed" ? `Failed: ${message.error ?? "unknown error"}`
    : message.status === "queued" && message.attempts > 0 ? `Trying again: ${message.error ?? ""}`
    : "Sending…";
  return (
    <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-zinc-100 pt-4">
      <Field label="Send a test to" className="min-w-64 flex-1">
        <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send a test to" placeholder="you@example.com" />
      </Field>
      <Button disabled={!to || disabled} onClick={() => void send()} title={disabled ? "Save your changes first" : undefined}>Send test email</Button>
      {status && (
        <span data-testid="test-email-status" className={message?.status === "sent" ? "text-sm text-emerald-700" : message?.status === "failed" ? "text-sm text-red-700" : "text-sm text-zinc-600"}>
          {status}
        </span>
      )}
    </div>
  );
}
