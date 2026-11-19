import { FolderOpen, HardDriveDownload, History } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Card, Field, Select, Spinner } from "../../../components/ui";
import { formatDateTime } from "../../../lib/format";
import type { BackupStatus } from "../../../lib/types";
import { SectionShell } from "../SectionShell";
import { ago } from "../tiles";

const KEEP = [7, 14, 30, 60, 90, 180, 365];

/** PC holding the garage: where the daily copy goes, how long it's kept, back up now, restore. */
export function BackupsSection() {
  const bridge = window.ffgp;
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<"now" | "folder" | "restore" | null>(null);
  useEffect(() => {
    void bridge?.backupStatus().then(setStatus);
  }, [bridge]);
  if (!bridge) return null;
  if (!status) return <Spinner />;

  const run = async (name: "now" | "folder" | "restore", fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  const backUp = () => run("now", async () => {
    const res = await bridge.backupNow();
    if (res.error) toast.error(res.error);
    else toast.success("Backed up", { description: res.file });
    setStatus(await bridge.backupStatus());
  });
  const chooseFolder = () => run("folder", async () => {
    const next = await bridge.backupChooseFolder();
    if (next) setStatus(next);
  });
  const restore = () => run("restore", async () => {
    const res = await bridge.restore();
    if (res.error) toast.error(res.error);
  });

  const lastText = !status.folderOk ? "The backup folder can't be found (is the USB drive plugged in?)"
    : status.last ? `Last backup ${ago(status.last)} (${formatDateTime(status.last)})` : "No backup yet";
  return (
    <SectionShell title="Backups" subtitle="A full copy of this PC's garage, every day">
      <Card title="Status">
        <div className={status.folderOk && status.last ? "text-sm text-zinc-800" : "text-sm font-medium text-red-700"} data-testid="backup-status">{lastText}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" icon={<HardDriveDownload className="size-4" />} busy={busy === "now"} onClick={() => void backUp()}>Back up now</Button>
        </div>
      </Card>
      <Card title="Where and how long">
        <div className="space-y-4">
          <Field label="Backup folder" hint="A USB drive or a synced folder (OneDrive, Google Drive) keeps a copy off this PC">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-800 ring-1 ring-zinc-200" title={status.folder}>{status.folder}</code>
              <Button icon={<FolderOpen className="size-4" />} busy={busy === "folder"} onClick={() => void chooseFolder()}>Change</Button>
            </div>
          </Field>
          <Field label="Keep backups for" className="max-w-xs">
            <Select value={String(status.keepDays)} onChange={(e) => void bridge.backupSetKeepDays(Number(e.target.value)).then(setStatus)}>
              {[...new Set([...KEEP, status.keepDays])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{d} days</option>)}
            </Select>
          </Field>
        </div>
      </Card>
      <Card title="Restore">
        <p className="text-sm text-zinc-700">
          Replace this PC's garage with a backup. Today's data is backed up first, so nothing is lost. Everyone on this garage's other PCs
          should save their work first; the app restarts afterwards.
        </p>
        <Button className="mt-3" icon={<History className="size-4" />} busy={busy === "restore"} onClick={() => void restore()}>Restore from a backup…</Button>
      </Card>
    </SectionShell>
  );
}
