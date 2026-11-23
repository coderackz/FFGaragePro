import { checkEmail, checkPhone, type ContactInput } from "@ffgp/shared";
import { Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { del, patch, post } from "../lib/api";
import { formatDate } from "../lib/format";
import type { Contact } from "../lib/types";
import { useApi } from "../lib/useApi";
import { Button, Empty, Field, Input, Modal, Select, Table } from "./ui";
import { EmailField, firstProblem, PhoneField } from "./fields";

const GETS: { key: "getsApprovals" | "getsInvoices" | "getsReady" | "getsStatements"; label: string; short: string }[] = [
  { key: "getsApprovals", label: "Approvals (estimates)", short: "Approvals" },
  { key: "getsInvoices", label: "Invoices & receipts", short: "Invoices" },
  { key: "getsReady", label: "Vehicle received / ready", short: "Vehicle ready" },
  { key: "getsStatements", label: "Statements", short: "Statements" },
];

const blank: ContactInput = {
  name: "", phone: null, email: null, language: "en", getsApprovals: false, getsInvoices: false, getsReady: false, getsStatements: false, marketingConsent: false,
};

/** A customer's contacts: who gets approvals, invoices, "vehicle ready" and statements. */
export function ContactsPanel({ customerId }: { customerId: string }) {
  const { data, reload } = useApi<{ contacts: Contact[] }>(`/api/customers/${customerId}/contacts`);
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-sm text-zinc-600">Who gets which messages. Without a ticked contact, a company's own phone and email are used.</p>
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEditing("new")}>Add contact</Button>
      </div>
      <div data-testid="contacts">
        <Table
          rows={data?.contacts ?? []}
          rowKey={(c) => c.id}
          onRowClick={(c) => setEditing(c)}
          empty={<Empty icon={<Users className="size-9" />} title="No contacts yet" />}
          columns={[
            { header: "Name", cell: (c) => <span className="font-medium">{c.name}</span> },
            { header: "Phone", cell: (c) => c.phone ?? "—" },
            { header: "Email", cell: (c) => c.email ?? "—" },
            { header: "Language", cell: (c) => (c.language === "ar" ? "Arabic" : "English") },
            { header: "Gets", cell: (c) => GETS.filter((g) => c[g.key]).map((g) => g.short).join(" · ") || "—" },
            { header: "Marketing", cell: (c) => (c.marketingConsentAt ? `Yes, since ${formatDate(c.marketingConsentAt)}` : "No") },
          ]}
        />
      </div>
      <ContactModal
        customerId={customerId}
        contact={editing === "new" ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => void reload()}
      />
    </div>
  );
}

function ContactModal({ customerId, contact, open, onClose, onSaved }: {
  customerId: string; contact: Contact | null; open: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [v, setV] = useState<ContactInput>(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setV(contact ? { ...contact, marketingConsent: !!contact.marketingConsentAt } : blank);
  }, [open, contact]);
  const set = (p: Partial<ContactInput>) => setV((x) => ({ ...x, ...p }));

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const problem = firstProblem([[contact?.phone, v.phone, checkPhone], [contact?.email, v.email, checkEmail]]);
    if (problem) return void toast.error(problem);
    return run(() => (contact ? patch(`/api/contacts/${contact.id}`, v) : post(`/api/customers/${customerId}/contacts`, v)), "Contact saved");
  };
  const remove = () => {
    if (contact && window.confirm(`Remove ${contact.name}?`)) void run(() => del(`/api/contacts/${contact.id}`), "Contact removed");
  };

  return (
    <Modal open={open} onClose={onClose} title={contact ? `Edit ${contact.name}` : "New contact"}
      footer={
        <>
          {contact && <Button variant="ghost" className="mr-auto text-red-700" onClick={remove}>Remove</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!v.name.trim()} onClick={() => void save()}>Save contact</Button>
        </>
      }>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name" className="col-span-2"><Input value={v.name} onChange={(e) => set({ name: e.target.value })} aria-label="Name" autoFocus /></Field>
        <PhoneField label="Phone" hint="WhatsApp number, e.g. 050 123 4567" before={contact?.phone} value={v.phone ?? ""} onChange={(x) => set({ phone: x || null })} />
        <EmailField label="Email" before={contact?.email} value={v.email ?? ""} onChange={(x) => set({ email: x || null })} />
        <Field label="Message language">
          <Select value={v.language} onChange={(e) => set({ language: e.target.value as ContactInput["language"] })} aria-label="Message language">
            <option value="en">English</option>
            <option value="ar">Arabic</option>
          </Select>
        </Field>
        <fieldset className="col-span-2">
          <legend className="mb-1.5 text-sm font-medium text-zinc-800">Gets</legend>
          <div className="grid grid-cols-2 gap-2">
            {GETS.map((g) => (
              <label key={g.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={v[g.key]} onChange={(e) => set({ [g.key]: e.target.checked })} /> {g.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="col-span-2 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={v.marketingConsent} onChange={(e) => set({ marketingConsent: e.target.checked })} />
          <span>Agrees to service reminders and offers<span className="block text-xs text-zinc-500">Messages about their jobs and account don't need this.</span></span>
        </label>
      </div>
    </Modal>
  );
}
