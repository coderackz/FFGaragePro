import { useState, type FormEvent } from "react";
import { AuthShell } from "../components/AuthShell";
import { Button, Field, Input, Textarea } from "../components/ui";
import { useAuth } from "../lib/auth";

export function SetupPage() {
  const { completeSetup, startConnect } = useAuth();
  const [garage, setGarage] = useState({ name: "", trn: "", address: "", phone: "", email: "" });
  const [owner, setOwner] = useState({ name: "", username: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (owner.password !== owner.confirm) return setError("The two passwords don't match");
    if (garage.trn && !/^\d{15}$/.test(garage.trn.replace(/\s/g, ""))) return setError("A UAE TRN has 15 digits");
    setBusy(true);
    setError(null);
    try {
      await completeSetup({
        garage: { ...garage, trn: garage.trn.replace(/\s/g, "") },
        owner: { name: owner.name, username: owner.username.trim(), password: owner.password },
      });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const g = (k: keyof typeof garage) => ({ value: garage[k], onChange: (e: { target: { value: string } }) => setGarage({ ...garage, [k]: e.target.value }) });
  const o = (k: keyof typeof owner) => ({ value: owner[k], onChange: (e: { target: { value: string } }) => setOwner({ ...owner, [k]: e.target.value }) });

  return (
    <AuthShell wide>
      {window.ffgp && (
        <div className="mb-7 flex items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm">
          <div>
            <div className="font-medium">Already using Fleetfix Garage Pro on another PC?</div>
            <div className="text-zinc-500">Connect this PC to your garage's main computer instead of setting up a new garage.</div>
          </div>
          <Button type="button" onClick={startConnect}>Connect to main computer</Button>
        </div>
      )}
      <h1 className="text-2xl font-semibold tracking-tight">Set up your garage</h1>
      <p className="mt-1 text-sm text-zinc-500">This appears on your estimates, job cards and tax invoices. You can change it later in Settings.</p>
      <form onSubmit={submit} className="mt-7 flex flex-col gap-7">
        <fieldset className="grid grid-cols-2 gap-4">
          <legend className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">Garage</legend>
          <Field label="Garage name" className="col-span-2">
            <Input {...g("name")} autoFocus required placeholder="e.g. Al Quoz Auto Care" />
          </Field>
          <Field label="VAT TRN" hint="15 digits. Leave blank if not VAT registered.">
            <Input {...g("trn")} inputMode="numeric" placeholder="100XXXXXXXXXXX3" />
          </Field>
          <Field label="Phone">
            <Input {...g("phone")} placeholder="+971 4 …" />
          </Field>
          <Field label="Email" className="col-span-2">
            <Input {...g("email")} type="email" />
          </Field>
          <Field label="Address" className="col-span-2">
            <Textarea {...g("address")} rows={2} className="min-h-0" />
          </Field>
        </fieldset>
        <fieldset className="grid grid-cols-2 gap-4">
          <legend className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">Owner account</legend>
          <Field label="Your name">
            <Input {...o("name")} required />
          </Field>
          <Field label="Username" hint="Used to sign in.">
            <Input {...o("username")} required autoComplete="username" />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <Input {...o("password")} type="password" required autoComplete="new-password" />
          </Field>
          <Field label="Confirm password">
            <Input {...o("confirm")} type="password" required autoComplete="new-password" />
          </Field>
        </fieldset>
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" busy={busy} className="h-10 px-6">
            Create garage
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
