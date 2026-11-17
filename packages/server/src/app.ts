import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { Db } from "./db";
import { HttpError } from "./errors";
import { customerRoutes } from "./routes/customers";
import { documentRoutes } from "./routes/documents";
import { setupRoutes } from "./routes/setup";
import { userRoutes } from "./routes/users";

export interface AppOptions {
  dataDir: string;
  logger?: boolean;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance & { db: Db }> {
  const db = Db.open(options.dataDir);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  // The screens load from file:// (Electron) or a dev server, so the API must allow cross-origin calls.
  // Every route except setup/login needs a bearer token, so this does not expose data.
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reply.status(400).send({ error: issues[0]?.message ?? "Invalid input", issues });
    }
    if (error instanceof HttpError) return reply.status(error.status).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (error as Error).message });
    app.log.error(error);
    return reply.status(500).send({ error: "Something went wrong. Please try again." });
  });

  app.get("/api/health", async () => ({ ok: true }));
  setupRoutes(app, db);
  userRoutes(app, db);
  customerRoutes(app, db);
  documentRoutes(app, db);

  app.addHook("onClose", async () => db.close());
  return Object.assign(app, { db }) as unknown as FastifyInstance & { db: Db };
}
