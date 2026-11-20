import { dubaiDate, gratuityOwed, monthDays, proposeLine, runLineEditSchema, serviceDays, type PayLine } from "@ffgp/shared";
import { checkNotLocked } from "../books/journals";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { getSettings } from "../settings";
import { advancesOf, unpaidLeaveOf } from "./employees";

const today = () => dubaiDate(new Date().toISOString());
const monthName = (month: string) => new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

interface RunRow { id: string; month: string; status: "draft" | "approved"; approved_by: string | null; approved_at: string | null; wps_paid_on: string | null; wps_bank_account_id: string | null; bonus_paid_on: string | null; bonus_cash_account_id: string | null; created_at: string }
interface LineRow {
  id: string; run_id: string; employee_id: string; name: string; job: string; pay_method: string; worked_days: number; basic_fils: number; allowances_fils: number;
  unpaid_days: number; unpaid_deduction_fils: number; advance_repayment_fils: number; extras_fils: number; extras_note: string | null; bonus_fils: number;
  net_fils: number; gratuity_fils: number; bonus_in_wps: number;
}
interface EmpRow { id: string; join_date: string; left_date: string | null; basic_fils: number; housing_fils: number; transport_fils: number; other_allowance_fils: number }

const runRow = (db: Db, idOrMonth: string) => db.get<RunRow>("SELECT * FROM payroll_runs WHERE id = ? OR month = ?", [idOrMonth, idOrMonth]);
const lineRows = (db: Db, runId: string) =>
  db.all<LineRow>(
    `SELECT l.*, e.name, e.job, e.pay_method FROM payroll_lines l JOIN employees e ON e.id = l.employee_id WHERE l.run_id = ? ORDER BY e.name COLLATE NOCASE`, [runId]);

const lineOut = (l: LineRow) => ({
  employeeId: l.employee_id, name: l.name, job: l.job, payMethod: l.pay_method, workedDays: l.worked_days, basicFils: l.basic_fils, allowancesFils: l.allowances_fils,
  unpaidDays: l.unpaid_days, unpaidDeductionFils: l.unpaid_deduction_fils, advanceRepaymentFils: l.advance_repayment_fils, extrasFils: l.extras_fils,
  extrasNote: l.extras_note, bonusFils: l.bonus_fils, netFils: l.net_fils, gratuityFils: l.gratuity_fils, bonusInWps: !!l.bonus_in_wps,
});

export function getRun(db: Db, idOrMonth: string) {
  const r = runRow(db, idOrMonth);
  if (!r) throw notFound("Payroll run not found");
  const lines = lineRows(db, r.id).map(lineOut);
  const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((s, l) => s + f(l), 0);
  return {
    id: r.id, month: r.month, status: r.status, approvedAt: r.approved_at, wpsPaidOn: r.wps_paid_on, bonusPaidOn: r.bonus_paid_on, lines,
    totals: {
      grossFils: sum((l) => l.basicFils + l.allowancesFils + l.extrasFils), deductionsFils: sum((l) => l.unpaidDeductionFils),
      advancesFils: sum((l) => l.advanceRepaymentFils), bonusFils: sum((l) => l.bonusFils), gratuityFils: sum((l) => l.gratuityFils),
      netWpsFils: sum((l) => l.netFils + (l.bonusInWps ? l.bonusFils : 0)),
    },
  };
}
export type RunOut = ReturnType<typeof getRun>;

export const listRuns = (db: Db) =>
  db.all<{ id: string }>("SELECT id FROM payroll_runs ORDER BY month DESC").map((r) => {
    const { lines: _lines, ...run } = getRun(db, r.id);
    return { ...run, people: _lines.length };
  });

/** Advances owed by the month end and what they ask back this month (the instalments, never more than is owed). */
function advanceDue(db: Db, employeeId: string, monthEnd: string): { dueFils: number; owedFils: number } {
  const open = advancesOf(db, employeeId).filter((a) => a.paidOn <= monthEnd && a.owedFils > 0);
  const owedFils = open.reduce((s, a) => s + a.owedFils, 0);
  return { owedFils, dueFils: Math.min(open.reduce((s, a) => s + Math.min(a.instalmentFils, a.owedFils), 0), owedFils) };
}

