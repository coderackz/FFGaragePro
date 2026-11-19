import { formatAED, type NumberKind, type Settings } from "@ffgp/shared";
import type { Licence } from "../../lib/auth";
import type { BackupStatus, Garage } from "../../lib/types";

/** Everything the Settings home needs to say how each section stands. */
export interface TileContext {
  garage: Garage;
  settings: Settings;
  overview: { nextNumbers: Record<NumberKind, string>; users: number; changesThisWeek: number } | null;
  /** The browser app (Fleetfix Cloud). */
  isCloud: boolean;
  /** PC app: its own garage, main computer, or connected to a main computer. Null in the browser. */
  pcMode: "local" | "main" | "client" | null;
  backup: BackupStatus | null;
  cloud: CloudStatus | null;
  syncIssues: number;
  version: string;
  licence: Licence | null;
  /** For tests; defaults to the current time. */
  now?: number;
}

export type Tone = "ok" | "todo" | "alert" | "muted";
export interface TileStatus { tone: Tone; text: string }

export type TileGroup = "garage" | "money" | "running" | "connections";
export const GROUP_LABELS: Record<TileGroup, string> = {
  garage: "Your garage",
  money: "Money",
  running: "Running the garage",
  connections: "Connections",
};

export interface Tile {
  id: string;
  group: TileGroup;
  title: string;
  blurb: string;
  /** Part 2 / Part 3 sections: shown faded, not clickable. */
  coming?: true;
  show(ctx: TileContext): boolean;
  status(ctx: TileContext): TileStatus;
}

