import { newId, now, type Db } from "./db";

export type AuditAction =
  | "settings.change" | "discount.approve" | "user.create" | "user.update" | "backup.restore"
  | "credit.override" | "receipt.create" | "receipt.allocate" | "credit_note.issue"
  | "payroll.approve" | "payroll.paid" | "settlement.approve" | "settlement.paid" | "promo.override";

export interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  userId: string | null;
}

/** Appends to the activity log (never edited or deleted). Call inside the transaction that made the change. */
export function audit(db: Db, e: AuditEntry): void {
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  db.run(
    "INSERT INTO audit_log (id, action, entity, entity_id, before, after, user_id, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [newId(), e.action, e.entity, e.entityId ?? null, json(e.before), json(e.after), e.userId, db.device, now()],
  );
}
