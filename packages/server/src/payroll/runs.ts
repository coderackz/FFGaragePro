import { createHash } from "node:crypto";
import { dubaiDate, gratuityOwed, monthDays, proposeLine, runLineEditSchema, serviceYears, type PayLine } from "@ffgp/shared";
import { postPending } from "../books/pending";
import { addDays } from "../books/post";
import { checkNotLocked } from "../books/journals";
import { newId, now, type Db } from "../db";
import { audit } from "../audit";
import { badRequest, conflict, notFound } from "../errors";
import { getSettings } from "../settings";
import { advancesOf, unpaidLeaveOf } from "./employees";

const today = () => dubaiDate(new Date().toISOString());
export const monthName = (month: string) => new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

/** The same id everywhere for the same thing: two places opening one month make one run, one line per person. */
export const stableId = (text: string) => {
  const h = createHash("sha1").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const runIdOf = (month: string) => stableId(`payroll_run|${month}`);
const lineIdOf = (runId: string, employeeId: string) => stableId(`payroll_line|${runId}|${employeeId}`);

interface RunRow { id: string; month: string; created_at: string }
interface LineRow {
  id: string; run_id: string; employee_id: string; name: string; job: string; pay_method: string; worked_days: number; basic_fils: number; allowances_fils: number;
  unpaid_days: number; unpaid_deduction_fils: number; advance_repayment_fils: number; advance_typed: number; extras_fils: number; extras_note: string | null; bonus_fils: number; net_fils: number;
}
interface EmpRow { id: string; name: string; join_date: string; left_date: string | null; basic_fils: number; housing_fils: number; transport_fils: number; other_allowance_fils: number }

export interface RunLine {
  employeeId: string; name: string; job: string; payMethod: string; workedDays: number; basicFils: number; allowancesFils: number; unpaidDays: number;
  unpaidDeductionFils: number; advanceRepaymentFils: number; extrasFils: number; extrasNote: string | null; bonusFils: number; netFils: number;
  /** This month's gratuity put aside (set on approval); the part that belongs to the time before the books started is on its own entry. */
  gratuityFils: number; bonusInWps: boolean;
}
export interface Snapshot { month: string; lines: RunLine[] }

const runRow = (db: Db, idOrMonth: string) => db.get<RunRow>("SELECT id, month, created_at FROM payroll_runs WHERE id = ? OR month = ?", [idOrMonth, idOrMonth]);
const lineRows = (db: Db, runId: string) =>
  db.all<LineRow>(`SELECT l.*, e.name, e.job, e.pay_method FROM payroll_lines l JOIN employees e ON e.id = l.employee_id WHERE l.run_id = ? ORDER BY e.name COLLATE NOCASE`, [runId]);
export const approvalOf = (db: Db, runId: string) =>
  db.get<{ snapshot_json: string; approved_at: string; approved_by: string | null }>("SELECT snapshot_json, approved_at, approved_by FROM payroll_approvals WHERE run_id = ?", [runId]);
const paymentsOf = (db: Db, runId: string) =>
  Object.fromEntries(db.all<{ kind: string; paid_on: string }>("SELECT kind, paid_on FROM payroll_payments WHERE run_id = ?", [runId]).map((p) => [p.kind, p.paid_on]));

/** The draft's lines as the payroll would approve them now (the bonus goes through WPS if the setting says so). */
const draftLines = (db: Db, runId: string): RunLine[] => {
  const inWps = getSettings(db).payroll.bonusInWps;
  return lineRows(db, runId).map((l) => ({
    employeeId: l.employee_id, name: l.name, job: l.job, payMethod: l.pay_method, workedDays: l.worked_days, basicFils: l.basic_fils, allowancesFils: l.allowances_fils,
    unpaidDays: l.unpaid_days, unpaidDeductionFils: l.unpaid_deduction_fils, advanceRepaymentFils: l.advance_repayment_fils, extrasFils: l.extras_fils,
    extrasNote: l.extras_note, bonusFils: l.bonus_fils, netFils: l.net_fils, gratuityFils: 0, bonusInWps: inWps,
  }));
};

const totalsOf = (lines: RunLine[]) => {
  const sum = (f: (l: RunLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  return {
    grossFils: sum((l) => l.basicFils + l.allowancesFils + l.extrasFils), deductionsFils: sum((l) => l.unpaidDeductionFils),
    advancesFils: sum((l) => l.advanceRepaymentFils), bonusFils: sum((l) => l.bonusFils), cashBonusFils: sum((l) => (l.bonusInWps ? 0 : l.bonusFils)),
    gratuityFils: sum((l) => l.gratuityFils), netWpsFils: sum((l) => l.netFils + (l.bonusInWps ? l.bonusFils : 0)),
  };
};

/** A run: while a draft, its live lines; once approved, exactly what was approved. */
export function getRun(db: Db, idOrMonth: string) {
  const r = runRow(db, idOrMonth);
  if (!r) throw notFound("Payroll run not found");
  const approval = approvalOf(db, r.id);
  const lines = approval ? (JSON.parse(approval.snapshot_json) as Snapshot).lines : draftLines(db, r.id);
  const paid = paymentsOf(db, r.id);
  return {
    id: r.id, month: r.month, status: approval ? ("approved" as const) : ("draft" as const), approvedAt: approval?.approved_at ?? null,
    wpsPaidOn: paid.wps ?? null, bonusPaidOn: paid.bonus ?? null, lines, totals: totalsOf(lines),
  };
}
export type RunOut = ReturnType<typeof getRun>;

export const listRuns = (db: Db) =>
  db.all<{ id: string }>("SELECT id FROM payroll_runs ORDER BY month DESC").map((r) => {
    const { lines, ...run } = getRun(db, r.id);
    return { ...run, people: lines.length };
  });

/** Advances owed by the month end and what they ask back this month (the instalments, never more than is owed). */
function advanceDue(db: Db, employeeId: string, monthEnd: string): { dueFils: number; owedFils: number } {
  const open = advancesOf(db, employeeId).filter((a) => a.paidOn <= monthEnd && a.owedFils > 0 && !a.cancelled);
  const owedFils = open.reduce((s, a) => s + a.owedFils, 0);
  return { owedFils, dueFils: Math.min(open.reduce((s, a) => s + Math.min(a.instalmentFils, a.owedFils), 0), owedFils) };
}

const employedIn = (db: Db, month: string) => {
  const m = monthDays(month);
  // Someone with a final settlement is paid by it from their leaving month on.
  return db.all<EmpRow>(
    `SELECT * FROM employees e WHERE join_date <= ? AND (left_date IS NULL OR left_date >= ?)
       AND NOT (left_date IS NOT NULL AND left_date <= ? AND EXISTS (SELECT 1 FROM final_settlements f WHERE f.employee_id = e.id))
     ORDER BY name COLLATE NOCASE`, [m.to, m.from, m.to]);
};

const salaryRule = (db: Db) => {
  const rule = getSettings(db).payroll.salaryDayRate;
  if (!rule) throw badRequest("Choose the salary day rate in Settings → Payroll first");
  return rule;
};

/** The proposal for one person, keeping what the accountant typed (bonus, extras, a changed advance repayment). */
function propose(db: Db, month: string, e: EmpRow, kept?: Pick<LineRow, "bonus_fils" | "extras_fils" | "extras_note" | "advance_repayment_fils" | "advance_typed">): PayLine & { extrasNote: string | null } {
  const m = monthDays(month);
  const advance = advanceDue(db, e.id, m.to);
  const base = proposeLine({
    month, salaryDayRate: salaryRule(db), unpaidLeave: unpaidLeaveOf(db, e.id), advanceDueFils: kept?.advance_typed ? Math.min(kept.advance_repayment_fils, advance.owedFils) : advance.dueFils,
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
    [lineIdOf(runId, employeeId), runId, employeeId, p.workedDays, p.basicFils, p.allowancesFils, p.unpaidDays, p.unpaidDeductionFils, p.advanceRepaymentFils, p.extrasFils,
      p.extrasNote, p.bonusFils, p.netFils, t, t],
  );
}

/** The latest approved month: nothing before it can be opened or approved (its gratuity would be wrong). */
const latestApproved = (db: Db) =>
  db.get<{ month: string }>("SELECT r.month FROM payroll_approvals a JOIN payroll_runs r ON r.id = a.run_id ORDER BY r.month DESC LIMIT 1")?.month ?? null;

/** Opens a month's run: a line for everyone employed for at least one day of it, as the app proposes their pay. */
export function openRun(db: Db, month: unknown, userId: string) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("Choose a month");
  if (month > today().slice(0, 7)) throw badRequest("A month can be run once it has started");
  salaryRule(db);
  if (runRow(db, month)) throw conflict(`Payroll for ${monthName(month)} is already open`);
  const latest = latestApproved(db);
  if (latest && month < latest) throw conflict(`Payroll for ${monthName(latest)} is already approved: an earlier month can't be run now`);
  return db.tx(() => {
    const id = runIdOf(month);
    const t = now();
    db.run("INSERT INTO payroll_runs (id, month, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [id, month, userId, t, t]);
    for (const e of employedIn(db, month)) writeLine(db, id, e.id, propose(db, month, e));
    return getRun(db, id);
  });
}

const draft = (db: Db, runId: string) => {
  const r = runRow(db, runId);
  if (!r) throw notFound("Payroll run not found");
  if (approvalOf(db, r.id)) throw conflict("This payroll is approved: it can't change");
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
  db.run("UPDATE payroll_lines SET bonus_fils = ?, extras_fils = ?, extras_note = ?, advance_repayment_fils = ?, advance_typed = ?, net_fils = ?, updated_at = ? WHERE id = ?", [
    next.bonus, next.extras, next.note, next.advance, x.advanceRepaymentFils !== undefined ? 1 : l.advance_typed, net, now(), l.id,
  ]);
  return getRun(db, r.id);
}

/** Gratuity already put aside for someone: earlier approved payrolls, and what was brought forward at the books start. */
export function gratuityHeld(db: Db, employeeId: string): number {
  let held = 0;
  for (const a of db.all<{ snapshot_json: string }>("SELECT snapshot_json FROM payroll_approvals")) {
    for (const l of (JSON.parse(a.snapshot_json) as Snapshot).lines) if (l.employeeId === employeeId) held += l.gratuityFils;
  }
  return held + broughtForward(db, employeeId);
}
export const broughtForward = (db: Db, employeeId: string) =>
  -(db.get<{ v: number | null }>(
    "SELECT SUM(l.debit_fils - l.credit_fils) AS v FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.source_type = 'payroll_opening' AND e.source_id = ? AND l.account_id = '00000000-0000-4000-8000-0000000a2210'",
    [employeeId],
  )!.v ?? 0);

/** The gratuity owed at the day before the books start, for someone who joined before it (the opening position). */
export function gratuityAtStart(db: Db, e: EmpRow): number {
  const s = getSettings(db);
  const start = s.books.startDate;
  if (!start || e.join_date >= start || !s.payroll.gratuityDayRate || !s.payroll.gratuityCap) return 0;
  const before = addDays(start, -1);
  const asOf = e.left_date && e.left_date < before ? e.left_date : before;
  return gratuityOwed({
    basicFils: e.basic_fils, grossFils: e.basic_fils + e.housing_fils + e.transport_fils + e.other_allowance_fils,
    serviceYears: serviceYears(e.join_date, asOf, unpaidLeaveOf(db, e.id)), dayRate: s.payroll.gratuityDayRate, cap: s.payroll.gratuityCap,
  });
}

/**
 * The owner approves. The run is re-proposed with today's employees and leave; if that changes what the owner was shown
 * (`netWpsFils`), approval stops so they can look again. Each line puts aside this month's gratuity (owed at the month
 * end, less what's held), and the payroll is kept exactly as approved.
 */
export function approveRun(db: Db, runId: string, userId: string, o: { netWpsFils?: unknown; posts: boolean }) {
  const r = draft(db, runId);
  const earlier = db.get<{ month: string }>(
    "SELECT r.month FROM payroll_runs r WHERE r.month < ? AND NOT EXISTS (SELECT 1 FROM payroll_approvals a WHERE a.run_id = r.id) ORDER BY r.month LIMIT 1", [r.month]);
  if (earlier) throw conflict(`Approve the payroll for ${monthName(earlier.month)} first`);
  const latest = latestApproved(db);
  if (latest && r.month < latest) throw conflict(`Payroll for ${monthName(latest)} is already approved: an earlier month can't be approved now`);
  const rules = getSettings(db).payroll;
  if (!rules.gratuityDayRate || !rules.gratuityCap || !rules.salaryDayRate) throw badRequest("Choose how pay is worked out in Settings → Payroll first");
  const m = monthDays(r.month);
  checkNotLocked(db, m.to);
  // The gratuity brought forward at the books start must be in the books before the first payroll counts on it.
  if (o.posts) for (let i = 0; i < 1000 && postPending(db) > 0; i++);
  // Brought up to date first and kept, so a refusal below leaves the screen showing the payroll as it now stands.
  refreshRun(db, r.id);
  return db.tx(() => {
    const lines = draftLines(db, r.id);
    const total = totalsOf(lines).netWpsFils;
    if (typeof o.netWpsFils === "number" && o.netWpsFils !== total) throw conflict("The payroll changed since it was shown (leave, advances or pay): check it and approve again");
    const negative = lines.find((l) => l.netFils < 0);
    if (negative) throw badRequest(`${negative.name}'s pay comes to less than nothing: change the extras or the advance repayment`);
    for (const l of lines) {
      const e = db.get<EmpRow>("SELECT * FROM employees WHERE id = ?", [l.employeeId])!;
      if (gratuityAtStart(db, e) > 0 && broughtForward(db, e.id) === 0) {
        throw conflict(o.posts
          ? `${e.name}'s gratuity from before the books start couldn't be brought forward: see Books health`
          : `${e.name}'s gratuity from before the books start hasn't reached this computer yet: sync, then approve`);
      }
      const asOf = e.left_date && e.left_date < m.to ? e.left_date : m.to;
      const owed = gratuityOwed({
        basicFils: e.basic_fils, grossFils: e.basic_fils + e.housing_fils + e.transport_fils + e.other_allowance_fils,
        serviceYears: serviceYears(e.join_date, asOf, unpaidLeaveOf(db, e.id)), dayRate: rules.gratuityDayRate!, cap: rules.gratuityCap!,
      });
      // Someone already settled: the settlement released their gratuity, so this month puts none aside.
      const settled = db.get("SELECT 1 FROM settlement_approvals a JOIN final_settlements f ON f.id = a.settlement_id WHERE f.employee_id = ?", [e.id]);
      l.gratuityFils = settled ? 0 : owed - gratuityHeld(db, e.id);
    }
    const snapshot: Snapshot = { month: r.month, lines };
    db.run("INSERT INTO payroll_approvals (id, run_id, snapshot_json, approved_by, approved_at) VALUES (?, ?, ?, ?, ?)", [newId(), r.id, JSON.stringify(snapshot), userId, now()]);
    audit(db, { action: "payroll.approve", entity: "payroll_runs", entityId: r.id, after: { month: r.month, people: lines.length, netWpsFils: totalsOf(lines).netWpsFils }, userId });
    return getRun(db, r.id);
  });
}
