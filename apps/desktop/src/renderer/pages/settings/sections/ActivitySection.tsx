import { useState } from "react";
import { Card, Empty, Field, Input, Select, Spinner } from "../../../components/ui";
import { formatDateTime } from "../../../lib/format";
import { useApi } from "../../../lib/useApi";
import { describeAudit, type AuditEntry } from "../describe";
import { SectionShell } from "../SectionShell";

const KINDS = [
  { value: "", label: "Everything" },
  { value: "settings.change", label: "Settings" },
  { value: "discount.approve", label: "Discounts" },
  { value: "user.create", label: "New users" },
  { value: "user.update", label: "User changes" },
  { value: "backup.restore", label: "Restores" },
];

/** Who changed what, newest first. */
export function ActivitySection() {
  const [filter, setFilter] = useState({ userId: "", action: "", from: "", to: "" });
  const users = useApi<{ users: { id: string; name: string }[] }>("/api/users");
  const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const log = useApi<{ entries: AuditEntry[] }>(`/api/audit${query ? `?${query}` : ""}`);
  const set = (k: keyof typeof filter) => (e: { target: { value: string } }) => setFilter({ ...filter, [k]: e.target.value });
  return (
    <SectionShell title="Activity log" subtitle="Settings changes, approved discounts, user changes and restores">
      <Card>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Person">
            <Select value={filter.userId} onChange={set("userId")}>
              <option value="">Everyone</option>
              {users.data?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="Kind">
            <Select value={filter.action} onChange={set("action")}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>
          </Field>
          <Field label="From"><Input type="date" value={filter.from} onChange={set("from")} /></Field>
          <Field label="To"><Input type="date" value={filter.to} onChange={set("to")} /></Field>
        </div>
      </Card>
      <Card padded={false}>
        {!log.data ? (
          <div className="p-6"><Spinner /></div>
        ) : !log.data.entries.length ? (
          <Empty title="Nothing here yet">Changes will show up as people make them.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-100" data-testid="activity-log">
            {log.data.entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3">
                <div className="min-w-0 text-sm text-zinc-900">{describeAudit(e)}</div>
                <div className="shrink-0 text-xs text-zinc-600">{e.user ?? "Someone"} · {e.device ?? ""} · {formatDateTime(e.createdAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </SectionShell>
  );
}
