import { useState, type FormEvent } from "react";
import { AuthShell } from "../components/AuthShell";
import { Button, Field, Input } from "../components/ui";
import { useAuth } from "../lib/auth";

/** Fleetfix Cloud: which garage to open. Remembered in this browser. */
export function GaragePage({ error: initialError }: { error?: string }) {
  const { chooseGarage } = useAuth();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(chooseGarage(code));
  };

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">Open your garage</h1>
      <p className="mt-1 text-sm text-zinc-500">Your garage ID is in the welcome message from Fleet Fix.</p>
      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <Field label="Garage ID">
          <Input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoCapitalize="none" autoComplete="organization" placeholder="e.g. alquoz-auto" />
        </Field>
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <Button type="submit" variant="primary" disabled={!code.trim()} className="mt-2 h-10">Continue</Button>
      </form>
    </AuthShell>
  );
}
