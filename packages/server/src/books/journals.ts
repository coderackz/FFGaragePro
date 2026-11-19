import { journalDraftSchema, journalLineSchema, SYSTEM_ACCOUNTS, type JournalLineInput } from "@ffgp/shared";
import { z } from "zod";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { getSettings } from "../settings";
import { addDays, formatDay, postEntry, type PostLine } from "./post";

export const NOT_HERE = "Post from the browser app: this garage's books are kept in the cloud.";

// ── Drafts (editable, synced; may be unbalanced until posted) ─────────────────────────────────────────────────────
const draftLine = z.object({
  accountId: z.string().min(1),
  debitFils: z.number().int().min(0).default(0),
  creditFils: z.number().int().min(0).default(0),
  customerId: z.string().nullable().optional().transform((v) => v ?? null),
  supplierId: z.string().nullable().optional().transform((v) => v ?? null),
  memo: z.string().max(200).nullable().optional().transform((v) => v ?? null),
});
const draftSchema = z.object({
  kind: z.enum(["manual", "opening"]).default("manual"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31"),
  narration: z.string().trim().max(300).default(""),
  lines: z.array(draftLine).max(200).default([]),
});
/** An edit: only what was sent changes (no defaults, so untouched fields stay as they are). */
const draftPatch = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31").optional(),
  narration: z.string().trim().max(300).optional(),
  lines: z.array(draftLine).max(200).optional(),
});

interface DraftRow { id: string; kind: string; date: string; narration: string; lines_json: string; created_by: string | null; created_at: string; updated_at: string }
const draftOut = (d: DraftRow) => ({
  id: d.id, kind: d.kind as "manual" | "opening", date: d.date, narration: d.narration, lines: JSON.parse(d.lines_json) as z.infer<typeof draftLine>[],
  createdBy: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at,
});
export type DraftOut = ReturnType<typeof draftOut>;

export const listDrafts = (db: Db) => db.all<DraftRow>("SELECT * FROM journal_drafts ORDER BY updated_at DESC").map(draftOut);
const getDraft = (db: Db, id: string) => {
  const d = db.get<DraftRow>("SELECT * FROM journal_drafts WHERE id = ?", [id]);
  return d ? draftOut(d) : null;
};

export function createDraft(db: Db, input: unknown, userId: string): DraftOut {
  const d = draftSchema.parse(input);
  const id = newId();
  const t = now();
  db.run("INSERT INTO journal_drafts (id, kind, date, narration, lines_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id, d.kind, d.date, d.narration, JSON.stringify(d.lines), userId, t, t,
  ]);
  return getDraft(db, id)!;
}

export function updateDraft(db: Db, id: string, input: unknown): DraftOut {
  const d = getDraft(db, id);
  if (!d) throw notFound("Draft not found");
  const p = draftPatch.parse(input);
  db.run("UPDATE journal_drafts SET date = ?, narration = ?, lines_json = ?, updated_at = ? WHERE id = ?", [
    p.date ?? d.date, p.narration ?? d.narration, JSON.stringify(p.lines ?? d.lines), now(), id,
  ]);
  return getDraft(db, id)!;
}

export function deleteDraft(db: Db, id: string): void {
  if (!db.run("DELETE FROM journal_drafts WHERE id = ?", [id])) throw notFound("Draft not found");
}

// ── Posted entries ──────────────────────────────────────────────────────────────────────────────────────────────────
interface EntryRow {
  id: string; number: string; date: string; narration: string; source_type: string; source_id: string | null; reverses_id: string | null;
  original_date: string | null; created_by_name: string | null; created_at: string; reversed_by: string | null; source_number: string | null;
}
const SOURCE_NUMBER = `COALESCE((SELECT number FROM documents WHERE id = e.source_id), (SELECT number FROM receipts WHERE id = e.source_id),
  (SELECT supplier_invoice_no FROM goods_receipts WHERE id = e.source_id))`;
export const ENTRY_SELECT = `SELECT e.*, u.name AS created_by_name, (SELECT r.id FROM journal_entries r WHERE r.reverses_id = e.id) AS reversed_by,
  ${SOURCE_NUMBER} AS source_number FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by`;

export function entryOut(db: Db, e: EntryRow) {
  const lines = db.all<{ id: string; account_id: string; code: string; name: string; debit_fils: number; credit_fils: number; customer_id: string | null; supplier_id: string | null; document_id: string | null; memo: string | null }>(
    `SELECT l.*, a.code, a.name FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.position`,
    [e.id],
  );
  return {
    id: e.id, number: e.number, date: e.date, narration: e.narration, sourceType: e.source_type, sourceId: e.source_id, sourceNumber: e.source_number,
    reversesId: e.reverses_id, reversedBy: e.reversed_by, originalDate: e.original_date, createdBy: e.created_by_name, createdAt: e.created_at,
    lines: lines.map((l) => ({
      id: l.id, accountId: l.account_id, code: l.code, name: l.name, debitFils: l.debit_fils, creditFils: l.credit_fils,
      customerId: l.customer_id, supplierId: l.supplier_id, documentId: l.document_id, memo: l.memo,
    })),
  };
}
export type EntryOut = ReturnType<typeof entryOut>;

