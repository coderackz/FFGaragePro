import type { FastifyInstance } from "fastify";
import type { AdminDb } from "./admin-db";
import type { GarageHost } from "./garages";

/** Fleet Fix staff API (`/admin/api/*`). Filled in by Task 4. */
export function adminRoutes(_app: FastifyInstance, _o: { admin: AdminDb; host: GarageHost; now: () => number }): void {}
