/// <reference types="vite/client" />

/** apps/desktop/package.json's version, stamped in at build time. */
declare const __APP_VERSION__: string;

interface FfgpBridge {
  apiBase: string;
  /** Set on a PC connected to a main computer; sent with every request. */
  deviceKey: string | null;
  /** local: single PC · main: sharing with other PCs · client: connected to a main computer */
  mode: "local" | "main" | "client";
  mainComputer: { host: string; garageName: string } | null;
  hostname: string;
  savePdf(html: string, fileName: string): Promise<string | null>;
  print(html: string): Promise<boolean>;
  /** A page as PDF bytes (base64). */
  makePdf(html: string): Promise<string>;
  /** Saves the PDF to Documents/Fleetfix Garage Pro/Sent, shows it, and opens the wa.me chat. */
  whatsapp(args: { url: string; pdf: { fileName: string; base64: string } | null }): Promise<boolean>;
  discover(): Promise<{ host: string; port: number; name: string }[]>;
  connect(args: { host: string; code: string; deviceName: string }): Promise<{ ok?: true; error?: string }>;
  disconnect(): Promise<void>;
  applyNetwork(): Promise<void>;
  /** This PC's own garage is linked to Fleetfix cloud. */
  cloudLinked: boolean;
  /** Backups of this PC's garage; null on a PC that works through a main computer. */
  backupStatus(): Promise<import("./lib/types").BackupStatus | null>;
  backupNow(): Promise<{ ok?: true; file?: string; error?: string }>;
  backupChooseFolder(): Promise<import("./lib/types").BackupStatus | null>;
  backupSetKeepDays(days: number): Promise<import("./lib/types").BackupStatus>;
  restore(): Promise<{ ok?: true; cancelled?: true; error?: string }>;
  cloudStatus(): Promise<CloudStatus>;
  cloudLink(args: CloudLinkArgs): Promise<{ ok?: true; error?: string }>;
  cloudSyncNow(): Promise<{ ok: boolean; reason?: string; message?: string }>;
  cloudUnlink(): Promise<void>;
  onCloudStatus(cb: (status: CloudStatus) => void): () => void;
}

interface CloudLinkArgs {
  mode: "download" | "upload";
  url: string;
  garageCode: string;
  deviceName: string;
  username?: string;
  password?: string;
  setupCode?: string;
}

/** Mirrors @ffgp/sync's SyncStatus (plus whether a sync is running). */
type CloudStatus =
  | { linked: false; syncing: boolean }
  | {
      linked: true;
      syncing: boolean;
      garageCode: string;
      deviceCode: string;
      lastSyncAt: string | null;
      pending: number;
      licence: { state: "trial" | "active" | "grace" | "read_only"; endsAt: string | null; graceEndsAt: string | null; checkedAt: string | null; readOnly: boolean; reason: "expired" | "not_checked" | "invalid" | null };
      readOnly: boolean;
      issues: number;
      lastError: { reason: string; message: string } | null;
    };

interface Window {
  ffgp?: FfgpBridge;
}

declare module "*.png" {
  const src: string;
  export default src;
}
