import { assetSchema, depreciationThrough, disposeSchema, dubaiDate, monthlyDepreciation, monthsBetween, SYSTEM_ACCOUNTS as A } from "@ffgp/shared";
import { checkNotLocked } from "../books/journals";
import { newId, now, type Db } from "../db";
import { getSettings } from "../settings";
import { badRequest, conflict, notFound } from "../errors";

const today = () => dubaiDate(new Date().toISOString());

export interface AssetRow {
  id: string; name: string; category: string; account_id: string; cost_fils: number; in_use_from: string; life_months: number; residual_fils: number;
  opening_depreciation_fils: number; serial: string | null; note: string | null; disposed_on: string | null; proceeds_fils: number | null;
  proceeds_account_id: string | null; disposal_note: string | null; created_at: string; updated_at: string;
}
export const assetFigures = (r: AssetRow) => ({ costFils: r.cost_fils, residualFils: r.residual_fils, lifeMonths: r.life_months, inUseFrom: r.in_use_from });

/** Depreciation posted on an asset so far, with what was taken before the books started. */
export const postedDepreciation = (db: Db, r: AssetRow) =>
  r.opening_depreciation_fils + (db.get<{ v: number | null }>(
    "SELECT SUM(credit_fils - debit_fils) AS v FROM journal_lines WHERE asset_id = ? AND account_id = ? AND entry_id IN (SELECT id FROM journal_entries WHERE source_type = 'depreciation')",
    [r.id, A.accumulated_depreciation.id],
  )!.v ?? 0);

/** What an asset should have been depreciated by through `month`: held at the disposal month once it's gone. */
export const dueThrough = (r: AssetRow, month: string) =>
  depreciationThrough(assetFigures(r), r.disposed_on && r.disposed_on.slice(0, 7) < month ? r.disposed_on.slice(0, 7) : month);

const out = (db: Db, r: AssetRow) => {
  const posted = postedDepreciation(db, r);
  return {
    id: r.id, name: r.name, category: r.category, accountId: r.account_id, costFils: r.cost_fils, inUseFrom: r.in_use_from, lifeMonths: r.life_months,
    residualFils: r.residual_fils, openingDepreciationFils: r.opening_depreciation_fils, serial: r.serial, note: r.note, disposedOn: r.disposed_on,
    proceedsFils: r.proceeds_fils, proceedsAccountId: r.proceeds_account_id, disposalNote: r.disposal_note,
    postedFils: posted, bookValueFils: r.cost_fils - posted, monthlyFils: monthlyDepreciation(assetFigures(r)),
    // On disposal, depreciation runs through the disposal month (posted just after): the gain is against that book value.
    gainFils: r.disposed_on && r.proceeds_fils !== null ? r.proceeds_fils - (r.cost_fils - Math.max(posted, dueThrough(r, r.disposed_on.slice(0, 7)))) : null,
  };
};
const row = (db: Db, id: string) => db.get<AssetRow>("SELECT * FROM fixed_assets WHERE id = ?", [id]);

export const listAssets = (db: Db, o: { includeDisposed?: boolean } = {}) =>
  db.all<AssetRow>(`SELECT * FROM fixed_assets ${o.includeDisposed ? "" : "WHERE disposed_on IS NULL"} ORDER BY in_use_from, name`).map((r) => out(db, r));

/** One asset, with its schedule month by month (posted months, then what's to come). */
export function getAsset(db: Db, id: string) {
  const r = row(db, id);
  if (!r) throw notFound("Asset not found");
  const first = r.in_use_from.slice(0, 7);
  const end = r.disposed_on?.slice(0, 7);
  const lastMonth = today().slice(0, 7);
  const months: { month: string; chargeFils: number; totalFils: number; posted: boolean }[] = [];
  let prev = 0;
  for (let i = 0; i < Math.min(r.life_months + 1, 700); i++) {
    const [y, m] = first.split("-").map(Number) as [number, number];
    const month = new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7);
    if (end && month > end) break;
    const total = depreciationThrough(assetFigures(r), month);
    if (total === prev && i > 0) break;
    months.push({ month, chargeFils: total - prev, totalFils: total, posted: month < lastMonth || (!!end && month <= end) });
    prev = total;
  }
  return { ...out(db, r), schedule: months };
}

