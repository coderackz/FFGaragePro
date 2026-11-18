import type { Db } from "@ffgp/server";
import { maxSeq, SyncClient, type CloudLink, type SyncResult, type SyncStatus } from "@ffgp/sync";

const EVERY_MS = 30_000;
const TICK_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export type CloudStatus = ({ linked: false } | SyncStatus) & { syncing: boolean };

/**
 * The PC's sync loop: syncs every 30 s while linked, and within 5 s of a change made here. While the cloud
 * can't be reached it waits longer each time (up to 5 minutes); the PC keeps working on its own meanwhile.
 */
export class CloudSync {
  readonly client: SyncClient;
  private timer: NodeJS.Timeout | null = null;
  private nextAt = 0;
  private failures = 0;
  private seenSeq = 0;
  private syncing = false;

  constructor(
    private readonly getDb: () => Db | null,
    readonly link: CloudLink,
    private readonly onStatus: (s: CloudStatus) => void,
  ) {
    this.client = new SyncClient(() => {
      const db = this.getDb();
      if (!db) throw new Error("The garage isn't open");
      return db;
    }, link);
  }

  start(): void {
    this.stop();
    this.nextAt = 0;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): CloudStatus {
    try {
      return { ...this.client.status(), syncing: this.syncing };
    } catch {
      return { linked: false, syncing: false };
    }
  }

  async syncNow(): Promise<SyncResult> {
    this.syncing = true;
    this.onStatus(this.status());
    try {
      const result = await this.client.syncOnce();
      const now = Date.now();
      if (result.ok || result.reason !== "offline") this.failures = 0;
      else this.failures++;
      const wait = this.failures ? Math.min(MAX_BACKOFF_MS, EVERY_MS * 2 ** (this.failures - 1)) : EVERY_MS;
      this.nextAt = now + wait;
      const db = this.getDb();
      if (db) this.seenSeq = maxSeq(db);
      return result;
    } finally {
      this.syncing = false;
      this.onStatus(this.status());
    }
  }

  private async tick(): Promise<void> {
    if (this.syncing) return;
    const db = this.getDb();
    if (!db) return;
    const changed = maxSeq(db) > this.seenSeq;
    // A change made here goes up within one tick, unless the cloud is unreachable and we're backing off.
    if (Date.now() >= this.nextAt || (changed && this.failures === 0)) await this.syncNow();
  }
}
