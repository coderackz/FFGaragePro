import { join } from "node:path";
import { buildApp } from "@ffgp/server";

export type GarageApp = Awaited<ReturnType<typeof buildApp>>;

/**
 * Keeps the garages' server apps open, at most `maxOpen` at a time (least recently used closes first).
 * A garage that is handling a request is never closed under it.
 */
export class GarageHost {
  private readonly open = new Map<string, Promise<GarageApp>>();
  private readonly busy = new Map<string, number>();

  constructor(private readonly dataDir: string, private readonly maxOpen = 50, private readonly now?: () => number) {}

  dir(garageId: string): string {
    return join(this.dataDir, "garages", garageId);
  }

  /** The garage's app, opening (and migrating) its database if needed. Marks it most recently used. */
  get(garageId: string): Promise<GarageApp> {
    let app = this.open.get(garageId);
    if (app) this.open.delete(garageId);
    else app = buildApp({ dataDir: this.dir(garageId), cloud: true, now: this.now }).then(async (a) => (await a.ready(), a));
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
      await (await app).close();
    }
  }

  async closeAll(): Promise<void> {
    const apps = [...this.open.values()];
    this.open.clear();
    for (const app of apps) await (await app).close();
  }
}
