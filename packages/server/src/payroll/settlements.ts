import { dubaiDate, proposeLine, settlementEditSchema, settlementProposal, settlementTotal, type SettlementItem, type SettlementKey } from "@ffgp/shared";
import { checkNotLocked } from "../books/journals";
import { formatDay } from "../books/post";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { getSettings } from "../settings";
import { advancesOf, unpaidLeaveOf } from "./employees";
import { postPending } from "../books/pending";
import { broughtForward, gratuityAtStart, gratuityHeld, refreshRun, stableId, type Snapshot } from "./runs";
import { audit } from "../audit";

interface EmpRow {
  id: string; name: string; job: string; join_date: string; left_date: string | null;
  basic_fils: number; housing_fils: number; transport_fils: number; other_allowance_fils: number; leave_balance_days: number | null; leave_balance_date: string | null;
}
interface Row { id: string; employee_id: string; edit_salary: string | null; edit_leave: string | null; edit_gratuity: string | null; edit_advances: string | null; created_at: string }
const KEYS: SettlementKey[] = ["salary", "leave", "gratuity", "advances"];
const NO_EDITS = { edit_salary: null, edit_leave: null, edit_gratuity: null, edit_advances: null };
export interface SettlementSnapshot {
  employeeId: string; name: string; job: string; joinDate: string; lastDay: string; items: SettlementItem[]; totalFils: number;
  gratuityHeldFils: number; salaryBasicFils: number;
  /** Advances owed when settled: all cleared (what wasn't deducted is forgiven, written off to salaries). */
  advancesOwedFils: number;
}

const rowOf = (db: Db, idOrEmployee: string) => db.get<Row>("SELECT * FROM final_settlements WHERE id = ? OR employee_id = ?", [idOrEmployee, idOrEmployee]);
const approvalOf = (db: Db, id: string) => db.get<{ snapshot_json: string; approved_at: string }>("SELECT snapshot_json, approved_at FROM settlement_approvals WHERE settlement_id = ?", [id]);
const paymentOf = (db: Db, id: string) => db.get<{ paid_on: string }>("SELECT paid_on FROM settlement_payments WHERE settlement_id = ?", [id]);
const employee = (db: Db, id: string) => db.get<EmpRow>("SELECT * FROM employees WHERE id = ?", [id]);

function rules(db: Db) {
  const r = getSettings(db).payroll;
  if (!r.salaryDayRate || !r.gratuityDayRate || !r.gratuityCap || !r.leaveBasis) throw badRequest("Choose how pay is worked out in Settings → Payroll first");
  return { salaryDayRate: r.salaryDayRate, gratuityDayRate: r.gratuityDayRate, gratuityCap: r.gratuityCap, leaveBasis: r.leaveBasis };
}

/** Has an approved payroll already paid this person's days in their leaving month? */
function salaryPaid(db: Db, employeeId: string, lastDay: string): boolean {
  const a = db.get<{ snapshot_json: string }>(
    "SELECT a.snapshot_json FROM payroll_approvals a JOIN payroll_runs r ON r.id = a.run_id WHERE r.month = ?", [lastDay.slice(0, 7)]);
  return !!a && (JSON.parse(a.snapshot_json) as Snapshot).lines.some((l) => l.employeeId === employeeId);
}

