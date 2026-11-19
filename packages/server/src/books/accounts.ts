import { accountSchema, ACCOUNT_TYPES, MONEY_KINDS, type AccountType, type MoneyKind } from "@ffgp/shared";
import { z } from "zod";
import { audit } from "../audit";
import { newId, now, type Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";

interface AccountRow { id: string; code: string; name: string; type: string; system_key: string | null; active: number; money_kind: string | null }

export const accountOut = (a: AccountRow) => ({
  id: a.id, code: a.code, name: a.name, type: a.type as AccountType, systemKey: a.system_key, active: !!a.active,
  moneyKind: a.money_kind as MoneyKind | null,
});
export type AccountOut = ReturnType<typeof accountOut>;

export const listAccounts = (db: Db) => db.all<AccountRow>("SELECT * FROM accounts ORDER BY code").map(accountOut);
export const getAccount = (db: Db, id: string) => {
  const a = db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
  return a ? accountOut(a) : null;
};

export function createAccount(db: Db, input: unknown, userId: string): AccountOut {
  const a = accountSchema.parse(input);
  if (db.get("SELECT 1 FROM accounts WHERE code = ?", [a.code])) throw conflict(`Account ${a.code} already exists`);
  const id = newId();
  const t = now();
  db.run("INSERT INTO accounts (id, code, name, type, system_key, active, money_kind, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?)", [
    id, a.code, a.name, a.type, a.moneyKind, t, t,
  ]);
  audit(db, { action: "settings.change", entity: "account", entityId: id, after: { code: a.code, name: a.name, type: a.type }, userId });
  return getAccount(db, id)!;
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  code: z.string().trim().regex(/^\d{4}$/, "Use a 4-digit code").optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  active: z.boolean().optional(),
  moneyKind: z.enum(MONEY_KINDS).nullable().optional(),
});

/** Renames, recodes, retypes or (de)activates an account. The automatic entries' accounts can only be renamed or recoded. */
export function updateAccount(db: Db, id: string, input: unknown, userId: string): AccountOut {
  const existing = getAccount(db, id);
  if (!existing) throw notFound("Account not found");
  const p = patchSchema.parse(input);
  if (existing.systemKey && p.type !== undefined && p.type !== existing.type) throw badRequest("The app posts to this account automatically: its type can't change");
  if (existing.systemKey && p.active === false) throw badRequest("The app posts to this account automatically: it can't be switched off");
  if (p.code && p.code !== existing.code && db.get("SELECT 1 FROM accounts WHERE code = ?", [p.code])) throw conflict(`Account ${p.code} already exists`);
  const type = p.type ?? existing.type;
  const moneyKind = p.moneyKind !== undefined ? p.moneyKind : existing.moneyKind;
  if (moneyKind && type !== "asset") throw badRequest("Only asset accounts hold money");
  if (existing.systemKey && p.moneyKind !== undefined && p.moneyKind !== existing.moneyKind) throw badRequest("The app uses this account: what it holds can't change");
  db.run("UPDATE accounts SET name = ?, code = ?, type = ?, active = ?, money_kind = ?, updated_at = ? WHERE id = ?", [
    p.name ?? existing.name, p.code ?? existing.code, type, (p.active ?? existing.active) ? 1 : 0, moneyKind, now(), id,
  ]);
  const after = getAccount(db, id)!;
  audit(db, { action: "settings.change", entity: "account", entityId: id, before: existing, after, userId });
  return after;
}