const employedIn = (db: Db, month: string) => {
  const m = monthDays(month);
  return db.all<EmpRow>("SELECT * FROM employees WHERE join_date <= ? AND (left_date IS NULL OR left_date >= ?) ORDER BY name COLLATE NOCASE", [m.to, m.from]);
};

/** The proposal for one person, keeping what the accountant typed (bonus, extras, a changed advance repayment). */
function propose(db: Db, month: string, e: EmpRow, kept?: Pick<LineRow, "bonus_fils" | "extras_fils" | "extras_note" | "advance_repayment_fils">): PayLine & { extrasNote: string | null } {
  const m = monthDays(month);
  const rule = getSettings(db).payroll.salaryDayRate ?? "gross_30";
  const advance = advanceDue(db, e.id, m.to);
  const base = proposeLine({
    month, salaryDayRate: rule, unpaidLeave: unpaidLeaveOf(db, e.id), advanceDueFils: kept ? Math.min(kept.advance_repayment_fils, advance.owedFils) : advance.dueFils,
    employee: { basicFils: e.basic_fils, housingFils: e.housing_fils, transportFils: e.transport_fils, otherAllowanceFils: e.other_allowance_fils, joinDate: e.join_date, leftDate: e.left_date },
  });
  const extrasFils = kept?.extras_fils ?? 0;
  return { ...base, extrasFils, bonusFils: kept?.bonus_fils ?? 0, netFils: base.netFils + extrasFils, extrasNote: kept?.extras_note ?? null };
}

function writeLine(db: Db, runId: string, employeeId: string, p: PayLine & { extrasNote: string | null }) {
  const t = now();
  db.run(
    `INSERT INTO payroll_lines (id, run_id, employee_id, worked_days, basic_fils, allowances_fils, unpaid_days, unpaid_deduction_fils, advance_repayment_fils,
       extras_fils, extras_note, bonus_fils, net_fils, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, employee_id) DO UPDATE SET worked_days = excluded.worked_days, basic_fils = excluded.basic_fils, allowances_fils = excluded.allowances_fils,
       unpaid_days = excluded.unpaid_days, unpaid_deduction_fils = excluded.unpaid_deduction_fils, advance_repayment_fils = excluded.advance_repayment_fils,
       extras_fils = excluded.extras_fils, extras_note = excluded.extras_note, bonus_fils = excluded.bonus_fils, net_fils = excluded.net_fils, updated_at = excluded.updated_at`,
    [newId(), runId, employeeId, p.workedDays, p.basicFils, p.allowancesFils, p.unpaidDays, p.unpaidDeductionFils, p.advanceRepaymentFils, p.extrasFils, p.extrasNote,
      p.bonusFils, p.netFils, t, t],
  );
}

/** Opens a month's run: a line for everyone employed for at least one day of it, as the app proposes their pay. */
export function openRun(db: Db, month: unknown, userId: string) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("Choose a month");
  if (month > today().slice(0, 7)) throw badRequest("A month can be run once it has started");
  if (runRow(db, month)) throw conflict(`Payroll for ${monthName(month)} is already open`);
  return db.tx(() => {
    const id = newId();
    const t = now();
    db.run("INSERT INTO payroll_runs (id, month, status, created_by, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)", [id, month, userId, t, t]);
    for (const e of employedIn(db, month)) writeLine(db, id, e.id, propose(db, month, e));
    return getRun(db, id);
  });
}

const draft = (db: Db, runId: string) => {
  const r = runRow(db, runId);
  if (!r) throw notFound("Payroll run not found");
  if (r.status !== "draft") throw conflict("This payroll is approved: it can't change");
  return r;
};

/** Re-proposes a draft from the employees and leave as they are now, keeping what was typed. */
export function refreshRun(db: Db, runId: string) {
  const r = draft(db, runId);
  return db.tx(() => {
    const kept = new Map(lineRows(db, r.id).map((l) => [l.employee_id, l]));
    const people = employedIn(db, r.month);
    for (const e of people) writeLine(db, r.id, e.id, propose(db, r.month, e, kept.get(e.id)));
    const ids = new Set(people.map((e) => e.id));
    for (const id of kept.keys()) if (!ids.has(id)) db.run("DELETE FROM payroll_lines WHERE run_id = ? AND employee_id = ?", [r.id, id]);
    return getRun(db, r.id);
  });
}