/** The settlement as it would be approved now: the proposal, with the accountant's changed amounts and reasons. */
function current(db: Db, r: Row): SettlementSnapshot {
  const e = employee(db, r.employee_id)!;
  if (!e.left_date) throw badRequest("Enter the day they leave on the employee first");
  const leave = db.all<{ kind: string; from_date: string; to_date: string }>(
    "SELECT kind, from_date, to_date FROM employee_leave WHERE employee_id = ? AND cancelled_at IS NULL", [e.id]);
  const rule = rules(db);
  const pay = { basicFils: e.basic_fils, housingFils: e.housing_fils, transportFils: e.transport_fils, otherAllowanceFils: e.other_allowance_fils, joinDate: e.join_date, leftDate: e.left_date };
  const paid = salaryPaid(db, e.id, e.left_date);
  const gratuityHeldFils = gratuityHeld(db, e.id);
  const advancesOwedFils = advancesOf(db, e.id).reduce((s, a) => s + a.owedFils, 0);
  const items = settlementProposal({
    employee: pay, lastDay: e.left_date, unpaidLeave: unpaidLeaveOf(db, e.id), booksStart: getSettings(db).books.startDate,
    leaveOpening: e.leave_balance_days !== null && e.leave_balance_date ? { days: e.leave_balance_days, date: e.leave_balance_date } : null,
    annualTaken: leave.filter((l) => l.kind === "annual" && l.from_date <= e.left_date!).map((l) => ({ from: l.from_date, to: l.to_date })),
    rules: rule, salaryAlreadyPaid: paid, gratuityHeldFils, advancesOwedFils,
  });
  for (const i of items) {
    const raw = r[`edit_${i.key}` as keyof Row] as string | null;
    const ed = raw ? (JSON.parse(raw) as { amountFils: number; reason: string }) : null;
    if (ed) { i.amountFils = ed.amountFils; i.reason = ed.reason; }
  }
  // The salary splits between basic and allowances as the proposal did (a changed amount keeps the same split).
  const line = proposeLine({ month: e.left_date.slice(0, 7), employee: pay, unpaidLeave: unpaidLeaveOf(db, e.id), salaryDayRate: rule.salaryDayRate, advanceDueFils: 0 });
  const salary = items.find((i) => i.key === "salary")!;
  const proposedGross = line.basicFils + line.allowancesFils;
  // The salary splits between basic and allowances as the proposal did; when the payroll already paid it, by the pay itself.
  const gross = e.basic_fils + e.housing_fils + e.transport_fils + e.other_allowance_fils;
  const salaryBasicFils = paid || !proposedGross
    ? (gross ? Math.round((salary.amountFils * e.basic_fils) / gross) : salary.amountFils)
    : Math.round((salary.amountFils * line.basicFils) / proposedGross);
  return { employeeId: e.id, name: e.name, job: e.job, joinDate: e.join_date, lastDay: e.left_date, items, totalFils: settlementTotal(items), gratuityHeldFils, salaryBasicFils, advancesOwedFils };
}

export function getSettlement(db: Db, idOrEmployee: string) {
  const r = rowOf(db, idOrEmployee);
  if (!r) throw notFound("No final settlement yet");
  const a = approvalOf(db, r.id);
  const s = a ? (JSON.parse(a.snapshot_json) as SettlementSnapshot) : current(db, r);
  return { id: r.id, ...s, status: a ? ("approved" as const) : ("draft" as const), approvedAt: a?.approved_at ?? null, paidOn: paymentOf(db, r.id)?.paid_on ?? null };
}

/** Starts a leaver's final settlement (once their last day is entered and the pay rules are chosen). */
export function openSettlement(db: Db, employeeId: string, userId: string) {
  const e = employee(db, employeeId);
  if (!e) throw notFound("Employee not found");
  if (!e.left_date) throw badRequest("Enter the day they leave on the employee first");
  rules(db);
  if (rowOf(db, employeeId)) throw conflict(`${e.name} already has a final settlement`);
  const t = now();
  db.run("INSERT INTO final_settlements (id, employee_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    stableId(`settlement|${employeeId}`), employeeId, userId, t, t,
  ]);
  // Draft payrolls from the leaving month on drop them now (the settlement pays their days).
  for (const run of db.all<{ id: string }>(
    "SELECT r.id FROM payroll_runs r WHERE r.month >= ? AND NOT EXISTS (SELECT 1 FROM payroll_approvals a WHERE a.run_id = r.id)", [e.left_date.slice(0, 7)])) refreshRun(db, run.id);
  return getSettlement(db, employeeId);
}

const draft = (db: Db, id: string) => {
  const r = rowOf(db, id);
  if (!r) throw notFound("Final settlement not found");
  if (approvalOf(db, r.id)) throw conflict("This settlement is approved: it can't change");
  return r;
};

