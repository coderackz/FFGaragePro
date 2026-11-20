import { advanceSchema, annualLeaveBalance, dubaiDate, employeeSchema, leaveSchema } from "@ffgp/shared";
import { checkNotLocked } from "../books/journals";
import { addDays } from "../books/post";
import { newId, now, type Db } from "../db";
import { getSettings } from "../settings";
import { badRequest, conflict, notFound } from "../errors";

const today = () => dubaiDate(new Date().toISOString());

/** Employee fields: the API's names and the table's columns. */
const FIELDS = [
  ["name", "name"], ["nameAr", "name_ar"], ["job", "job"], ["nationality", "nationality"], ["joinDate", "join_date"], ["leftDate", "left_date"],
  ["basicFils", "basic_fils"], ["housingFils", "housing_fils"], ["transportFils", "transport_fils"], ["otherAllowanceFils", "other_allowance_fils"],
  ["payMethod", "pay_method"], ["iban", "iban"], ["cardNumber", "card_number"], ["routingCode", "routing_code"], ["personId", "person_id"],
  ["emiratesId", "emirates_id"], ["emiratesIdExpiry", "emirates_id_expiry"], ["labourCard", "labour_card"], ["labourCardExpiry", "labour_card_expiry"],
  ["passport", "passport"], ["passportExpiry", "passport_expiry"], ["visa", "visa"], ["visaExpiry", "visa_expiry"],
  ["language", "language"], ["phone", "phone"], ["email", "email"], ["leaveBalanceDays", "leave_balance_days"], ["leaveBalanceDate", "leave_balance_date"],
] as const;
type Row = Record<string, unknown> & { id: string };
export type EmployeeOut = ReturnType<typeof employeeOut>;
export const employeeOut = (r: Row) => ({
  id: r.id,
  ...(Object.fromEntries(FIELDS.map(([api, col]) => [api, r[col] ?? null])) as Record<(typeof FIELDS)[number][0], never>),
  createdAt: r.created_at as string, updatedAt: r.updated_at as string,
}) as { id: string; createdAt: string; updatedAt: string } & {
  name: string; nameAr: string | null; job: string; nationality: string | null; joinDate: string; leftDate: string | null;
  basicFils: number; housingFils: number; transportFils: number; otherAllowanceFils: number; payMethod: "bank" | "salary_card";
  iban: string | null; cardNumber: string | null; routingCode: string | null; personId: string | null;
  emiratesId: string | null; emiratesIdExpiry: string | null; labourCard: string | null; labourCardExpiry: string | null;
  passport: string | null; passportExpiry: string | null; visa: string | null; visaExpiry: string | null;
  language: "en" | "en_ar"; phone: string | null; email: string | null; leaveBalanceDays: number | null; leaveBalanceDate: string | null;
};

/** What an approved final settlement was worked out on. */
export const FROZEN_AFTER_SETTLEMENT = ["joinDate", "leftDate", "basicFils", "housingFils", "transportFils", "otherAllowanceFils", "leaveBalanceDays", "leaveBalanceDate"] as const;
export const FROZEN_COLUMNS = ["join_date", "left_date", "basic_fils", "housing_fils", "transport_fils", "other_allowance_fils", "leave_balance_days", "leave_balance_date"];

const row = (db: Db, id: string) => db.get<Row>("SELECT * FROM employees WHERE id = ?", [id]);

export function listEmployees(db: Db, o: { includeLeft?: boolean } = {}) {
  return db.all<Row>(`SELECT * FROM employees ${o.includeLeft ? "" : "WHERE left_date IS NULL OR left_date >= ?"} ORDER BY name COLLATE NOCASE`, o.includeLeft ? [] : [today()])
    .map(employeeOut);
}

export function createEmployee(db: Db, input: unknown) {
  const e = employeeSchema.parse(input);
  const id = newId();
  const t = now();
  db.run(
    `INSERT INTO employees (id, ${FIELDS.map(([, c]) => c).join(", ")}, created_at, updated_at) VALUES (?, ${FIELDS.map(() => "?").join(", ")}, ?, ?)`,
    [id, ...FIELDS.map(([api]) => (e[api] ?? null) as string | number | null), t, t],
  );
  return employeeOut(row(db, id)!);
}

