import { useState, type FormEvent } from "react";
import { AuthShell } from "../components/AuthShell";
import { Button, Field, Input } from "../components/ui";
import { getGarageCode, isCloud } from "../lib/api";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { signIn, changeGarage } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-zinc-500">Use the username your garage owner gave you.</p>
      {isCloud && (
        <p className="mt-3 flex items-center justify-between rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
          <span>Garage <b className="font-mono text-zinc-700">{getGarageCode()}</b></span>
          <button type="button" onClick={changeGarage} className="text-brand-700 hover:underline">Change</button>
        </p>
      )}
      {window.ffgp?.mainComputer && (
        <p className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
          Connected to <b className="text-zinc-700">{window.ffgp.mainComputer.garageName}</b> · main computer {window.ffgp.mainComputer.host}
        </p>
      )}
      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <Button type="submit" variant="primary" busy={busy} disabled={!username || !password} className="mt-2 h-10">
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
