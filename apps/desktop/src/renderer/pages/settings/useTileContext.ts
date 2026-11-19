import { useEffect, useState } from "react";
import { useCloudStatus } from "../../components/CloudCard";
import { isCloud } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { BackupStatus } from "../../lib/types";
import { useApi } from "../../lib/useApi";
import type { TileContext } from "./tiles";

/** Gathers what the Settings home shows: settings, next numbers, backups, cloud, version. Null until loaded. */
export function useTileContext(): TileContext | null {
  const { garage, settings, licence } = useAuth();
  const overview = useApi<NonNullable<TileContext["overview"]>>("/api/settings/overview");
  const issues = useApi<{ issues: unknown[] }>(isCloud ? "/api/sync-issues" : null);
  const cloud = useCloudStatus();
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  useEffect(() => {
    void window.ffgp?.backupStatus?.().then(setBackup).catch(() => setBackup(null));
  }, []);
  if (!garage || !settings) return null;
  return {
    garage, settings, licence, cloud, backup,
    overview: overview.data ?? null,
    isCloud,
    pcMode: window.ffgp?.mode ?? null,
    syncIssues: issues.data?.issues.length ?? 0,
    version: __APP_VERSION__,
  };
}
