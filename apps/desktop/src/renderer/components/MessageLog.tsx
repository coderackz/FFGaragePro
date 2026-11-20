import type { MessageEvent } from "@ffgp/shared";
import { Mail, MessageCircle } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { post } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { Message } from "../lib/types";
import { useApi } from "../lib/useApi";
import { messagesChanged, onMessagesChanged } from "../messages/triggers";
import { EVENT_LABELS } from "../messages/labels";
import { Button, Table } from "./ui";

export function statusText(m: Message): string {
  if (m.status === "sent") return m.delivery === "read" ? "Sent · read" : m.delivery === "delivered" ? "Sent · delivered" : "Sent";
  if (m.status === "opened") return "Opened in WhatsApp";
  if (m.status === "failed") return `Failed: ${m.error ?? "unknown error"}`;
  if (m.status === "sending") return "Sending…";
  return m.attempts > 0 ? `Trying again (${m.error ?? "no answer"})` : "Sending…";
}

export const eventLabel = (e: string) => (e === "test" ? "Test email" : EVENT_LABELS[e as MessageEvent] ?? e);

export async function retry(id: string): Promise<void> {
  try {
    await post(`/api/messages/${id}/retry`);
    messagesChanged();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

/** Messages about a customer or a document: what went, to whom, and how it went. Refreshes while any are queued. */
export function MessageLog({ customerId, documentId }: { customerId?: string; documentId?: string }) {
  const query = customerId ? `customerId=${customerId}` : `documentId=${documentId}`;
  const { data, reload } = useApi<{ messages: Message[] }>(`/api/messages?${query}`);
  const messages = data?.messages ?? [];
  const pending = messages.some((m) => m.status === "queued" || m.status === "sending");
  useEffect(() => onMessagesChanged(() => void reload()), [reload]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [pending, reload]);

  return (
    <div data-testid="message-log">
      <Table
        rows={messages}
        rowKey={(m) => m.id}
        empty={<div className="px-4 py-3 text-sm text-zinc-600">No messages yet</div>}
        columns={[
          { header: "When", cell: (m) => formatDateTime(m.sentAt ?? m.createdAt) },
          { header: "Message", cell: (m) => eventLabel(m.event) },
          {
            header: "To",
            cell: (m) => (
              <span className="inline-flex items-center gap-1.5">
                {m.channel === "email" ? <Mail className="size-3.5 text-zinc-500" aria-label="Email" /> : <MessageCircle className="size-3.5 text-zinc-500" aria-label="WhatsApp" />}
                {m.recipient}
              </span>
            ),
          },
          { header: "By", cell: (m) => m.createdBy ?? "Automatic" },
          {
            header: "Status",
            cell: (m) => (
              <span className={m.status === "failed" ? "text-red-700" : m.status === "queued" || m.status === "sending" ? "text-amber-700" : "text-zinc-800"}>
                {statusText(m)}
                {m.fileName ? <span className="block text-xs text-zinc-500">{m.fileName}</span> : null}
              </span>
            ),
          },
          { header: "", cell: (m) => (m.status === "failed" ? <Button size="sm" variant="ghost" onClick={() => void retry(m.id)}>Try again</Button> : null) },
        ]}
      />
    </div>
  );
}
