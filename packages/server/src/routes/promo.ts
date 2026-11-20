import type { FastifyInstance } from "fastify";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { createCode, listCodes, promoReport, updateCode } from "../promo/codes";

/** Settings → Promo codes, and Reports → Promo codes. */
export function promoRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/promo-codes", async (req) => {
    sessionUser(db, req);
    return { codes: listCodes(db) };
  });
  app.post("/api/promo-codes", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    return { code: createCode(db, req.body) };
  });
  app.patch<{ Params: { id: string } }>("/api/promo-codes/:id", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    return { code: updateCode(db, req.params.id, req.body) };
  });
  app.get("/api/reports/promo-codes", async (req) => {
    requireAction(sessionUser(db, req), "reports.view");
    return { codes: promoReport(db) };
  });
}
