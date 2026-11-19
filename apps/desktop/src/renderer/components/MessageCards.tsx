import { dubaiDate, DEFAULT_SETTINGS, type Recipient } from "@ffgp/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { get } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatAED } from "../lib/format";
import type { Customer, Message, Statement } from "../lib/types";
import { useApi } from "../lib/useApi";
import { askToSend, emailStatement, monthlyStatementRange, onMessagesChanged, statementRequest } from "../messages/triggers";
import { eventLabel, retry } from "./MessageLog";
import { Button } from "./ui";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Emails that didn't go after every retry: what, to whom, why, and Try again. Hidden when there are none. */
export function FailedMessagesCard() {
  const { data, reload } = useApi<{ messages: Message[] }>("/api/messages?status=failed");
  useEffect(() => onMessagesChanged(() => void reload()), [reload]);
  const failed = data?.messages ?? [];
  if (!failed.length) return null;
  return (
    <div className="mb-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-red-200" data-testid="failed-messages">
      <div className="mb-2 font-medium">{plural(failed.length, "message")} didn't go</div>
      <ul className="space-y-1.5">
        {failed.slice(0, 5).map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {eventLabel(m.event)} to <b>{m.recipient}</b>: {m.error ?? "unknown error"}
            </span>
            <Button size="sm" onClick={() => void retry(m.id).then(() => reload())}>Try again</Button>
          </li>
        ))}
      </ul>
      {failed.length > 5 && <div className="mt-2 text-xs">And {failed.length - 5} more: open the customer to see them.</div>}
      <div className="mt-2 text-xs text-red-800">
        Often the mailbox settings: check <Link to="/settings/messages" className="underline underline-offset-2">Settings → Messages</Link>.
      </div>
    </div>
  );
}

interface DueCustomer { id: string; name: string; balanceFils: number; recipients: Recipient[] }

/** This month's statements not sent yet: email them all, or send one (WhatsApp, or to check it first). */
export function StatementsDueCard() {
  const { garage, settings } = useAuth();
  const { data, reload } = useApi<{ customers: DueCustomer[] }>("/api/messages/statements-due");
  const [busy, setBusy] = useState(false);
  useEffect(() => onMessagesChanged(() => void reload()), [reload]);
  const due = data?.customers ?? [];
  if (!due.length || !(settings ?? DEFAULT_SETTINGS).messages.statement.on) return null;
  const today = dubaiDate(new Date().toISOString());
  const withEmail = due.filter((c) => c.recipients.some((r) => r.email));

  const sendAll = async () => {
    setBusy(true);
    let sent = 0;
    try {
      for (const c of withEmail) if (await emailStatement(c.id, garage!, settings ?? DEFAULT_SETTINGS, today)) sent++;
      toast.success(`Statements emailed to ${plural(sent, "customer")}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      void reload();
    }
  };
  const sendOne = async (c: DueCustomer) => {
    try {
      const range = monthlyStatementRange(today);
      const s = await get<{ customer: Customer; statement: Statement; from: string; to: string }>(`/api/customers/${c.id}/statement?from=${range.from}&to=${range.to}`);
      askToSend(statementRequest(s.statement, s.customer, garage!, settings ?? DEFAULT_SETTINGS, { from: s.from, to: s.to }, true));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="mb-5 rounded-lg bg-white px-4 py-3 text-sm ring-1 ring-zinc-200" data-testid="statements-due">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-zinc-900">Statements to send ({due.length})</span>
        {withEmail.length > 0 && <Button size="sm" variant="primary" busy={busy} onClick={() => void sendAll()}>Email all {withEmail.length}</Button>}
      </div>
      <ul className="divide-y divide-zinc-100">
        {due.slice(0, 8).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
            <Link to={`/customers/${c.id}`} className="text-zinc-800 hover:underline">{c.name}</Link>
            <span className="flex items-center gap-3">
              <span className="tabular text-zinc-600">{formatAED(c.balanceFils)}</span>
              <Button size="sm" variant="ghost" onClick={() => void sendOne(c)}>Send</Button>
            </span>
          </li>
        ))}
      </ul>
      {due.length > 8 && <div className="mt-1 text-xs text-zinc-500">And {due.length - 8} more.</div>}
    </div>
  );
}