export function getEntry(db: Db, id: string): EntryOut | null {
  const e = db.get<EntryRow>(`${ENTRY_SELECT} WHERE e.id = ?`, [id]);
  return e ? entryOut(db, e) : null;
}

const lockedError = (lockDate: string) => badRequest(`The books are locked up to ${formatDay(lockDate)}`);

/** Refuses a date a person chose inside the locked period (automatic events move to the first open day instead). */
export function checkNotLocked(db: Db, date: string): void {
  const { lockDate } = getSettings(db).books;
  if (lockDate && date <= lockDate) throw lockedError(lockDate);
}

function checkAccounts(db: Db, lines: JournalLineInput[]): void {
  for (const l of lines) {
    const a = db.get<{ active: number }>("SELECT active FROM accounts WHERE id = ?", [l.accountId]);
    if (!a) throw badRequest("A line's account doesn't exist");
    if (!a.active) throw badRequest("A line's account is switched off");
  }
}

const toPostLines = (lines: JournalLineInput[]): PostLine[] =>
  lines.map((l) => ({ accountId: l.accountId, debitFils: l.debitFils, creditFils: l.creditFils, customerId: l.customerId, supplierId: l.supplierId, memo: l.memo }));

/**
 * Posts a draft. A manual journal: balanced, dated outside the lock. The opening balances: dated the day before the
 * books start, made to balance on Opening balance equity, and only once.
 */
export function postDraft(db: Db, id: string, userId: string, posts: boolean): EntryOut {
  if (!posts) throw conflict(NOT_HERE);
  const d = getDraft(db, id);
  if (!d) throw notFound("Draft not found");
  const opening = d.kind === "opening";
  let lines = d.lines.map((l) => journalLineSchema.parse(l));
  let date = d.date;
  if (opening) {
    const { startDate } = getSettings(db).books;
    if (!startDate) throw badRequest("Set the books start date first (Settings → Books)");
    date = addDays(startDate, -1);
    const diff = lines.reduce((s, l) => s + l.debitFils - l.creditFils, 0);
    if (diff !== 0) {
      lines = [...lines, { accountId: SYSTEM_ACCOUNTS.opening_equity.id, debitFils: diff < 0 ? -diff : 0, creditFils: diff > 0 ? diff : 0, customerId: null, supplierId: null, memo: "Opening balance equity" }];
    }
  }
  const j = journalDraftSchema.parse({ date, narration: d.narration || (opening ? "Opening balances" : ""), lines });
  checkAccounts(db, j.lines);
  if (!opening) checkNotLocked(db, j.date);
  return db.tx(() => {
    const entryId = postEntry(db, {
      date: j.date, narration: j.narration, sourceType: opening ? "opening" : "manual", sourceId: d.id, postKey: opening ? "opening" : `manual:${d.id}`,
      lines: toPostLines(j.lines), userId, allowLocked: opening,
    });
    if (!entryId) throw conflict(opening ? "The opening balances are already posted" : "This draft is already posted");
    db.run("DELETE FROM journal_drafts WHERE id = ?", [d.id]);
    return getEntry(db, entryId)!;
  });
}

const REVERSIBLE = new Set(["manual", "opening", "revaluation"]);

/** Reverses a manual journal (or the opening balances, or a stock revaluation): its mirror, linked to it. */
export function reverseEntry(db: Db, id: string, date: string, userId: string, posts: boolean): EntryOut {
  if (!posts) throw conflict(NOT_HERE);
  const e = getEntry(db, id);
  if (!e) throw notFound("Journal not found");
  if (!REVERSIBLE.has(e.sourceType)) throw badRequest("Automatic entries are corrected through their documents (a credit note, a refund or a stock count)");
  if (e.reversedBy) throw conflict("Already reversed");
  checkNotLocked(db, date);
  const entryId = postEntry(db, {
    date, narration: `Reversal of ${e.number}: ${e.narration}`, sourceType: "reversal", sourceId: e.id, postKey: `reversal:${e.id}`, reversesId: e.id, userId,
    lines: e.lines.map((l) => ({ accountId: l.accountId, debitFils: l.creditFils, creditFils: l.debitFils, customerId: l.customerId, supplierId: l.supplierId, documentId: l.documentId, memo: l.memo })),
  });
  if (!entryId) throw conflict("Already reversed");
  return getEntry(db, entryId)!;
}
