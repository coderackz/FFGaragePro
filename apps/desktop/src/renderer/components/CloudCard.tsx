import { useEffect, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { formatDate, formatDateTime } from "../lib/format";
import { CloudConnectDialog } from "./CloudConnectDialog";
import { SyncIssues } from "./SyncIssues";
import { Badge, Button, Card } from "./ui";

/** The PC's link to Fleetfix cloud, kept current by the main process's sync loop. */
export function useCloudStatus(): CloudStatus | null {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  useEffect(() => {
    const bridge = window.ffgp;
    if (!bridge) return;
    void bridge.cloudStatus().then(setStatus);
    return bridge.onCloudStatus(setStatus);
  }, []);
  return status;
}

/** Settings → Fleetfix cloud (PC app, Owners): connect, sync status, licence, sync issues, disconnect. */
export function CloudCard() {
  const bridge = window.ffgp;
  const status = useCloudStatus();
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<"sync" | "unlink" | null>(null);
  if (!bridge || bridge.mode === "client" || !status) return null;

  if (!status.linked) {
    return (
      <Card title="Fleetfix cloud" className="mt-5 max-w-3xl">
        <div className="flex items-center justify-between gap-4 text-sm">
          <div className="text-zinc-600">
            Keep this garage in Fleetfix cloud: open it in a browser from home or on a tablet, and keep a copy safe off this PC. This PC keeps working without internet and catches up when it's back.
          </div>
          <Button icon={<Cloud className="size-4" />} onClick={() => setConnecting(true)}>Connect to Fleetfix cloud</Button>
        </div>
        {connecting && <CloudConnectDialog mode="upload" onClose={() => setConnecting(false)} />}
      </Card>
    );
  }

  const syncNow = async () => {
    setBusy("sync");
    const r = await bridge.cloudSyncNow();
    setBusy(null);
    if (r.ok) toast.success("Synced with Fleetfix cloud");
    else toast.error(r.message ?? "Couldn't sync");
  };
  const unlink = async () => {
    const waiting = status.pending ? ` ${status.pending} change${status.pending === 1 ? " hasn't" : "s haven't"} reached the cloud yet and will stay on this PC only.` : "";
    if (!window.confirm(`Disconnect this PC from Fleetfix cloud? The garage's data stays on this PC, but changes will no longer sync.${waiting}`)) return;
    setBusy("unlink");
    await bridge.cloudUnlink();
  };
  const l = status.licence;
  const error = status.lastError;

  return (
    <>
      <Card
        title="Fleetfix cloud"
        className="mt-5 max-w-3xl"
        actions={<Button size="sm" icon={<RefreshCw className="size-4" />} busy={busy === "sync" || status.syncing} onClick={() => void syncNow()}>Sync now</Button>}
      >
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm" data-testid="cloud-card">
          <dt className="text-zinc-500">Linked to</dt>
          <dd><b className="font-mono">{status.garageCode}</b> as <b>{status.deviceCode}</b></dd>
          <dt className="text-zinc-500">Last sync</dt>
          <dd>
            {status.lastSyncAt ? formatDateTime(status.lastSyncAt) : "Not yet"}
            {status.pending > 0 && <span className="ml-2"><Badge>{status.pending} change{status.pending === 1 ? "" : "s"} waiting</Badge></span>}
          </dd>
          <dt className="text-zinc-500">Licence</dt>
          <dd>
            {l.readOnly ? (
              <span className="text-red-700">
                {l.reason === "not_checked" ? "Read-only: this PC hasn't reached Fleetfix cloud for 30 days." : "Read-only: the subscription has ended."}
              </span>
            ) : (
              <>{l.state === "trial" ? "Free trial until" : l.state === "grace" ? "Ended — read-only after" : "Paid until"} {formatDate(l.state === "grace" ? l.graceEndsAt : l.endsAt)}</>
            )}
          </dd>
        </dl>
        {error && (
          <div role="alert" className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {error.reason === "update_app" ? "Update Fleetfix Garage Pro to keep syncing" : error.message}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button size="sm" busy={busy === "unlink"} onClick={() => void unlink()}>Disconnect from cloud</Button>
        </div>
      </Card>
      <SyncIssues refreshKey={status.issues} />
    </>
  );
}
