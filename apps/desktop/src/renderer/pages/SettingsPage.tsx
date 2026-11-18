import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OtherPcsCard } from "../components/OtherPcsCard";
import { isCloud } from "../lib/api";
import { Button, Card, Field, Input, PageHeader, Textarea } from "../components/ui";
import { patch } from "../lib/api";
import { useAuth } from "../lib/auth";

export function SettingsPage() {
  const { garage, refreshGarage } = useAuth();
  const [form, setForm] = useState({ name: "", trn: "", address: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (garage) setForm({ name: garage.name, trn: garage.trn ?? "", address: garage.address ?? "", phone: garage.phone ?? "", email: garage.email ?? "" });
  }, [garage]);

  const save = async () => {
    if (form.trn && !/^\d{15}$/.test(form.trn.replace(/\s/g, ""))) return toast.error("A UAE TRN has 15 digits");
    setBusy(true);
    try {
      await patch("/api/settings", { ...form, trn: form.trn.replace(/\s/g, "") });
      await refreshGarage();
      toast.success("Garage details saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <>
      <PageHeader title="Settings" subtitle="Your garage's details, printed on every document" actions={<Button variant="primary" busy={busy} onClick={() => void save()}>Save changes</Button>} />
      <Card title="Garage profile" className="max-w-3xl">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Garage name" className="col-span-2"><Input {...f("name")} /></Field>
          <Field label="VAT TRN" hint="15 digits. Printed on tax invoices."><Input {...f("trn")} inputMode="numeric" /></Field>
          <Field label="Phone"><Input {...f("phone")} /></Field>
          <Field label="Email" className="col-span-2"><Input {...f("email")} type="email" /></Field>
          <Field label="Address" className="col-span-2"><Textarea {...f("address")} rows={3} /></Field>
        </div>
      </Card>
      <Card title="Tax" className="mt-5 max-w-3xl">
        <div className="text-sm text-zinc-600">VAT is charged at <b>{(garage?.vatRateBp ?? 500) / 100}%</b> on every line (UAE standard rate).</div>
      </Card>
      {!isCloud && <OtherPcsCard />}
    </>
  );
}
