import {
  formatNumberOf, LOCAL_SETTING_PREFIXES, NUMBER_KINDS, prefixOf, readSettings, sectionRows, startOf, type NumberKind,
  type Settings, type SettingsSection,
} from "@ffgp/shared";
import { audit } from "./audit";
import type { Db } from "./db";
import { badRequest } from "./errors";
import { numberInUse, previewNumber } from "./numbering";

const notLocal = LOCAL_SETTING_PREFIXES.map((p) => `key NOT LIKE '${p}%'`).join(" AND ");

/** The garage's settings, with defaults for anything not stored (or stored by a newer app version). */
export function getSettings(db: Db): Settings {
  return readSettings(db.all<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE ${notLocal}`));
}

/** Image values are logged as "(image)": the log says that it changed, not the picture itself. */
const forLog = (v: unknown) => (typeof v === "string" && v.startsWith("data:image/") ? "(image)" : v);

/** Only the fields that differ, as {before, after}; null when nothing changed. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k] ?? null) === JSON.stringify(after[k] ?? null)) continue;
    b[k] = forLog(before[k] ?? null);
    a[k] = forLog(after[k] ?? null);
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

/** Hook for sections with rules beyond their schema (numbering can't go backwards). */
type SectionCheck = (db: Db, next: Settings[SettingsSection]) => void;
const checks: Partial<Record<SettingsSection, SectionCheck>> = {};
export function registerSectionCheck<S extends SettingsSection>(section: S, check: (db: Db, next: Settings[S]) => void): void {
  checks[section] = check as SectionCheck;
}

/** Saves one section's fields (and nothing else), logging what changed. */
export function saveSection(db: Db, userId: string, section: SettingsSection, input: unknown): Settings {
  const rows = sectionRows(section, input);
  return db.tx(() => {
    const current = getSettings(db);
    const next = readSettings(rows)[section];
    checks[section]?.(db, next);
    for (const r of rows) {
      db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [r.key, r.value]);
    }
    const changed = diff(current[section] as Record<string, unknown>, next as Record<string, unknown>);
    if (changed) audit(db, { action: "settings.change", entity: "settings", entityId: section, ...changed, userId });
    return getSettings(db);
  });
}

/** What the next main-series number of each kind will look like, e.g. "INV-00143". */
export function nextNumbers(db: Db): Record<NumberKind, string> {
  const s = getSettings(db);
  return Object.fromEntries(
    NUMBER_KINDS.map((k) => {
      const n = previewNumber(db, k);
      return [k, formatNumberOf(k, n, "", prefixOf(s, k))];
    }),
  ) as Record<NumberKind, string>;
}

/**
 * Numbering may only move forward: a changed "next number" below what the series would hand out next is refused,
 * so an invoice number never goes backwards. (The cloud also never goes below a start, see takeNumber.)
 */
export function checkNumbering(db: Db, next: Settings["numbering"]): void {
  const current = getSettings(db);
  const proposed: Settings = { ...current, numbering: next };
  // A prefix already printed on another type's documents would give two documents the same number.
  const PLURAL: Record<NumberKind, string> = {
    estimate: "estimates", jobcard: "job cards", invoice: "invoices", purchase_order: "purchase orders", credit_note: "credit notes", receipt: "receipts",
  };
  const usedBy = (prefix: string, kind: NumberKind): NumberKind | null => {
    for (const other of NUMBER_KINDS) {
      if (other !== kind && numberInUse(db, other, prefix)) return other;
    }
    return null;
  };
  for (const kind of NUMBER_KINDS) {
    const prefix = prefixOf(proposed, kind);
    if (prefix === prefixOf(current, kind)) continue;
    const other = usedBy(prefix, kind);
    if (other) throw badRequest(`${prefix} is already on ${PLURAL[other]}. Choose another prefix for ${PLURAL[kind]}.`);
  }
  for (const kind of NUMBER_KINDS) {
    if (startOf(proposed, kind) === startOf(current, kind)) continue;
    const upcoming = previewNumber(db, kind);
    if (startOf(proposed, kind) < upcoming) {
      const prefix = prefixOf(proposed, kind);
      const shown = formatNumberOf(kind, upcoming, "", prefix);
      throw badRequest(`${prefix} can't go back: the next number is ${shown}`);
    }
  }
}
registerSectionCheck("numbering", checkNumbering);