/** Assets sit in an asset account of their own (not money, not one the app keeps). */
function checkAccount(db: Db, accountId: string) {
  const a = db.get<{ type: string; active: number; system_key: string | null; money_kind: string | null }>("SELECT type, active, system_key, money_kind FROM accounts WHERE id = ?", [accountId]);
  if (!a?.active || a.type !== "asset" || a.system_key || a.money_kind) throw badRequest("An asset sits in an asset account of its own (e.g. 1500 Tools and equipment)");
}

const COLS = ["name", "category", "account_id", "cost_fils", "in_use_from", "life_months", "residual_fils", "opening_depreciation_fils", "serial", "note"] as const;
const values = (x: ReturnType<typeof assetSchema.parse>) =>
  [x.name, x.category, x.accountId, x.costFils, x.inUseFrom, x.lifeMonths, x.residualFils, x.openingDepreciationFils, x.serial, x.note];

/** Depreciation taken before the books belongs to an asset in use before they started. */
function checkOpening(db: Db, x: { inUseFrom: string; openingDepreciationFils: number }) {
  const start = getSettings(db).books.startDate;
  if (x.openingDepreciationFils > 0 && start && x.inUseFrom >= start) throw badRequest("Depreciation before the books is only for an asset in use before they started");
}

export function createAsset(db: Db, input: unknown, userId: string) {
  const x = assetSchema.parse(input);
  checkAccount(db, x.accountId);
  checkOpening(db, x);
  const id = newId();
  const t = now();
  db.run(`INSERT INTO fixed_assets (id, ${COLS.join(", ")}, created_by, created_at, updated_at) VALUES (?, ${COLS.map(() => "?").join(", ")}, ?, ?, ?)`, [id, ...values(x), userId, t, t]);
  return getAsset(db, id);
}

/** An edit (cost, life, residual…): the next depreciation entry catches up to the new schedule. Not after disposal. */
export function updateAsset(db: Db, id: string, input: unknown) {
  const r = row(db, id);
  if (!r) throw notFound("Asset not found");
  if (r.disposed_on) throw conflict("This asset has been sold or written off: it can't change");
  const current = out(db, r);
  const x = assetSchema.parse({ ...current, ...(input as object) });
  checkAccount(db, x.accountId);
  checkOpening(db, x);
  db.run(`UPDATE fixed_assets SET ${COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...values(x), now(), id]);
  return getAsset(db, id);
}

/** Sold or written off (proceeds 0): depreciation runs through that month, then its cost and depreciation leave the books. */
export function disposeAsset(db: Db, id: string, input: unknown) {
  const r = row(db, id);
  if (!r) throw notFound("Asset not found");
  if (r.disposed_on) throw conflict("Already sold or written off");
  const d = disposeSchema.parse(input);
  if (d.date < r.in_use_from) throw badRequest("That's before the asset went into use");
  if (d.date > today()) throw badRequest("A sale can't be dated in the future");
  checkNotLocked(db, d.date);
  if (d.proceedsFils > 0) {
    const a = db.get<{ money_kind: string | null; active: number }>("SELECT money_kind, active FROM accounts WHERE id = ?", [d.proceedsAccountId!]);
    if (!a?.active || !["cash", "bank"].includes(a.money_kind ?? "")) throw badRequest("The money goes into a cash or bank account");
  }
  db.run("UPDATE fixed_assets SET disposed_on = ?, proceeds_fils = ?, proceeds_account_id = ?, disposal_note = ?, updated_at = ? WHERE id = ?", [
    d.date, d.proceedsFils, d.proceedsFils > 0 ? d.proceedsAccountId : null, d.note, now(), id,
  ]);
  return getAsset(db, id);
}

export { monthsBetween };
