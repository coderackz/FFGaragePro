import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { migrate } from "./migrations";

export type Params = Record<string, SQLInputValue> | SQLInputValue[];

/**
 * Thin synchronous wrapper over node:sqlite. All access goes through one connection in one
 * process, so a transaction (`tx`) can never interleave with another request's statements.
 */
export class Db {
  readonly raw: DatabaseSync;
  /** Where changes are made, for the activity log ("Fleetfix cloud" or the PC's name). */
  device = "this PC";
  private depth = 0;

  /** `migrateTo` stops at that migration (tests that build an older database). */
  constructor(file: string, options: { migrateTo?: number } = {}) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    migrate(this, options.migrateTo);
  }

  static open(dataDir: string): Db {
    mkdirSync(dataDir, { recursive: true });
    return new Db(join(dataDir, "garage.db"));
  }

  all<T>(sql: string, params: Params = {}): T[] {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }

  get<T>(sql: string, params: Params = {}): T | undefined {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  run(sql: string, params: Params = {}): number {
    const stmt = this.raw.prepare(sql);
    const result = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return Number(result.changes);
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      // Nested: a savepoint, so a caller can catch an inner failure and carry on with what's left intact.
      const name = `sp${this.depth}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn();
        this.raw.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export const newId = (): string => randomUUID();
export const now = (): string => new Date().toISOString();
