import type { FastifyInstance } from "fastify";
import { requireAction, sessionUser } from "../auth";
import { now, type Db } from "../db";
import { notFound } from "../errors";

/** What sync couldn't merge cleanly (renamed duplicates, refused changes to issued invoices), for the Owner. */
export function syncIssueRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/sync-issues", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    const rows = db.all<{ id: string; at: string; kind: string; table_name: string; row_id: string; message: string; detail: string | null }>(
      "SELECT * FROM sync_issues WHERE dismissed_at IS NULL ORDER BY at DESC LIMIT 200",
    );
    return { issues: rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, table: r.table_name, rowId: r.row_id, message: r.message })) };
  });

  app.post<{ Params: { id: string } }>("/api/sync-issues/:id/dismiss", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    if (!db.run("UPDATE sync_issues SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL", [now(), req.params.id])) throw notFound("Issue not found");
    return { ok: true };
  });
}
