import type { FastifyInstance } from "fastify";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { badRequest } from "../errors";
import { whatsappRoutes } from "../integrations/whatsapp";
import { failuresOf, hookBase, PROVIDERS, retryAll, saveConfig, statusOf, type IntegrationOptions, type Provider } from "../integrations/store";

export const providerOf = (p: string): Provider => {
  if (!(PROVIDERS as readonly string[]).includes(p)) throw badRequest("Unknown integration");
  return p as Provider;
};

/** Settings → Integrations. Only where integrations run (`o`); elsewhere the page is told they're not available. */
export function integrationRoutes(app: FastifyInstance, db: Db, o: IntegrationOptions | undefined): void {
  app.get("/api/integrations", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    if (!o) return { available: false, status: statusOf(db), failures: [] };
    return { available: true, hookBase: hookBase(o), status: statusOf(db), failures: failuresOf(db) };
  });
  if (!o) return;
  whatsappRoutes(app, db, o);
  app.post<{ Params: { provider: string } }>("/api/integrations/:provider/disconnect", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "settings.manage");
    saveConfig(db, user.id, providerOf(req.params.provider), null);
    return { status: statusOf(db) };
  });
  app.post<{ Params: { provider: string } }>("/api/integrations/:provider/retry", async (req) => {
    requireAction(sessionUser(db, req), "settings.manage");
    retryAll(db, providerOf(req.params.provider));
    return { failures: failuresOf(db) };
  });
}
