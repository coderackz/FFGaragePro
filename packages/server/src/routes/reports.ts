import type { FastifyInstance } from "fastify";
import { dubaiDate } from "@ffgp/shared";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { agingReport } from "../ledger";

export function reportRoutes(app: FastifyInstance, db: Db): void {
  /** Owner and Accountant: who owes what, by how late. */
  app.get<{ Querystring: { asOf?: string } }>("/api/reports/aging", async (req) => {
    requireAction(sessionUser(db, req), "reports.view");
    const asOf = req.query.asOf && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : dubaiDate(new Date().toISOString());
    return { asOf, ...agingReport(db, asOf) };
  });
}
