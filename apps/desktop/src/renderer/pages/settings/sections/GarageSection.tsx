import { useEffect, useState } from "react";
import { toast } from "sonner";
import { checkEmail, checkIban, checkPhone, checkTrn, EMPTY_ADDRESS, type AddressParts } from "@ffgp/shared";
import { Card, Field, Input, Textarea } from "../../../components/ui";
import { AddressFields, EmailField, firstProblem, IbanField, PhoneField, TrnField } from "../../../components/fields";
import { patch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

type Profile = { name: string; trn: string; addressParts: AddressParts; phone: string; email: string };
type TextKey = Exclude<keyof Profile, "addressParts">;

/** Garage details: the profile printed on every document, plus trade licence and bank details. */
export function GarageSection() {
  const { garage, settings, refreshGarage } = useAuth();
  const extra = useSectionForm("garage");
  const fromGarage = (): Profile => ({ name: garage?.name ?? "", trn: garage?.trn ?? "", addressParts: garage?.addressParts ?? EMPTY_ADDRESS, phone: garage?.phone ?? "", email: garage?.email ?? "" });
  const [profile, setProfile] = useState<Profile>(fromGarage);
  const [busy, setBusy] = useState(false);
  useEffect(() => setProfile(fromGarage()), [garage]); // eslint-disable-line react-hooks/exhaustive-deps
  const profileDirty = JSON.stringify(profile) !== JSON.stringify(fromGarage());

  const save = async () => {
    const trn = profile.trn.replace(/\s/g, "");
    const problem = firstProblem([
      [garage?.trn, trn, checkTrn], [garage?.phone, profile.phone, checkPhone], [garage?.email, profile.email, checkEmail], [settings?.garage.iban, extra.value.iban, checkIban],
    ]);
    if (problem) return void toast.error(problem);
    if (!profile.name.trim()) return void toast.error("Garage name is required");
    setBusy(true);
    try {
      if (profileDirty) await patch("/api/settings", { ...profile, trn });
      // Re-read once, at the end: in between it would put back what isn't saved yet.
      if (extra.dirty) return void (await extra.save());
      await refreshGarage();
      toast.success("Saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const f = (k: TextKey) => ({ value: profile[k], onChange: (e: { target: { value: string } }) => setProfile({ ...profile, [k]: e.target.value }) });
  const box = (k: TextKey) => ({ value: profile[k], onChange: (v: string) => setProfile((x) => ({ ...x, [k]: v })) });
  const e = extra.value;

  return (
    <SectionShell title="Garage details" subtitle="Printed at the top of every document" dirty={profileDirty || extra.dirty} busy={busy || extra.busy} onSave={() => void save()}>
      <Card title="Profile">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Garage name" className="sm:col-span-2"><Input {...f("name")} /></Field>
          <TrnField label="VAT TRN" hint="15 digits. Printed on tax invoices." before={garage?.trn} {...box("trn")} />
          <Field label="Trade licence no."><Input value={e.tradeLicence ?? ""} onChange={(ev) => extra.set({ tradeLicence: ev.target.value })} /></Field>
          <PhoneField label="Phone" before={garage?.phone} {...box("phone")} />
          <EmailField label="Email" before={garage?.email} {...box("email")} />
          {/* One emirate: the address's and the VAT return's (kept in the settings). */}
          <AddressFields className="sm:col-span-2" value={{ ...profile.addressParts, emirate: e.emirate ?? null }} emirateHint="Its row in box 1 of the VAT return"
            onChange={({ emirate, ...parts }) => {
              if (emirate !== (e.emirate ?? null)) extra.set({ emirate });
              setProfile((x) => ({ ...x, addressParts: { ...parts, emirate: x.addressParts.emirate } }));
            }} />
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
          <IbanField label="IBAN" hint="AE followed by 21 digits" className="sm:col-span-2" before={settings?.garage.iban} value={e.iban ?? ""} onChange={(v) => extra.set({ iban: v })} />
        </div>
      </Card>
    </SectionShell>
  );
}
