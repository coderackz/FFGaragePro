import { dubaiDate } from "@ffgp/shared";
import { mailerFor as garageMailer, queueReminders, sendDue, type Db, type Mailer } from "@ffgp/server";
import type { AdminDb } from "./admin-db";
import type { GarageHost } from "./garages";

/**
 * Sends the email of every garage linked to the cloud (the cloud is their one sender; their PCs never send). Visits
 * the garages that have something queued (marked when a browser queues a message or a PC pushes one), and once a
 * Dubai day (and at start) every garage, also queuing its payment reminders.
 */
export class CloudOutbox {
  private readonly marked = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastDay = "";

  constructor(
    private readonly admin: AdminDb,
    private readonly host: GarageHost,
    private readonly o: { now: () => number; mailerFor?: (db: Db) => Mailer | null; everyMs?: number },
  ) {}

  /** This garage has email to send: visit it on the next round. */
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

  /** One round. Rounds never overlap: a call during a round waits for it. */
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
      if (!this.admin.garageById(id)) {
        this.marked.delete(id);
        continue;
      }
      await this.host.whenFree(id);
      this.host.enter(id);
      try {
        const app = await this.host.get(id);
        if (daily) queueReminders(app.db, day);
        await sendDue(app.db, (this.o.mailerFor ?? garageMailer)(app.db), t, "cloud");
        const left = app.db.get("SELECT 1 FROM messages WHERE status = 'queued' AND channel = 'email' LIMIT 1");
        if (!left) this.marked.delete(id);
      } catch (error) {
        console.error(`Messages for garage ${id}:`, error);
      } finally {
        this.host.leave(id);
      }
    }
    if (daily) this.lastDay = day;
  }
}
