import { now, type Db } from "../db";
import { getSettings } from "../settings";
import { postEntry, type PostInput } from "./post";
import {
  postCogs, postCustomerOpenings, postGoodsReceipts, postReceipts, postSalesDocuments, postStock, postExpenses, postMoneyMovements, postPayrollOpenings, postPayrollPayments, postPayrollRuns, postSettlements, postStaffAdvances, postStockCorrection, postSupplierBills, postSupplierOpenings, postSupplierPayments, type PostCtx,
} from "./rules";

/** Changes on this database connection when it last had nothing left to post: nothing changed since, nothing to do. */
const settled = new WeakMap<Db, number>();
const changes = (db: Db) => db.get<{ n: number }>("SELECT total_changes() AS n")!.n;

export const BATCH = 500;

/**
 * Posts events that have no journal entry yet, up to `limit` per run, in one transaction (the next run carries on).
 * Idempotent: it runs after every change at the place that posts the books (the cloud, or a PC/main computer that
 * isn't linked) and before reports. An event that can't post is recorded in `book_failures` (Books health lists it)
 * and the others carry on. Nothing before the books have a start date; nothing when nothing has changed.
 * Purchases and stock go before job costs, so a job's parts are in work in progress first.
 */
export function postPending(db: Db, o: { limit?: number } = {}): number {
  if (settled.get(db) === changes(db)) return 0;
  const books = getSettings(db).books;
  if (!books.startDate) {
    settled.set(db, changes(db));
    return 0;
  }
  const limit = o.limit ?? BATCH;
  let posted = 0;
  const ctx: PostCtx = {
    db, start: books.startDate, methodAccounts: books.methodAccounts,
    full: () => posted >= limit,
    post: (e: PostInput) => {
      const key = e.postKey ?? null;
      try {
        const id = postEntry(db, { ...e, lockDate: books.lockDate });
        if (key) db.run("DELETE FROM book_failures WHERE post_key = ?", [key]);
        if (id) posted++;
        return !!id;
      } catch (error) {
        if (key) {
          db.run("INSERT INTO book_failures (post_key, error, at) VALUES (?, ?, ?) ON CONFLICT(post_key) DO UPDATE SET error = excluded.error, at = excluded.at", [
            key, String((error as Error)?.message ?? error).slice(0, 300), now(),
          ]);
        }
        return false;
      }
    },
  };
  db.tx(() => {
    postSalesDocuments(ctx);
    postReceipts(ctx);
    postGoodsReceipts(ctx);
    postStock(ctx);
    postCogs(ctx);
    postCustomerOpenings(ctx);
    postSupplierOpenings(ctx);
    postSupplierBills(ctx);
    postSupplierPayments(ctx);
    postExpenses(ctx);
    postMoneyMovements(ctx);
    postStaffAdvances(ctx);
    postPayrollOpenings(ctx);
    postPayrollRuns(ctx);
    postPayrollPayments(ctx);
    postSettlements(ctx);
    postStockCorrection(ctx);
  });
  if (posted < limit) settled.set(db, changes(db));
  return posted;
}

/** Posts everything pending, a batch at a time, letting other work run between batches. */
export async function postAllPending(db: Db): Promise<number> {
  let total = 0;
  for (;;) {
    const n = postPending(db);
    total += n;
    if (n < BATCH) return total;
    await new Promise((r) => setImmediate(r));
  }
}
