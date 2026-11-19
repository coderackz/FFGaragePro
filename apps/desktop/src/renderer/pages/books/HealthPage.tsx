import { CircleCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button, Card, PageHeader, Spinner } from "../../components/ui";
import { money } from "../../books/types";
import { post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import { BackToBooks } from "./ReportPage";

interface Check { key: string; ok: boolean; appFils: number; booksFils: number; differenceFils: number; note: string }
interface Health { checks: Check[]; late: { id: string; number: string; date: string; originalDate: string; narration: string }[]; openWip: { jobId: string; number: string; wipFils: number }[]; posts: boolean }

const TITLES: Record<string, string> = {
  trial_balance: "The books balance", receivables: "Receivables", inventory: "Stock", output_vat: "Output VAT", opening_clearing: "Opening balance clearing",
};
const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);

/** Whether the books agree with the workshop, entries posted after a lock, and parts still in work in progress. */
export function HealthPage() {
  const { canSee } = useAuth();
  const { data, reload } = useApi<Health>("/api/books/health");
  const [busy, setBusy] = useState(false);
  if (!data) return <Spinner />;
  const revalue = async () => {
    setBusy(true);
    try {
      await post("/api/books/revalue-stock", {});
      toast.success("Stock revalued");
      void reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader back={<BackToBooks />} title="Books health" subtitle={data.posts ? "Checked just now" : "This PC shows the books as of its last sync; they're posted in the cloud"} />
      <Card padded={false} className="mb-5">
        <ul className="divide-y divide-zinc-100">
          {data.checks.map((c) => (
            <li key={c.key} className="flex items-start justify-between gap-4 px-4 py-3" data-testid={`check-${c.key}`}>
              <span className="flex items-start gap-2">
                {c.ok ? <CircleCheck className="mt-0.5 size-4 text-emerald-600" /> : <TriangleAlert className="mt-0.5 size-4 text-red-600" />}
                <span>
                  <span className="block font-medium text-zinc-900">{TITLES[c.key] ?? c.key}</span>
                  <span className="block text-xs text-zinc-500">{c.note}</span>
                  {!c.ok && <span className="block text-xs text-red-700">The app says {money(c.appFils)}, the books {money(c.booksFils)}: a difference of {money(c.differenceFils)}.</span>}
                </span>
              </span>
              <span className="flex items-center gap-3">
                {!c.ok && c.key === "inventory" && canSee("books.post") && data.posts && <Button size="sm" busy={busy} onClick={() => void revalue()}>Revalue stock</Button>}
                <span className={c.ok ? "text-sm font-medium text-emerald-700" : "text-sm font-medium text-red-700"}>{c.ok ? "OK" : "Check"}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {data.late.length > 0 && (
        <Card title="Posted after the books were locked" className="mb-5" padded={false}>
          <ul className="divide-y divide-zinc-100 text-sm">
            {data.late.map((e) => (
              <li key={e.id} className="px-4 py-2"><Link to={`/books/journals/${e.id}`} className="font-mono text-[13px] text-brand-700 hover:underline">{e.number}</Link> {e.narration} · dated {day(e.originalDate)}, posted {day(e.date)}</li>
            ))}
          </ul>
        </Card>
      )}
      {data.openWip.length > 0 && (
        <Card title="Parts in work in progress" padded={false}>
          <ul className="divide-y divide-zinc-100 text-sm">
            {data.openWip.map((w) => (
              <li key={w.jobId} className="flex justify-between px-4 py-2"><Link to={`/documents/${w.jobId}`} className="font-mono text-[13px] text-brand-700 hover:underline">{w.number}</Link><span className="tabular">{money(w.wipFils)}</span></li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