const DAY = 86_400_000;
const ok = (text: string): TileStatus => ({ tone: "ok", text });
const todo = (text: string): TileStatus => ({ tone: "todo", text });
const alert = (text: string): TileStatus => ({ tone: "alert", text });
const muted = (text: string): TileStatus => ({ tone: "muted", text });
const always = () => true;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 hours ago", "4 days ago", "just now". */
export function ago(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${plural(Math.floor(ms / 60_000), "min")} ago`;
  if (ms < DAY) return `${plural(Math.floor(ms / 3_600_000), "hour")} ago`;
  return `${plural(Math.floor(ms / DAY), "day")} ago`;
}

/** This PC holds the garage (not a PC that works through a main computer, and not the browser). */
const holdsGarage = (c: TileContext) => !c.isCloud && (c.pcMode === "local" || c.pcMode === "main");
const hasBank = (s: Settings) => !!(s.garage.bankName && s.garage.iban);

function backupStatus(c: TileContext): TileStatus {
  const b = c.backup;
  if (!b || !b.folderOk) return alert("Backup folder not found");
  if (!b.last) return todo("No backup yet");
  const now = c.now ?? Date.now();
  const text = `Last backup ${ago(b.last, now)}`;
  return now - Date.parse(b.last) > 3 * DAY ? alert(text) : ok(text);
}

const OVER_LIMIT = { warn: "warn", block: "block", approve: "Owner approves" } as const;

export const TILES: Tile[] = [
  {
    id: "garage", group: "garage", title: "Garage details", blurb: "Name, TRN, trade licence, address, bank & IBAN", show: always,
    status: (c) => (!c.garage.trn ? todo("VAT TRN missing") : !hasBank(c.settings) ? todo("Bank details missing") : ok("Complete")),
  },
  {
    id: "documents", group: "garage", title: "Documents & printing", blurb: "Logo, stamp, signature, paper, terms, warranty", show: always,
    status: (c) => (!c.settings.documents.logo ? todo("Logo missing") : ok(c.settings.documents.paper === "letterhead" ? "Letterhead paper" : "Plain paper")),
  },
  {
    id: "numbering", group: "garage", title: "Numbering", blurb: "Prefixes and next numbers", show: always,
    status: (c) => ok(c.overview ? `Next invoice ${c.overview.nextNumbers.invoice}` : "Prefixes and next numbers"),
  },
  {
    id: "tax", group: "money", title: "Tax", blurb: "VAT 5% · prices incl./excl. VAT · return period", show: always,
    status: (c) => ok(`Prices ${c.settings.tax.pricesIncludeVat ? "include" : "exclude"} VAT · ${c.settings.tax.returnPeriod}`),
  },
  {
    id: "pricing", group: "money", title: "Pricing & discounts", blurb: "Labour rate, parts markup, discount limit per role", show: always,
    status: (c) => (c.settings.pricing.labourRateFils == null ? todo("No labour rate set") : ok(`${formatAED(c.settings.pricing.labourRateFils)} / hour`)),
  },
  {
    id: "customers-credit", group: "money", title: "Customers & credit", blurb: "Payment terms and what happens over a credit limit", show: always,
    status: (c) => ok(`Terms ${c.settings.credit.defaultTermsDays} days · ${OVER_LIMIT[c.settings.credit.overLimit]} over limit`),
  },
  {
    id: "inventory", group: "running", title: "Inventory", blurb: "Stock below zero, default reorder level", show: always,
    status: (c) => ok(c.settings.inventory.belowZero === "block" ? "Block below zero" : "Warn only"),
  },
  {
    id: "users", group: "running", title: "Users & roles", blurb: "Who signs in, and what they may do", show: always,
    status: (c) => ok(c.overview ? plural(c.overview.users, "user") : "Who signs in"),
  },
  {
    id: "security", group: "running", title: "Security", blurb: "Lock the screen when nobody is using it", show: always,
    status: (c) => ok(c.settings.security.idleLockMinutes ? `Locks after ${c.settings.security.idleLockMinutes} min` : "Screen lock off"),
  },
  {
    id: "activity", group: "running", title: "Activity log", blurb: "Who changed what — settings, discounts, users", show: always,
    status: (c) => ok(c.overview ? plural(c.overview.changesThisWeek, "change") + " this week" : "Who changed what"),
  },
  {
    id: "backups", group: "running", title: "Backups", blurb: "Daily copy on this PC · restore", show: holdsGarage, status: backupStatus,
  },
  {
    id: "messages", group: "running", title: "Messages", blurb: "WhatsApp, email, templates", coming: true, show: always,
    status: () => muted("Coming in Part 3"),
  },
  {
    id: "cloud", group: "connections", title: "Fleetfix cloud", blurb: "Sync, licence and sync issues", show: holdsGarage,
    status: (c) => {
      const s = c.cloud;
      if (!s?.linked) return muted("Not connected");
      if (s.issues) return alert(`${plural(s.issues, "sync issue")} to review`);
      return ok(s.lastSyncAt ? `Synced ${ago(s.lastSyncAt, c.now)}` : "Not synced yet");
    },
  },
  {
    id: "other-pcs", group: "connections", title: "Other PCs", blurb: "Computers in the garage using this one", show: holdsGarage,
    status: (c) => (c.pcMode === "main" ? ok("Sharing with other PCs") : muted("Not sharing")),
  },
  {
    id: "sync-issues", group: "connections", title: "Sync issues", blurb: "Changes from a PC that needed a decision", show: (c) => c.isCloud && c.syncIssues > 0,
    status: (c) => alert(`${c.syncIssues} to review`),
  },
  {
    id: "about", group: "connections", title: "About & support", blurb: "Version, licence and Fleet Fix support", show: always,
    status: (c) => ok(`Version ${c.version}`),
  },
];

/** The essentials a garage should set before its first real invoice. */
export function gettingReady(c: TileContext): { done: number; total: number; missing: string[] } {
  const s = c.settings;
  const checks: [string, boolean][] = [
    ["Garage name", !!c.garage.name],
    ["VAT TRN", !!c.garage.trn],
    ["Address", !!c.garage.address],
    ["Phone", !!c.garage.phone],
    ["Bank details", hasBank(s)],
    ["Logo", !!s.documents.logo],
    ["Labour rate", s.pricing.labourRateFils != null],
    ["Invoice terms", !!s.documents.terms],
  ];
  if (holdsGarage(c)) checks.push(["Backup folder", !!c.backup?.folderOk]);
  const missing = checks.filter(([, done]) => !done).map(([name]) => name);
  return { done: checks.length - missing.length, total: checks.length, missing };
}

/** Where each "missing" item is set. */
export const READY_SECTION: Record<string, string> = {
  "Garage name": "garage", "VAT TRN": "garage", Address: "garage", Phone: "garage", "Bank details": "garage",
  Logo: "documents", "Invoice terms": "documents", "Labour rate": "pricing", "Backup folder": "backups",
};