export function editLine(db: Db, runId: string, employeeId: string, input: unknown) {
  const r = draft(db, runId);
  const x = runLineEditSchema.parse(input);
  const l = db.get<LineRow>("SELECT * FROM payroll_lines WHERE run_id = ? AND employee_id = ?", [r.id, employeeId]);
  if (!l) throw notFound("That person isn't in this payroll");
  if (x.advanceRepaymentFils !== undefined) {
    const { owedFils } = advanceDue(db, employeeId, monthDays(r.month).to);
    if (x.advanceRepaymentFils > owedFils) throw badRequest(`That's more than the ${(owedFils / 100).toFixed(2)} still owed on advances`);
  }
  const next = {
    bonus: x.bonusFils ?? l.bonus_fils, extras: x.extrasFils ?? l.extras_fils, note: x.extrasNote !== undefined ? x.extrasNote : l.extras_note,
    advance: x.advanceRepaymentFils ?? l.advance_repayment_fils,
  };
  const net = l.basic_fils + l.allowances_fils - l.unpaid_deduction_fils - next.advance + next.extras;
  db.run("UPDATE payroll_lines SET bonus_fils = ?, extras_fils = ?, extras_note = ?, advance_repayment_fils = ?, net_fils = ?, updated_at = ? WHERE id = ?", [
    next.bonus, next.extras, next.note, next.advance, net, now(), l.id,
  ]);
  return getRun(db, r.id);
}

/**
 * The owner approves: the run is re-proposed (with the pay rules now chosen), checked, and frozen. Each line puts aside
 * this month's gratuity: what would be owed at the month end, less what earlier approved runs put aside.
 */
export function approveRun(db: Db, runId: string, userId: string) {
  const r = draft(db, runId);
  const earlier = db.get<{ month: string }>("SELECT month FROM payroll_runs WHERE month < ? AND status = 'draft' ORDER BY month LIMIT 1", [r.month]);
  if (earlier) throw conflict(`Approve the payroll for ${monthName(earlier.month)} first`);
  const rules = getSettings(db).payroll;
  if (!rules.gratuityDayRate || !rules.gratuityCap || !rules.salaryDayRate) throw badRequest("Choose how pay is worked out in Settings → Payroll first");
  const m = monthDays(r.month);
  checkNotLocked(db, m.to);
  return db.tx(() => {
    refreshRun(db, r.id);
    const lines = lineRows(db, r.id);
    const negative = lines.find((l) => l.net_fils < 0);
    if (negative) throw badRequest(`${negative.name}'s pay comes to less than nothing: change the extras or the advance repayment`);
    for (const l of lines) {
      const e = db.get<EmpRow>("SELECT * FROM employees WHERE id = ?", [l.employee_id])!;
      const asOf = e.left_date && e.left_date < m.to ? e.left_date : m.to;
      const owed = gratuityOwed({
        basicFils: e.basic_fils, grossFils: e.basic_fils + e.housing_fils + e.transport_fils + e.other_allowance_fils,
        serviceDays: serviceDays(e.join_date, asOf, unpaidLeaveOf(db, e.id)), dayRate: rules.gratuityDayRate!, cap: rules.gratuityCap!,
      });
      const held = db.get<{ g: number | null }>(
        "SELECT SUM(l.gratuity_fils) AS g FROM payroll_lines l JOIN payroll_runs p ON p.id = l.run_id WHERE l.employee_id = ? AND p.status = 'approved'", [e.id])!.g ?? 0;
      db.run("UPDATE payroll_lines SET gratuity_fils = ?, bonus_in_wps = ?, updated_at = ? WHERE id = ?", [owed - held, rules.bonusInWps ? 1 : 0, now(), l.id]);
    }
    db.run("UPDATE payroll_runs SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?", [userId, now(), now(), r.id]);
    return getRun(db, r.id);
  });
}

export { monthName };
