import type { FastifyInstance } from "fastify";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { fileReturn, getReturn, listPeriods } from "../vat/returns";

/** The VAT return: periods, the VAT201 figures, filing (which locks the books, so Owner only). */
export function vatRoutes(app: FastifyInstance, db: Db, options: { posts: boolean }): void {
  app.get("/api/vat/periods", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    return { periods: listPeriods(db) };
  });
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/vat/return", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    return getReturn(db, req.query.from, req.query.to);
  });
  app.post<{ Body: { from?: string; to?: string; reference?: string | null } }>("/api/vat/returns", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.lock");
    return fileReturn(db, req.body ?? {}, user.id, options.posts);
  });
}
