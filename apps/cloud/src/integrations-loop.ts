import { dubaiDate } from "@ffgp/shared";
import type { AdminDb } from "./admin-db";
import type { GarageHost } from "./garages";
import { garageLicence } from "./server";

/**
 * Integrations' own round (WhatsApp Business API sends, Zoho Books / QuickBooks pushes), apart from email's, so a
 * slow provider or a big first send never holds up anyone's email. Visits garages marked by a change (a write, a
 * queued message, a PC's push) and, once a Dubai day, every garage; a garage stays marked while it has more to do.
 */
export class CloudIntegrations {
  private readonly marked = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastDay = "";

  constructor(private readonly admin: AdminDb, private readonly host: GarageHost, private readonly o: { now: () => number; everyMs?: number }) {}

  mark(garageId: string): void {
    this.marked.add(garageId);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.o.everyMs ?? 30_000);
    this.timer.unref();
    void this.runOnce();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  runOnce(): Promise<void> {
    this.running ??= this.round().finally(() => (this.running = null));
    return this.running;
  }

  private async round(): Promise<void> {
    const t = new Date(this.o.now());
    const day = dubaiDate(t.toISOString());
    const daily = day !== this.lastDay;
    if (daily) for (const g of this.admin.listGarages()) this.marked.add(g.id);
    for (const id of [...this.marked]) {
      const g = this.admin.garageById(id);
      if (!g || garageLicence(g, this.o.now()).state === "read_only") {
        this.marked.delete(id);
        continue;
      }
      await this.host.whenFree(id);
      this.host.enter(id);
      try {
        const app = await this.host.get(id);
        const r = app.integrations ? await app.integrations.runOnce(t) : { pending: false };
        if (!r.pending) this.marked.delete(id);
      } catch (error) {
        console.error(`Integrations for garage ${id}:`, error);
      } finally {
        this.host.leave(id);
      }
    }
    if (daily) this.lastDay = day;
  }
}
