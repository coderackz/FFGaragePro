import { toast } from "sonner";
import { post } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useApi } from "../lib/useApi";
import { Button, Card } from "./ui";

interface Issue {
  id: string;
  at: string;
  kind: "unique_rename" | "frozen_invoice" | "apply_failed" | "frozen_payroll" | "frozen_asset";
  message: string;
}

const KIND: Record<Issue["kind"], string> = {
  unique_rename: "Added in two places",
  frozen_invoice: "Issued invoice kept",
  frozen_payroll: "Approved payroll kept",
  frozen_asset: "Sold asset kept",
  apply_failed: "Change not applied",
};

/** What sync couldn't merge cleanly: what happened and what was kept. The Owner dismisses each once read. */
export function SyncIssues({ refreshKey = 0, onChange }: { refreshKey?: number; onChange?: () => void }) {
  const { data, reload } = useApi<{ issues: Issue[] }>(`/api/sync-issues?r=${refreshKey}`);
  const issues = data?.issues ?? [];
  if (!issues.length) return null;
  const dismiss = async (id: string) => {
    try {
      await post(`/api/sync-issues/${id}/dismiss`);
      reload();
      onChange?.();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <Card title="Sync issues" className="mt-5 max-w-3xl" padded={false}>
      <ul className="divide-y divide-zinc-100" data-testid="sync-issues">
        {issues.map((i) => (
          <li key={i.id} className="flex items-start justify-between gap-4 px-5 py-3 text-sm">
            <div>
              <div className="font-medium">{KIND[i.kind]}</div>
              <div className="text-zinc-600">{i.message}</div>
              <div className="mt-0.5 text-xs text-zinc-400">{formatDateTime(i.at)}</div>
            </div>
            <Button size="sm" onClick={() => void dismiss(i.id)}>Dismiss</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