/** An edit: what was sent changes; the rest stays as it is (checked as a whole). */
export function updateEmployee(db: Db, id: string, input: unknown) {
  const current = row(db, id);
  if (!current) throw notFound("Employee not found");
  const before = employeeOut(current);
  const merged = { ...before, ...(input as object) };
  const e = employeeSchema.parse(merged);
  // An approved final settlement paid them on these: a change would pay days twice or not at all. A rehire is a new employee.
  if (db.get("SELECT 1 FROM settlement_approvals a JOIN final_settlements f ON f.id = a.settlement_id WHERE f.employee_id = ?", [id])) {
    const frozen = FROZEN_AFTER_SETTLEMENT.filter((k) => (e[k] ?? null) !== (before[k] ?? null));
    if (frozen.length) throw conflict(`${before.name} has an approved final settlement: their dates and pay can't change (a rehire is a new employee)`);
  }
  db.run(
    `UPDATE employees SET ${FIELDS.map(([, c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    [...FIELDS.map(([api]) => (e[api] ?? null) as string | number | null), now(), id],
  );
  return employeeOut(row(db, id)!);
}

interface LeaveRow { id: string; kind: string; from_date: string; to_date: string; note: string | null }
/** Leave that stands (cancelled leave counts for nothing). */
const leaveOf = (db: Db, employeeId: string) =>
  db.all<LeaveRow>("SELECT id, kind, from_date, to_date, note FROM employee_leave WHERE employee_id = ? AND cancelled_at IS NULL ORDER BY from_date", [employeeId])
    .map((l) => ({ id: l.id, kind: l.kind as "annual" | "sick" | "unpaid", from: l.from_date, to: l.to_date, note: l.note }));

export const unpaidLeaveOf = (db: Db, employeeId: string) => leaveOf(db, employeeId).filter((l) => l.kind === "unpaid");

export function addLeave(db: Db, employeeId: string, input: unknown, userId: string) {
  if (!row(db, employeeId)) throw notFound("Employee not found");
  const l = leaveSchema.parse(input);
  const clash = db.get<{ from_date: string; to_date: string }>(
    "SELECT from_date, to_date FROM employee_leave WHERE employee_id = ? AND cancelled_at IS NULL AND from_date <= ? AND to_date >= ?", [employeeId, l.to, l.from]);
  if (clash) throw conflict(`That overlaps leave from ${clash.from_date} to ${clash.to_date}`);
  const id = newId();
  const t = now();
  db.run("INSERT INTO employee_leave (id, employee_id, kind, from_date, to_date, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    id, employeeId, l.kind, l.from, l.to, l.note, userId, t, t,
  ]);
  return { id, ...l };
}

/** Leave entered by mistake: cancelled, it no longer counts (a payroll already approved keeps what it paid). */
export function cancelLeave(db: Db, employeeId: string, leaveId: string) {
  const l = db.get<{ cancelled_at: string | null }>("SELECT cancelled_at FROM employee_leave WHERE id = ? AND employee_id = ?", [leaveId, employeeId]);
  if (!l) throw notFound("Leave not found");
  if (l.cancelled_at) throw conflict("That leave is already cancelled");
  db.run("UPDATE employee_leave SET cancelled_at = ?, updated_at = ? WHERE id = ?", [now(), now(), leaveId]);
  return { id: leaveId };
}

/** What approved payrolls (and an approved final settlement) took back from someone's pay towards advances. */
const repaidFromSalary = (db: Db, employeeId: string) =>
  db.all<{ snapshot_json: string }>("SELECT snapshot_json FROM payroll_approvals").reduce((s, a) =>
    s + (JSON.parse(a.snapshot_json) as { lines: { employeeId: string; advanceRepaymentFils: number }[] }).lines
      .filter((l) => l.employeeId === employeeId).reduce((t, l) => t + l.advanceRepaymentFils, 0), 0)
  // A settlement clears all advances still owed: what it took back, and any part forgiven (written off to salaries).
  + db.all<{ snapshot_json: string }>(
    "SELECT a.snapshot_json FROM settlement_approvals a JOIN final_settlements f ON f.id = a.settlement_id WHERE f.employee_id = ?", [employeeId],
  ).reduce((s, a) => {
    const x = JSON.parse(a.snapshot_json) as { advancesOwedFils?: number; items: { key: string; amountFils: number }[] };
    return s + (x.advancesOwedFils ?? -(x.items.find((i) => i.key === "advances")?.amountFils ?? 0));
  }, 0);

/** Advances paid to an employee, with what's still owed on each (repayments go oldest first; cancelled ones owe nothing). */
export function advancesOf(db: Db, employeeId: string) {
  const list = db.all<{ id: string; amount_fils: number; paid_on: string; instalment_fils: number; note: string | null; cancelled_on: string | null }>(
    "SELECT id, amount_fils, paid_on, instalment_fils, note, cancelled_on FROM staff_advances WHERE employee_id = ? ORDER BY paid_on, created_at", [employeeId]);
  let repaid = repaidFromSalary(db, employeeId);
  return list.map((a) => {
    const used = a.cancelled_on ? 0 : Math.min(repaid, a.amount_fils);
    repaid -= used;
    return {
      id: a.id, amountFils: a.amount_fils, paidOn: a.paid_on, instalmentFils: a.instalment_fils, note: a.note, cancelled: !!a.cancelled_on,
      repaidFils: used, owedFils: a.cancelled_on ? 0 : a.amount_fils - used,
    };
  });
}

export function addAdvance(db: Db, employeeId: string, input: unknown, userId: string) {
  if (!row(db, employeeId)) throw notFound("Employee not found");
  const a = advanceSchema.parse(input);
  const from = db.get<{ money_kind: string | null; active: number }>("SELECT money_kind, active FROM accounts WHERE id = ?", [a.paidFromAccountId]);
  if (!from?.money_kind || !from.active || !["cash", "bank"].includes(from.money_kind)) throw badRequest("Pay an advance from a cash or bank account");
  // One paid before the books started is part of the opening position (it posts against opening balance clearing).
  const start = getSettings(db).books.startDate;
  if (!start || a.paidOn >= start) checkNotLocked(db, a.paidOn);
  const id = newId();
  const t = now();
  db.run(
    "INSERT INTO staff_advances (id, employee_id, amount_fils, paid_on, paid_from_account_id, instalment_fils, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, employeeId, a.amountFils, a.paidOn, a.paidFromAccountId, a.instalmentFils, a.note, userId, t, t],
  );
  return { id, ...a };
}

/** An advance paid by mistake and given back: cancelled today, its payment is reversed. Not once salary has repaid any of it. */
export function cancelAdvance(db: Db, employeeId: string, advanceId: string) {
  const a = advancesOf(db, employeeId).find((x) => x.id === advanceId);
  if (!a) throw notFound("Advance not found");
  if (a.cancelled) throw conflict("That advance is already cancelled");
  if (a.repaidFils > 0) throw conflict("Salary has already repaid part of this advance: it can't be cancelled");
  const day = today();
  checkNotLocked(db, day);
  db.run("UPDATE staff_advances SET cancelled_on = ?, updated_at = ? WHERE id = ?", [day, now(), advanceId]);
  return { id: advanceId, cancelledOn: day };
}

const DOCUMENTS = [["emirates_id_expiry", "Emirates ID"], ["labour_card_expiry", "Labour card"], ["passport_expiry", "Passport"], ["visa_expiry", "Visa"]] as const;

/** Staff documents expired or expiring within `within` days (current staff only), soonest first. */
export function expiringDocuments(db: Db, within = 30) {
  const until = addDays(today(), within);
  return listEmployees(db).flatMap((e) => {
    const r = row(db, e.id)!;
    return DOCUMENTS.filter(([col]) => r[col] && (r[col] as string) <= until)
      .map(([col, document]) => ({ employeeId: e.id, name: e.name, document, expires: r[col] as string }));
  }).sort((a, b) => a.expires.localeCompare(b.expires));
}

export function getEmployee(db: Db, id: string) {
  const r = row(db, id);
  if (!r) throw notFound("Employee not found");
  const e = employeeOut(r);
  const leave = leaveOf(db, id);
  const advances = advancesOf(db, id);
  const on = today();
  return {
    ...e, leave, advances,
    advanceOwedFils: advances.reduce((s, a) => s + a.owedFils, 0),
    annualLeaveDays: annualLeaveBalance(e.joinDate, on, leave.filter((l) => l.kind === "annual" && l.from <= on),
      e.leaveBalanceDays !== null && e.leaveBalanceDate ? { days: e.leaveBalanceDays, date: e.leaveBalanceDate } : null),
    expiring: expiringDocuments(db).filter((d) => d.employeeId === id),
  };
}
