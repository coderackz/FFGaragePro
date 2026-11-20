import type { Db } from "../db";
import { pushProvider } from "./oauth";
import type { IntegrationOptions } from "./store";
import { quickbooksAdapter } from "./quickbooks";
import { zohoAdapter } from "./zoho";

/** Each accounting provider's push, run in the round (each one does nothing until connected and set up). */
export const accountingPushers = (o: IntegrationOptions) => [zohoAdapter, quickbooksAdapter].map((a) => (db: Db, now: Date) => pushProvider(db, a, o, now));
import { recoverWhatsApp, sendWhatsAppDue, whatsappFor } from "./whatsapp";

export interface IntegrationRunner {
  /** One round: queued WhatsApp messages, then each connected accounting provider's pushes. Rounds never overlap. */
  runOnce(now: Date): Promise<{ pending: boolean }>;
}

/** Where integrations run, one runner per garage app (the cloud's outbox round calls it; the dev server has a timer). */
export function integrationRunner(db: Db, o: IntegrationOptions, pushers: ((db: Db, now: Date) => Promise<void>)[] = []): IntegrationRunner {
  recoverWhatsApp(db);
  let running: Promise<{ pending: boolean }> | null = null;
  const round = async (now: Date) => {
    await sendWhatsAppDue(db, whatsappFor(db, o), now, "cloud");
    for (const push of pushers) await push(db, now);
    const pending = !!db.get(
      `SELECT 1 FROM messages WHERE status = 'queued' AND channel = 'whatsapp' AND wa_json IS NOT NULL
       UNION ALL SELECT 1 FROM integration_failures WHERE next_attempt_at IS NOT NULL OR attempts = 0 LIMIT 1`,
    );
    return { pending };
  };
  return {
    runOnce(now) {
      running ??= round(now).finally(() => (running = null));
      return running;
    },
  };
}
