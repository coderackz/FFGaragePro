import { useEffect, useState, type FormEvent } from "react";
import { Monitor, RefreshCw } from "lucide-react";
import { AuthShell } from "../components/AuthShell";
import { Button, Field, Input } from "../components/ui";
import { useAuth } from "../lib/auth";

type Found = { host: string; port: number; name: string };

/** A second PC joins the garage: find (or type) the main computer, enter the pairing code once. */
export function ConnectPage() {
  const { retry } = useAuth();
  const bridge = window.ffgp!;
  const [found, setFound] = useState<Found[] | null>(null);
  const [host, setHost] = useState(bridge.mainComputer?.host ?? "");
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(bridge.hostname);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setFound(null);
    const list = await bridge.discover().catch(() => []);
    setFound(list);
    if (list.length === 1 && !host) setHost(list[0]!.host + (list[0]!.port === 47820 ? "" : `:${list[0]!.port}`));
  };
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await bridge.connect({ host, code: code.trim(), deviceName: deviceName.trim() }).catch((err: Error) => ({ error: err.message }));
    if (result.error) {
      setError(result.error);
      setBusy(false);
    }
    // On success the app reloads itself, now talking to the main computer.
  };

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">Connect to the main computer</h1>
      <p className="mt-1 text-sm text-zinc-500">
        On the main computer, open <b>Settings → Other PCs</b>, turn on sharing and click <b>Pair a new PC</b> to get a code.
      </p>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between text-xs font-semibold tracking-wider text-zinc-500 uppercase">
          Found on this network
          <button type="button" onClick={() => void search()} className="flex items-center gap-1 font-medium tracking-normal text-brand-700 normal-case hover:underline">
            <RefreshCw className="size-3" /> Search again
          </button>
        </div>
        {found === null ? (
          <div className="rounded-md border border-dashed border-zinc-200 px-3 py-3 text-sm text-zinc-500">Looking for the main computer…</div>
        ) : found.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-200 px-3 py-3 text-sm text-zinc-500">
            None found. Type the address shown on the main computer below.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {found.map((f) => {
              const value = f.host + (f.port === 47820 ? "" : `:${f.port}`);
              return (
                <li key={`${f.host}:${f.port}`}>
                  <button
                    type="button"
                    onClick={() => setHost(value)}
                    className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm ${host === value ? "border-brand-600 bg-brand-50" : "border-zinc-200 hover:bg-zinc-50"}`}
                  >
                    <Monitor className="size-4 text-zinc-500" />
                    <span className="font-medium">{f.name}</span>
                    <span className="ml-auto text-zinc-500">{f.host}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <Field label="Main computer address" hint="Shown on the main computer, e.g. 192.168.1.20">
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.20" />
        </Field>
        <Field label="Pairing code" hint="6 digits, valid for 10 minutes.">
          <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" className="font-mono tracking-[0.3em]" />
        </Field>
        <Field label="Name for this PC" hint="So the owner can tell the PCs apart, e.g. Front desk.">
          <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </Field>
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <Button type="submit" variant="primary" busy={busy} disabled={!host.trim() || code.length !== 6 || !deviceName.trim()} className="mt-2 h-10">
          Connect
        </Button>
        {bridge.mode !== "client" && (
          <button type="button" onClick={retry} className="text-sm text-zinc-500 hover:text-zinc-800 hover:underline">
            Back — set up a new garage on this PC instead
          </button>
        )}
      </form>
    </AuthShell>
  );
}
