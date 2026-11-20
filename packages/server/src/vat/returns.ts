import { dubaiDate, SYSTEM_ACCOUNTS as A, vatPeriods } from "@ffgp/shared";
import { audit } from "../audit";
import { NOT_HERE } from "../books/journals";
import { formatDay, postEntry } from "../books/post";
import { newId, now, type Db } from "../db";
import { badRequest, conflict } from "../errors";
import { getSettings } from "../settings";
import { vatFigures, type VatFigures } from "./figures";

const today = () => dubaiDate(new Date().toISOString());
const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

interface ReturnRow { id: string; period_from: string; period_to: string; figures_json: string; reference: string | null; entry_id: string | null; filed_at: string }
const filedRow = (db: Db, from: string, to: string) => db.get<ReturnRow>("SELECT * FROM vat_returns WHERE period_from = ? AND period_to = ?", [from, to]);
const overlapping = (db: Db, from: string, to: string) =>
  db.get<ReturnRow>("SELECT * FROM vat_returns WHERE period_from <= ? AND period_to >= ? ORDER BY period_from LIMIT 1", [to, from]);

/** The VAT periods the books cover, newest first, with whether each is still open, due to file, or filed. */
export function listPeriods(db: Db, on: string = today()) {
  const s = getSettings(db);
  const start = s.books.startDate;
  // Filed returns always show, even when the VAT periods in Settings → Tax changed after them.
  const filed = db.all<{ period_from: string; period_to: string }>("SELECT period_from, period_to FROM vat_returns").map((r) => ({ from: r.period_from, to: r.period_to }));
  const scheduled = vatPeriods(s.tax, on).filter((p) => (!start || p.to >= start) && !filed.some((f) => f.from <= p.to && f.to >= p.from));
  return [...scheduled, ...filed]
    .sort((a, b) => b.from.localeCompare(a.from))
    .map((p) => {
      const r = filedRow(db, p.from, p.to);
      const figures = r ? (JSON.parse(r.figures_json) as VatFigures) : null;
      return {
        ...p, status: r ? ("filed" as const) : p.to < on ? ("due" as const) : ("open" as const),
        filedAt: r?.filed_at ?? null, reference: r?.reference ?? null, payableFils: figures ? figures.payableFils : null,
      };
    });
}

/** A period's figures as the books stand now, and as filed (if it was), with whether they've moved since. */
export function getReturn(db: Db, from: unknown, to: unknown) {
  if (!isYmd(from) || !isYmd(to) || to < from) throw badRequest("Choose a VAT period");
  const figures = vatFigures(db, from, to);
  const r = filedRow(db, from, to);
  const filed = r ? { figures: JSON.parse(r.figures_json) as VatFigures, reference: r.reference, filedAt: r.filed_at, entryId: r.entry_id } : null;
  const changedSinceFiled = !!filed && (filed.figures.dueFils !== figures.dueFils || filed.figures.recoverableFils !== figures.recoverableFils);
  return { ...figures, filed, changedSinceFiled };
}

/**
 * Marks a period's return filed: keeps its figures, posts the settlement dated the period end (output VAT and input
 * VAT into VAT payable, or refundable), and locks the books up to the period end. Returns go in order, once ended.
 */
export function fileReturn(db: Db, input: { from?: unknown; to?: unknown; reference?: unknown }, userId: string, posts: boolean) {
  if (!posts) throw conflict(NOT_HERE);
  const s = getSettings(db);
  const on = today();
  const periods = vatPeriods(s.tax, on);
  const period = periods.find((p) => p.from === input.from && p.to === input.to);
  if (!period) throw badRequest("That isn't a VAT period in Settings → Tax");
  if (period.to >= on) throw badRequest("A return can be filed once its period has ended");
  if (!s.garage.emirate) throw badRequest("Choose the garage's emirate in Settings → Garage first");
  if (filedRow(db, period.from, period.to)) throw conflict("That return is already filed");
  const clash = overlapping(db, period.from, period.to);
  if (clash) throw conflict(`That period overlaps the return filed for ${formatDay(clash.period_from)}–${formatDay(clash.period_to)}`);
  const start = s.books.startDate;
  const earlier = periods.filter((p) => p.to < period.from && (!start || p.to >= start)).reverse().find((p) => !overlapping(db, p.from, p.to));
  if (earlier) throw conflict(`File the return for ${formatDay(earlier.from)}–${formatDay(earlier.to)} first`);
  const reference = typeof input.reference === "string" && input.reference.trim() ? input.reference.trim().slice(0, 60) : null;

  const f = vatFigures(db, period.from, period.to);
  return db.tx(() => {
    const side = (fils: number) => ({ debitFils: fils > 0 ? fils : 0, creditFils: fils < 0 ? -fils : 0 });
    const lines = [
      { accountId: A.vat_output.id, ...side(f.dueFils) },
      { accountId: A.vat_input.id, ...side(-f.recoverableFils) },
      { accountId: A.vat_payable.id, ...side(-f.payableFils) },
    ].filter((l) => l.debitFils || l.creditFils);
    const entryId = lines.length
      ? postEntry(db, {
          date: period.to, narration: `VAT return ${formatDay(period.from)}–${formatDay(period.to)}`, sourceType: "vat_return", sourceId: period.from,
          postKey: `vat_return:${period.from}`, userId, allowLocked: true, lines,
        })
      : null;
    const t = now();
    db.run(
      "INSERT INTO vat_returns (id, period_from, period_to, figures_json, reference, entry_id, filed_by, filed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [newId(), period.from, period.to, JSON.stringify(f), reference, entryId, userId, t, t],
    );
    const lockDate = s.books.lockDate;
    if (!lockDate || lockDate < period.to) {
      db.run("INSERT INTO settings (key, value) VALUES ('books.lockDate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(period.to)]);
      audit(db, { action: "settings.change", entity: "settings", entityId: "books", before: { lockDate }, after: { lockDate: period.to }, userId });
    }
    return getReturn(db, period.from, period.to);
  });
}