/** Changes one amount, with the reason (kept and printed). Back to the proposed amount, the change is dropped. */
export function editSettlement(db: Db, id: string, input: unknown) {
  const r = draft(db, id);
  const x = settlementEditSchema.parse(input);
  const proposed = current(db, { ...r, ...NO_EDITS }).items.find((i) => i.key === x.key)!;
  // Each amount within what it can be: salary and gratuity aren't negative; advances are taken back (up to what's owed), never added.
  if ((x.key === "salary" || x.key === "gratuity") && x.amountFils < 0) throw badRequest(`${proposed.label} can't be less than nothing`);
  if (x.key === "advances" && (x.amountFils > 0 || x.amountFils < proposed.proposedFils)) {
    throw badRequest(`Advances are taken back: between ${(proposed.proposedFils / 100).toFixed(2)} (all that's owed) and 0.00 (all forgiven)`);
  }
  const edit = x.amountFils === proposed.proposedFils ? null : JSON.stringify({ amountFils: x.amountFils, reason: x.reason });
  if (!KEYS.includes(x.key)) throw badRequest("Unknown item");
  db.run(`UPDATE final_settlements SET edit_${x.key} = ?, updated_at = ? WHERE id = ?`, [edit, now(), r.id]);
  return getSettlement(db, r.id);
}

/** The owner approves what they were shown (`totalFils`): kept exactly as approved, for the books and the letter. */
export function approveSettlement(db: Db, id: string, userId: string, input: { totalFils?: unknown }, posts: boolean) {
  const r = draft(db, id);
  // The gratuity brought forward at the books start must be in the books before the settlement counts on it.
  if (posts) for (let i = 0; i < 1000 && postPending(db) > 0; i++);
  const e = employee(db, r.employee_id)!;
  if (gratuityAtStart(db, e) > 0 && broughtForward(db, e.id) === 0) {
    throw conflict(posts
      ? `${e.name}'s gratuity from before the books start couldn't be brought forward: see Books health`
      : `${e.name}'s gratuity from before the books start hasn't reached this computer yet: sync, then approve`);
  }
  // A last day in a locked month posts on the first open day; one before the books posts at their start (opening clearing).
  const s = current(db, r);
  if (typeof input.totalFils === "number" && input.totalFils !== s.totalFils) throw conflict("The settlement changed since it was shown: check it and approve again");
  db.tx(() => {
    db.run("INSERT INTO settlement_approvals (id, settlement_id, snapshot_json, approved_by, approved_at) VALUES (?, ?, ?, ?, ?)", [newId(), r.id, JSON.stringify(s), userId, now()]);
    audit(db, { action: "settlement.approve", entity: "final_settlements", entityId: r.id, after: { employee: s.name, lastDay: s.lastDay, totalFils: s.totalFils }, userId });
  });
  return getSettlement(db, r.id);
}

/** Paid out, from a bank or cash box, on or after the last day: once. */
export function markSettlementPaid(db: Db, id: string, input: { date?: unknown; accountId?: unknown }, userId: string) {
  const s = getSettlement(db, id);
  if (s.status !== "approved") throw conflict("Approve the settlement first");
  if (s.paidOn) throw conflict(`Already marked paid on ${formatDay(s.paidOn)}`);
  const a = typeof input.accountId === "string" ? db.get<{ money_kind: string | null; active: number }>("SELECT money_kind, active FROM accounts WHERE id = ?", [input.accountId]) : undefined;
  if (!a?.active || !["bank", "cash"].includes(a.money_kind ?? "")) throw badRequest("Pay a settlement from a bank or cash account");
  if (typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date < s.lastDay) throw badRequest("Use a date on or after the last day");
  checkNotLocked(db, input.date);
  if (input.date > dubaiDate(new Date().toISOString())) throw badRequest("A payment can't be dated in the future");
  db.tx(() => {
    db.run("INSERT INTO settlement_payments (id, settlement_id, paid_on, account_id, amount_fils, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      newId(), s.id, input.date as string, input.accountId as string, s.totalFils, userId, now(),
    ]);
    audit(db, { action: "settlement.paid", entity: "final_settlements", entityId: s.id, after: { employee: s.name, paidOn: input.date, amountFils: s.totalFils }, userId });
  });
  return getSettlement(db, s.id);
}
