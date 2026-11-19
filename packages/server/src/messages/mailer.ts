import { createTransport } from "nodemailer";
import type { Settings } from "@ffgp/shared";
import type { Db } from "../db";
import { getSecret, getSettings } from "../settings";

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer }[];
}

export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

type MailSettings = Pick<Settings["messages"], "smtpHost" | "smtpPort" | "smtpSecurity" | "smtpUser" | "fromName" | "fromAddress">;

/** Sends through the garage's own mail server. */
export function smtpMailer(s: MailSettings, password: string): Mailer {
  const transport = createTransport({
    host: s.smtpHost ?? undefined,
    port: s.smtpPort,
    secure: s.smtpSecurity === "ssl",
    requireTLS: s.smtpSecurity === "starttls",
    ignoreTLS: s.smtpSecurity === "none",
    auth: { user: s.smtpUser || s.fromAddress || "", pass: password },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
  });
  return {
    async send(m) {
      await transport.sendMail(m);
    },
  };
}

/** The garage's mailer, or null when email isn't set up (no server, from address or password). */
export function mailerFor(db: Db): Mailer | null {
  const m = getSettings(db).messages;
  const password = getSecret(db, "smtp.password");
  if (!m.smtpHost || !m.fromAddress || !password) return null;
  return smtpMailer(m, password);
}
