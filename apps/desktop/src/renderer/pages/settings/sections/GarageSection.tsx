import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, Field, Input, Textarea } from "../../../components/ui";
import { patch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

type Profile = { name: string; trn: string; address: string; phone: string; email: string };

/** Garage details: the profile printed on every document, plus trade licence and bank details. */
export function GarageSection() {
  const { garage, refreshGarage } = useAuth();
  const extra = useSectionForm("garage");
  const fromGarage = (): Profile => ({ name: garage?.name ?? "", trn: garage?.trn ?? "", address: garage?.address ?? "", phone: garage?.phone ?? "", email: garage?.email ?? "" });
  const [profile, setProfile] = useState<Profile>(fromGarage);
  const [busy, setBusy] = useState(false);
  useEffect(() => setProfile(fromGarage()), [garage]); // eslint-disable-line react-hooks/exhaustive-deps
  const profileDirty = JSON.stringify(profile) !== JSON.stringify(fromGarage());

  const save = async () => {
    const trn = profile.trn.replace(/\s/g, "");
    if (trn && !/^\d{15}$/.test(trn)) return void toast.error("A UAE TRN has 15 digits");
    if (!profile.name.trim()) return void toast.error("Garage name is required");
    setBusy(true);
    try {
      if (profileDirty) {
        await patch("/api/settings", { ...profile, trn });
        await refreshGarage();
      }
      if (extra.dirty && !(await extra.save())) return;
      if (profileDirty && !extra.dirty) toast.success("Saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const f = (k: keyof Profile) => ({ value: profile[k], onChange: (e: { target: { value: string } }) => setProfile({ ...profile, [k]: e.target.value }) });
  const e = extra.value;

  return (
    <SectionShell title="Garage details" subtitle="Printed at the top of every document" dirty={profileDirty || extra.dirty} busy={busy || extra.busy} onSave={() => void save()}>
      <Card title="Profile">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Garage name" className="sm:col-span-2"><Input {...f("name")} /></Field>
          <Field label="VAT TRN" hint="15 digits. Printed on tax invoices."><Input {...f("trn")} inputMode="numeric" /></Field>
          <Field label="Trade licence no."><Input value={e.tradeLicence ?? ""} onChange={(ev) => extra.set({ tradeLicence: ev.target.value })} /></Field>
          <Field label="Phone"><Input {...f("phone")} /></Field>
          <Field label="Email"><Input {...f("email")} type="email" /></Field>
          <Field label="Address" className="sm:col-span-2"><Textarea {...f("address")} rows={3} /></Field>
        </div>
      </Card>
      <Card title="Arabic" actions={<span className="text-sm text-zinc-500">Printed on English + Arabic documents</span>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Arabic name" className="sm:col-span-2">
            <Input value={e.nameAr ?? ""} onChange={(ev) => extra.set({ nameAr: ev.target.value })} dir="rtl" lang="ar" />
          </Field>
          <Field label="Arabic address" className="sm:col-span-2">
            <Textarea value={e.addressAr ?? ""} onChange={(ev) => extra.set({ addressAr: ev.target.value })} rows={2} dir="rtl" lang="ar" />
          </Field>
        </div>
      </Card>
      <Card title="Bank details" actions={<span className="text-sm text-zinc-500">Printed at the foot of invoices</span>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bank"><Input value={e.bankName ?? ""} onChange={(ev) => extra.set({ bankName: ev.target.value })} placeholder="e.g. Emirates NBD" /></Field>
          <Field label="Account name"><Input value={e.accountName ?? ""} onChange={(ev) => extra.set({ accountName: ev.target.value })} /></Field>
          <Field label="IBAN" hint="AE followed by 21 digits" className="sm:col-span-2">
            <Input value={e.iban ?? ""} onChange={(ev) => extra.set({ iban: ev.target.value })} placeholder="AE07 0260 0010 1234 5678 901" autoCapitalize="characters" />
          </Field>
        </div>
      </Card>
    </SectionShell>
  );
}
