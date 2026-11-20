import { buildSif, monthDays } from "@ffgp/shared";
import { checkNotLocked } from "../books/journals";
import { newId, now, type Db } from "../db";
import { audit } from "../audit";
import { badRequest, conflict } from "../errors";
import { formatDay } from "../books/post";
import { getSettings } from "../settings";
import { getRun } from "./runs";

const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const approved = (db: Db, runId: string) => {
  const run = getRun(db, runId);
  if (run.status !== "approved") throw conflict("Approve the payroll first");
  return run;
};
const moneyKind = (db: Db, id: unknown) =>
  typeof id === "string" ? db.get<{ money_kind: string | null; active: number }>("SELECT money_kind, active FROM accounts WHERE id = ?", [id]) : undefined;

interface Pay { employee_id: string; person_id: string | null; routing_code: string | null; iban: string | null; card_number: string | null; pay_method: string; name: string; join_date: string; left_date: string | null }

/** The month's WPS salary file: fixed pay is the net, the bonus is variable pay only when it goes through WPS. */
export function wpsFile(db: Db, runId: string) {
  const run = approved(db, runId);
  const s = getSettings(db).payroll;
  const m = monthDays(run.month);
  const pay = new Map(db.all<Pay>("SELECT id AS employee_id, person_id, routing_code, iban, card_number, pay_method, name, join_date, left_date FROM employees").map((p) => [p.employee_id, p]));
  const reference = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(`${run.month}-01T00:00:00Z`)).toUpperCase() + run.month.slice(2, 4);
  try {
    return buildSif({
      establishmentId: s.establishmentId, employerRoutingCode: s.employerRoutingCode, month: run.month, createdAt: new Date(), reference,
      lines: run.lines.map((l) => {
        const p = pay.get(l.employeeId)!;
        return {
          name: l.name, personId: p.person_id, routingCode: p.routing_code, account: p.pay_method === "salary_card" ? p.card_number : p.iban,
          // A joiner's or leaver's own days in the month.
          from: p.join_date > m.from ? p.join_date : m.from, to: p.left_date && p.left_date < m.to ? p.left_date : m.to, days: l.workedDays, fixedFils: l.netFils, variableFils: l.bonusInWps ? l.bonusFils : 0, leaveDays: l.unpaidDays,
        };
      }),
    });
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}

/** The salaries went out through WPS: once, from a bank account, on or after the month end. */
/** A payment made: recorded once per run and kind (insert-only, so the first place to record it wins). */
const record = (db: Db, runId: string, kind: "wps" | "bonus", date: string, accountId: string, amountFils: number, userId: string) =>
  db.tx(() => {
    db.run("INSERT INTO payroll_payments (id, run_id, kind, paid_on, account_id, amount_fils, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      newId(), runId, kind, date, accountId, amountFils, userId, now(),
    ]);
    audit(db, { action: "payroll.paid", entity: "payroll_runs", entityId: runId, after: { kind, paidOn: date, amountFils }, userId });
  });

export function markWpsPaid(db: Db, runId: string, input: { date?: unknown; bankAccountId?: unknown }, userId: string) {
  const run = approved(db, runId);
  if (run.wpsPaidOn) throw conflict(`Already marked paid on ${formatDay(run.wpsPaidOn)}`);
  const bank = moneyKind(db, input.bankAccountId);
  if (bank?.money_kind !== "bank" || !bank.active) throw badRequest("Salaries are paid from a bank account");
  if (!isYmd(input.date) || input.date < monthDays(run.month).to) throw badRequest("Use a date on or after the month end");
  checkNotLocked(db, input.date);
  record(db, run.id, "wps", input.date, input.bankAccountId as string, run.totals.netWpsFils, userId);
  return getRun(db, run.id);
}

const cashBonuses = (run: ReturnType<typeof getRun>) => run.lines.filter((l) => l.bonusFils > 0 && !l.bonusInWps);

/** The cash bonuses were handed out (on the signed voucher): once, from a cash box. */
export function markBonusPaid(db: Db, runId: string, input: { date?: unknown; cashAccountId?: unknown }, userId: string) {
  const run = approved(db, runId);
  if (!cashBonuses(run).length) throw conflict("There are no cash bonuses in this payroll");
  if (run.bonusPaidOn) throw conflict(`Already marked paid on ${formatDay(run.bonusPaidOn)}`);
  const cash = moneyKind(db, input.cashAccountId);
  if (cash?.money_kind !== "cash" || !cash.active) throw badRequest("Cash bonuses are paid from a cash account");
  if (!isYmd(input.date) || input.date < monthDays(run.month).to) throw badRequest("Use a date on or after the month end");
  checkNotLocked(db, input.date);
  record(db, run.id, "bonus", input.date, input.cashAccountId as string, run.totals.cashBonusFils, userId);
  return getRun(db, run.id);
}

/** The cash bonus voucher: who gets what, to sign for. */
export function bonusVoucher(db: Db, runId: string) {
  const run = approved(db, runId);
  const lines = cashBonuses(run).map((l) => ({ employeeId: l.employeeId, name: l.name, job: l.job, bonusFils: l.bonusFils }));
  return { month: run.month, lines, totalFils: lines.reduce((s, l) => s + l.bonusFils, 0) };
}

interface Emp { id: string; name: string; name_ar: string | null; job: string; language: "en" | "en_ar"; person_id: string | null; housing_fils: number; transport_fils: number; other_allowance_fils: number; pay_method: string }

/** One payslip per person: pay, deductions, the bonus, and what was paid how. Allowances keep the employee's split. */
export function payslips(db: Db, runId: string) {
  const run = approved(db, runId);
  return run.lines.map((l) => {
    const e = db.get<Emp>("SELECT * FROM employees WHERE id = ?", [l.employeeId])!;
    // The month's allowances in the employee's proportions; the rounding goes to the largest, so none prints below zero.
    const parts = [e.housing_fils, e.transport_fils, e.other_allowance_fils];
    const full = parts.reduce((a, b) => a + b, 0);
    const shares = parts.map((p) => (full ? Math.floor((l.allowancesFils * p) / full) : 0));
    shares[parts.indexOf(Math.max(...parts))]! += l.allowancesFils - shares.reduce((a, b) => a + b, 0);
    const [housing, transport] = shares as [number, number, number];
    return {
      employee: { id: e.id, name: e.name, nameAr: e.name_ar, job: e.job, language: e.language, personId: e.person_id },
      month: run.month, workedDays: l.workedDays, basicFils: l.basicFils, allowances: { housing, transport, other: shares[2]! },
      unpaidDays: l.unpaidDays, unpaidDeductionFils: l.unpaidDeductionFils, advanceRepaymentFils: l.advanceRepaymentFils, extrasFils: l.extrasFils,
      extrasNote: l.extrasNote, bonusFils: l.bonusFils, bonusInWps: l.bonusInWps, netWpsFils: l.netFils + (l.bonusInWps ? l.bonusFils : 0),
      paidBy: e.pay_method === "salary_card" ? "Salary card (WPS)" : "Bank transfer (WPS)",
    };
  });
}
