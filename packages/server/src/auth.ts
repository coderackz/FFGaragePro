import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { can, type Action, type Role } from "@ffgp/shared";
import type { Db } from "./db";
import { forbidden, unauthorized } from "./errors";

const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  role: Role;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(db: Db, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 86_400_000);
  db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
    tokenHash(token),
    userId,
    created.toISOString(),
    expires.toISOString(),
  ]);
  return token;
}

export function endSession(db: Db, token: string): void {
  db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash(token)]);
}

export function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export function sessionUser(db: Db, req: FastifyRequest): SessionUser {
  const token = bearer(req);
  if (!token) throw unauthorized();
  const row = db.get<SessionUser & { active: number }>(
    `SELECT u.id, u.name, u.username, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [tokenHash(token), new Date().toISOString()],
  );
  if (!row || !row.active) throw unauthorized();
  return { id: row.id, name: row.name, username: row.username, role: row.role };
}

export function requireAction(user: SessionUser, action: Action): void {
  if (!can(user.role, action)) throw forbidden();
}

const LOCK_AFTER = 5;
const LOCK_MINUTES = 5;

/** Locks a username for 5 minutes after 5 wrong passwords in a row. In memory: a restart clears it. */
export class LoginThrottle {
  private readonly state = new Map<string, { fails: number; lockedUntil: number }>();

  /** Minutes left on the lock, or 0 when the username may try. */
  lockedMinutes(username: string, now: number): number {
    const s = this.state.get(username.toLowerCase());
    return s && now < s.lockedUntil ? Math.ceil((s.lockedUntil - now) / 60_000) : 0;
  }

  failed(username: string, now: number): void {
    const key = username.toLowerCase();
    const s = this.state.get(key) ?? { fails: 0, lockedUntil: 0 };
    s.fails += 1;
    if (s.fails >= LOCK_AFTER) {
      s.fails = 0;
      s.lockedUntil = now + LOCK_MINUTES * 60_000;
    }
    this.state.set(key, s);
  }

  succeeded(username: string): void {
    this.state.delete(username.toLowerCase());
  }
}
