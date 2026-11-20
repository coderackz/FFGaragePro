import { advanceSchema, annualLeaveBalance, dubaiDate, employeeSchema, leaveSchema } from "@ffgp/shared";
import { checkNotLocked } from "../books/journals";
import { addDays } from "../books/post";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";

const today = () => dubaiDate(new Date().toISOString());

/** Employee fields: the API's names and the table's columns. */
const FIELDS = [
  ["name", "name"], ["nameAr", "name_ar"], ["job", "job"], ["nationality", "nationality"], ["joinDate", "join_date"], ["leftDate", "left_date"],
  ["basicFils", "basic_fils"], ["housingFils", "housing_fils"], ["transportFils", "transport_fils"], ["otherAllowanceFils", "other_allowance_fils"],
  ["payMethod", "pay_method"], ["iban", "iban"], ["cardNumber", "card_number"], ["routingCode", "routing_code"], ["personId", "person_id"],
  ["emiratesId", "emirates_id"], ["emiratesIdExpiry", "emirates_id_expiry"], ["labourCard", "labour_card"], ["labourCardExpiry", "labour_card_expiry"],
  ["passport", "passport"], ["passportExpiry", "passport_expiry"], ["visa", "visa"], ["visaExpiry", "visa_expiry"],
  ["language", "language"], ["phone", "phone"], ["email", "email"],
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
  language: "en" | "en_ar"; phone: string | null; email: string | null;
};

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
  const merged = { ...employeeOut(current), ...(input as object) };
  const e = employeeSchema.parse(merged);
  db.run(
    `UPDATE employees SET ${FIELDS.map(([, c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    [...FIELDS.map(([api]) => (e[api] ?? null) as string | number | null), now(), id],
  );
  return employeeOut(row(db, id)!);
}

interface LeaveRow { id: string; kind: string; from_date: string; to_date: string; note: string | null }
const leaveOf = (db: Db, employeeId: string) =>
  db.all<LeaveRow>("SELECT id, kind, from_date, to_date, note FROM employee_leave WHERE employee_id = ? ORDER BY from_date", [employeeId])
    .map((l) => ({ id: l.id, kind: l.kind as "annual" | "sick" | "unpaid", from: l.from_date, to: l.to_date, note: l.note }));

export const unpaidLeaveOf = (db: Db, employeeId: string) => leaveOf(db, employeeId).filter((l) => l.kind === "unpaid");

export function addLeave(db: Db, employeeId: string, input: unknown, userId: string) {
  if (!row(db, employeeId)) throw notFound("Employee not found");
  const l = leaveSchema.parse(input);
  const clash = db.get<{ from_date: string; to_date: string }>(
    "SELECT from_date, to_date FROM employee_leave WHERE employee_id = ? AND from_date <= ? AND to_date >= ?", [employeeId, l.to, l.from]);
  if (clash) throw conflict(`That overlaps leave from ${clash.from_date} to ${clash.to_date}`);
  const id = newId();
  db.run("INSERT INTO employee_leave (id, employee_id, kind, from_date, to_date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id, employeeId, l.kind, l.from, l.to, l.note, userId, now(),
  ]);
  return { id, ...l };
}

/** Advances paid to an employee, with what's still owed on each (repayments in approved runs go oldest first). */
export function advancesOf(db: Db, employeeId: string) {
  const list = db.all<{ id: string; amount_fils: number; paid_on: string; instalment_fils: number; note: string | null }>(
    "SELECT id, amount_fils, paid_on, instalment_fils, note FROM staff_advances WHERE employee_id = ? ORDER BY paid_on, created_at", [employeeId]);
  let repaid = db.get<{ r: number | null }>(
    "SELECT SUM(l.advance_repayment_fils) AS r FROM payroll_lines l JOIN payroll_runs p ON p.id = l.run_id WHERE l.employee_id = ? AND p.status = 'approved'", [employeeId])!.r ?? 0;
  return list.map((a) => {
    const used = Math.min(repaid, a.amount_fils);
    repaid -= used;
    return { id: a.id, amountFils: a.amount_fils, paidOn: a.paid_on, instalmentFils: a.instalment_fils, note: a.note, owedFils: a.amount_fils - used };
  });
}

export function addAdvance(db: Db, employeeId: string, input: unknown, userId: string) {
  if (!row(db, employeeId)) throw notFound("Employee not found");
  const a = advanceSchema.parse(input);
  const from = db.get<{ money_kind: string | null; active: number }>("SELECT money_kind, active FROM accounts WHERE id = ?", [a.paidFromAccountId]);
  if (!from?.money_kind || !from.active || !["cash", "bank"].includes(from.money_kind)) throw badRequest("Pay an advance from a cash or bank account");
  checkNotLocked(db, a.paidOn);
  const id = newId();
  db.run(
    "INSERT INTO staff_advances (id, employee_id, amount_fils, paid_on, paid_from_account_id, instalment_fils, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, employeeId, a.amountFils, a.paidOn, a.paidFromAccountId, a.instalmentFils, a.note, userId, now()],
  );
  return { id, ...a };
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
    annualLeaveDays: annualLeaveBalance(e.joinDate, on, leave.filter((l) => l.kind === "annual" && l.from <= on)),
    expiring: expiringDocuments(db).filter((d) => d.employeeId === id),
  };
}
