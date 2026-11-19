import type { Db } from "../db";
import { getSettings } from "../settings";
import { postCogs, postCustomerOpenings, postGoodsReceipts, postReceipts, postSalesDocuments, postStock } from "./rules";

/**
 * Posts every event that has no journal entry yet: idempotent, so it runs after every change at the place that posts
 * the books (the cloud, or a PC/main computer that isn't linked) and again before reports. Nothing before the books
 * have a start date. Purchases and stock go before job costs, so a job's parts are in work in progress first.
 */
export function postPending(db: Db): number {
  const books = getSettings(db).books;
  if (!books.startDate) return 0;
  const ctx = { db, start: books.startDate, methodAccounts: books.methodAccounts };
  return postSalesDocuments(ctx) + postReceipts(ctx) + postGoodsReceipts(ctx) + postStock(ctx) + postCogs(ctx) + postCustomerOpenings(ctx);
}
