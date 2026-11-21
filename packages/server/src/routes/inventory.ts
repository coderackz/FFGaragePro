import type { FastifyInstance } from "fastify";
import { can } from "@ffgp/shared";
import { z } from "zod";
import { requireAction, sessionUser } from "../auth";
import { now, type Db } from "../db";
import { badRequest } from "../errors";
import { abcReport, agingReport, deadStockReport, levels, moversReport, suggestedOrders, valuationReport } from "../inventory/planning";

const levelsSchema = z.object({
  items: z.array(z.object({ partId: z.string().uuid(), reorderLevel: z.number().min(0).max(1_000_000), maxLevel: z.number().min(0).max(1_000_000) })).min(1).max(2000),
});
const num = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
};

/** Inventory v2, Part 3: min/max levels, suggested orders (made into POs in purchases), stock reports. */
export function inventoryRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/inventory/levels", async (req) => {
    requireAction(sessionUser(db, req), "inventory.edit");
    return { parts: levels(db) };
  });
  /** The owner accepts (or overrides) suggested levels, any number of parts at once. */
  app.post("/api/inventory/levels", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const { items } = levelsSchema.parse(req.body);
    db.tx(() => {
      for (const i of items) {
        if (i.maxLevel > 0 && i.maxLevel < i.reorderLevel) throw badRequest("Order up to can't be below the reorder level");
        db.run("UPDATE parts SET reorder_level = ?, max_level = ?, updated_at = ? WHERE id = ? AND stocked = 1", [i.reorderLevel, i.maxLevel, now(), i.partId]);
      }
    });
    return { parts: levels(db) };
  });
  app.get("/api/inventory/suggested-orders", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
    return { suppliers: suggestedOrders(db, can(user.role, "costs.view")) };
  });

  // Stock reports: values, so only for those who may see costs.
  const costs = (req: Parameters<typeof sessionUser>[1]) => requireAction(sessionUser(db, req), "costs.view");
  app.get<{ Querystring: { months?: string } }>("/api/reports/inventory/abc", async (req) => {
    costs(req);
    return abcReport(db, num(req.query.months, 12, 1, 60));
  });
  app.get<{ Querystring: { days?: string } }>("/api/reports/inventory/movers", async (req) => {
    costs(req);
    return moversReport(db, num(req.query.days, 90, 7, 730));
  });
  app.get<{ Querystring: { months?: string } }>("/api/reports/inventory/dead", async (req) => {
    costs(req);
    return deadStockReport(db, num(req.query.months, 6, 1, 60));
  });
  app.get("/api/reports/inventory/valuation", async (req) => {
    costs(req);
    return valuationReport(db);
  });
  app.get("/api/reports/inventory/aging", async (req) => {
    costs(req);
    return agingReport(db);
  });
}
