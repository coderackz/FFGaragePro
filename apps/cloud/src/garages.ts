import { join } from "node:path";
import { buildApp, type AppOptions } from "@ffgp/server";

export type GarageApp = Awaited<ReturnType<typeof buildApp>>;

/**
 * Keeps the garages' server apps open, at most `maxOpen` at a time (least recently used closes first).
 * A garage that is handling a request is never closed under it. A garage whose database can't open fails
 * on its own: it isn't cached, and nothing else is affected.
 */
export class GarageHost {
  private readonly open = new Map<string, Promise<GarageApp>>();
  private readonly busy = new Map<string, number>();

  constructor(
    private readonly dataDir: string,
    private readonly maxOpen = 50,
    /** Extra options for a garage's app (clock, guard, sign-in lockouts that outlive the app). */
    private readonly optionsFor: (garageId: string) => Partial<AppOptions> = () => ({}),
  ) {}

  dir(garageId: string): string {
    return join(this.dataDir, "garages", garageId);
  }

  /** The garage's app, opening (and migrating) its database if needed. Marks it most recently used. */
  get(garageId: string): Promise<GarageApp> {
    let app = this.open.get(garageId);
    if (app) this.open.delete(garageId);
    else {
      app = buildApp({ ...this.optionsFor(garageId), dataDir: this.dir(garageId), cloud: true })
        .then(async (a) => (await a.ready(), a))
        .catch((error: unknown) => {
          if (this.open.get(garageId) === app) this.open.delete(garageId);
          throw error;
        });
    }
    this.open.set(garageId, app);
    void this.evict();
    return app;
  }

  /** Counts a request in or out, so eviction never closes a garage mid-request. */
  enter(garageId: string): void {
    this.busy.set(garageId, (this.busy.get(garageId) ?? 0) + 1);
  }
  leave(garageId: string): void {
    const n = (this.busy.get(garageId) ?? 1) - 1;
    if (n <= 0) this.busy.delete(garageId);
    else this.busy.set(garageId, n);
    void this.evict();
  }

  private async evict(): Promise<void> {
    for (const [id, app] of this.open) {
      if (this.open.size <= this.maxOpen) return;
      if (this.busy.has(id)) continue;
      this.open.delete(id);
      await closeQuietly(app);
    }
  }

  async closeAll(): Promise<void> {
    const apps = [...this.open.values()];
    this.open.clear();
    for (const app of apps) await closeQuietly(app);
  }
}

/** Closes an app that may have failed to open; a failed one has nothing to close. */
async function closeQuietly(app: Promise<GarageApp>): Promise<void> {
  try {
    await (await app).close();
  } catch {
    /* it never opened, or is already closed */
  }
}
