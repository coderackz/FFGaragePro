import type { FastifyInstance } from "fastify";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { createAsset, disposeAsset, getAsset, listAssets, updateAsset } from "../assets/register";

/** The fixed asset register: seen with the books, kept by those who post to them. */
export function assetRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: { includeDisposed?: string } }>("/api/assets", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    return { assets: listAssets(db, { includeDisposed: req.query.includeDisposed === "1" }) };
  });
  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    requireAction(sessionUser(db, req), "books.view");
    return { asset: getAsset(db, req.params.id) };
  });
  app.post("/api/assets", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "books.post");
    return { asset: createAsset(db, req.body, user.id) };
  });
  app.patch<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    requireAction(sessionUser(db, req), "books.post");
    return { asset: updateAsset(db, req.params.id, req.body) };
  });
  app.post<{ Params: { id: string } }>("/api/assets/:id/dispose", async (req) => {
    requireAction(sessionUser(db, req), "books.post");
    return { asset: disposeAsset(db, req.params.id, req.body) };
  });
}
