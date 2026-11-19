import type { FastifyInstance } from "fastify";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { dubaiDate } from "@ffgp/shared";
import { z } from "zod";
import { createAccount, listAccounts, updateAccount } from "../books/accounts";
import { closeYear } from "../books/close";
import { createDraft, deleteDraft, listDrafts, postDraft, reverseEntry, updateDraft } from "../books/journals";
import { openingProposal } from "../books/opening";
import { postPending } from "../books/pending";
import { balanceSheet, health, journals, ledger, profitAndLoss, revalueStock, trialBalance } from "../books/reports";
import { getEntry, NOT_HERE } from "../books/journals";
import { conflict, notFound } from "../errors";

export interface BooksRouteOptions {
  /** This server posts the books (the cloud, or a PC/main computer that isn't linked). */
  posts: boolean;
}

/** The books: chart of accounts (Part 1 grows this file with journals, opening balances and reports). */
const reverseInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const yearEndInput = z.object({ yearEnd: z.string() });

export function bookRoutes(app: FastifyInstance, db: Db, o: BooksRouteOptions): void {
  /** Reports and lists read the books after catching up (where this server posts them). */
  const fresh = () => {
    if (!o.posts) return;
    try {
      postPending(db);
    } catch (error) {
      // The books still show what's posted; Books health lists what couldn't post.
      console.error("Books:", error);
    }
  };

  app.get("/api/books/accounts", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    return { accounts: listAccounts(db) };
  });

  app.post("/api/books/accounts", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    // Accounts are made where the books are posted, so two PCs can't give two accounts the same code.
    if (!o.posts) throw conflict(NOT_HERE);
    return { account: db.tx(() => createAccount(db, req.body, user.id)) };
  });

  app.patch<{ Params: { id: string } }>("/api/books/accounts/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    if (!o.posts) throw conflict(NOT_HERE);
    return { account: db.tx(() => updateAccount(db, req.params.id, req.body, user.id)) };
  });

  app.get("/api/books/drafts", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    return { drafts: listDrafts(db) };
  });

  app.post("/api/books/drafts", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    return { draft: createDraft(db, req.body, user.id) };
  });

  app.patch<{ Params: { id: string } }>("/api/books/drafts/:id", async (req) => {
    requireAction(sessionUser(db, req), "books.post");
    return { draft: updateDraft(db, req.params.id, req.body) };
  });

  app.delete<{ Params: { id: string } }>("/api/books/drafts/:id", async (req) => {
    requireAction(sessionUser(db, req), "books.post");
    deleteDraft(db, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/books/drafts/:id/post", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    fresh();
    return { entry: postDraft(db, req.params.id, user.id, o.posts) };
  });

  app.post<{ Params: { id: string } }>("/api/books/journals/:id/reverse", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    const { date } = reverseInput.parse(req.body ?? {});
    return { entry: reverseEntry(db, req.params.id, date ?? dubaiDate(new Date().toISOString()), user.id, o.posts) };
  });

  app.get("/api/books/opening/proposal", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    fresh();
    return openingProposal(db);
  });

  app.post("/api/books/year-end", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.lock");
    fresh();
    return { entry: closeYear(db, yearEndInput.parse(req.body).yearEnd, user.id, o.posts) };
  });

  type Q = Record<string, string | undefined>;
  app.get<{ Querystring: Q }>("/api/books/trial-balance", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    fresh();
    return trialBalance(db, req.query.asOf);
  });

  app.get<{ Querystring: Q }>("/api/books/profit-loss", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    fresh();
    return profitAndLoss(db, req.query.from, req.query.to);
  });

  app.get<{ Querystring: Q }>("/api/books/balance-sheet", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    fresh();
    return balanceSheet(db, req.query.asOf);
  });

  app.get<{ Querystring: Q }>("/api/books/ledger", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    fresh();
    return ledger(db, req.query);
  });

  app.get<{ Querystring: Q }>("/api/books/journals", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    fresh();
    return { journals: journals(db, req.query) };
  });

  app.get<{ Params: { id: string } }>("/api/books/journals/:id", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    const entry = getEntry(db, req.params.id);
    if (!entry) throw notFound("Journal not found");
    return { entry };
  });

  app.get("/api/books/health", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    fresh();
    return { ...health(db), posts: o.posts };
  });

  app.post("/api/books/revalue-stock", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    fresh();
    return { entry: revalueStock(db, user.id, o.posts) };
  });
}
