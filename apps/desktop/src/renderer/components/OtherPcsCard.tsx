import { useState } from "react";
import { Monitor, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { del, post, put } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useApi } from "../lib/useApi";
import { Badge, Button, Card } from "./ui";

interface Network {
  sharing: boolean;
  port: number;
  listening: boolean;
  error: string | null;
  addresses: string[];
  pairing: { code: string; expiresAt: string } | null;
  devices: { id: string; name: string; createdAt: string; lastSeenAt: string | null }[];
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Settings → Other PCs. Main computer: sharing, pairing codes, paired PCs. Connected PC: which main computer. */
export function OtherPcsCard() {
  const bridge = window.ffgp;
  if (!bridge) return null; // browser development mode: no main process to restart
  if (bridge.mode === "client") return <ConnectedPcCard />;
  return <MainComputerCard />;
}

function ConnectedPcCard() {
  const main = window.ffgp!.mainComputer!;
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    if (!window.confirm(`Disconnect this PC from ${main.garageName}? You'll need a new pairing code to connect again.`)) return;
    setBusy(true);
    await window.ffgp!.disconnect();
  };
  return (
    <Card title="Other PCs" className="mt-5 max-w-3xl">
      <div className="flex items-center justify-between gap-4 text-sm">
        <div>
          This PC is connected to <b>{main.garageName}</b>'s main computer at <b>{main.host}</b>. All data is kept on the main computer.
        </div>
        <Button busy={busy} onClick={() => void disconnect()}>Disconnect this PC</Button>
      </div>
    </Card>
  );
}

function MainComputerCard() {
  const { data: net, reload, setData } = useApi<Network>("/api/network");
  const [busy, setBusy] = useState<string | null>(null);

  const setSharing = async (enabled: boolean) => {
    if (!enabled && !window.confirm("Turn off sharing? The other PCs will stop working until you turn it back on.")) return;
    setBusy("sharing");
    try {
      await put("/api/network/sharing", { enabled });
      await window.ffgp!.applyNetwork(); // restarts the server; the window reloads
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(null);
    }
  };
  const newCode = async () => {
    setBusy("code");
    try {
      const pairing = await post<{ code: string; expiresAt: string }>("/api/network/pairing-code");
      if (net) setData({ ...net, pairing });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (d: Network["devices"][number]) => {
    if (!window.confirm(`Remove "${d.name}"? It will stop working until it's paired again.`)) return;
    try {
      await del(`/api/network/devices/${d.id}`);
      toast.success(`${d.name} removed`);
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (!net) return <Card title="Other PCs" className="mt-5 max-w-3xl"><div className="text-sm text-zinc-500">Loading…</div></Card>;

  if (!net.sharing) {
    return (
      <Card title="Other PCs" className="mt-5 max-w-3xl">
        <div className="flex items-center justify-between gap-6 text-sm">
          <div className="text-zinc-600">
            Only this PC uses the garage's data. Turn on sharing to make this the <b>main computer</b>, so other PCs in the garage can
            work on the same customers, job cards and invoices. This PC must then stay on during the working day.
          </div>
          <Button variant="primary" busy={busy === "sharing"} onClick={() => void setSharing(true)}>Share with other PCs</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={<span className="flex items-center gap-2">Other PCs <Badge tone={net.listening ? "brand" : "red"}>{net.listening ? "Sharing on" : "Not reachable"}</Badge></span>}
      className="mt-5 max-w-3xl"
      actions={<Button size="sm" variant="ghost" busy={busy === "sharing"} onClick={() => void setSharing(false)}>Turn off sharing</Button>}
    >
      <div className="flex flex-col gap-5 text-sm">
        {net.error && <div className="rounded-md bg-red-50 px-3 py-2 text-red-700">{net.error}</div>}
        {net.listening && (
          <div>
            This is the <b>main computer</b>. Other PCs connect to it at{" "}
            {net.addresses.length ? net.addresses.map((a, i) => <span key={a}>{i > 0 && " or "}<b className="font-mono" data-testid="lan-address">{a}</b></span>) : <b>this PC's network address</b>}
            {net.port !== 47820 && <b className="font-mono">:{net.port}</b>}.
            <div className="mt-1 text-xs text-zinc-500">
              If Windows asks, allow Fleetfix Garage Pro on <b>private networks</b>. If other PCs can't find this one, set this network to
              Private in Windows Settings → Network & internet.
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 px-4 py-3">
          {net.pairing ? (
            <div>
              <div className="text-xs text-zinc-500">Pairing code — enter it on the new PC</div>
              <div className="font-mono text-3xl font-semibold tracking-[0.3em]" data-testid="pairing-code">{net.pairing.code}</div>
              <div className="text-xs text-zinc-500">Valid until {time(net.pairing.expiresAt)}, for one PC.</div>
            </div>
          ) : (
            <div className="text-zinc-600">To add a PC: install Fleetfix Garage Pro on it, choose <b>Connect to main computer</b>, and enter a pairing code from here.</div>
          )}
          <Button variant={net.pairing ? "secondary" : "primary"} busy={busy === "code"} onClick={() => void newCode()}>
            {net.pairing ? "New code" : "Pair a new PC"}
          </Button>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold tracking-wider text-zinc-500 uppercase">Paired PCs</div>
          {net.devices.length === 0 ? (
            <div className="text-zinc-500">No other PCs yet.</div>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
              {net.devices.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Monitor className="size-4 text-zinc-500" />
                  <div className="flex-1">
                    <div className="font-medium">{d.name}</div>
                    <div className="text-xs text-zinc-500">Paired {formatDateTime(d.createdAt)} · last used {d.lastSeenAt ? formatDateTime(d.lastSeenAt) : "never"}</div>
                  </div>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(d)} aria-label={`Remove ${d.name}`}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
