import type { FastifyInstance } from "fastify";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { createAccount, listAccounts, updateAccount } from "../books/accounts";

export interface BooksRouteOptions {
  /** This server posts the books (the cloud, or a PC/main computer that isn't linked). */
  posts: boolean;
}

/** The books: chart of accounts (Part 1 grows this file with journals, opening balances and reports). */
export function bookRoutes(app: FastifyInstance, db: Db, _o: BooksRouteOptions): void {
  app.get("/api/books/accounts", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    return { accounts: listAccounts(db) };
  });

  app.post("/api/books/accounts", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    return { account: db.tx(() => createAccount(db, req.body, user.id)) };
  });

  app.patch<{ Params: { id: string } }>("/api/books/accounts/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    return { account: db.tx(() => updateAccount(db, req.params.id, req.body, user.id)) };
  });
}
