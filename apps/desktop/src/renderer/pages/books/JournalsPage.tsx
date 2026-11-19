import { Plus, Undo2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Empty, Input, PageHeader, Spinner, Table } from "../../components/ui";
import { amount, money, SOURCE_LABELS, type Draft, type Entry, type EntrySummary } from "../../books/types";
import { post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatDateTime } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import { BackToBooks } from "./ReportPage";

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);

/** Posted journals (newest first) and drafts not posted yet. */
export function JournalsPage() {
  const navigate = useNavigate();
  const { canSee } = useAuth();
  const [q, setQ] = useState("");
  const list = useApi<{ journals: EntrySummary[] }>(`/api/books/journals${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const drafts = useApi<{ drafts: Draft[] }>("/api/books/drafts");
  return (
    <>
      <PageHeader back={<BackToBooks />} title="Journals"
        actions={canSee("books.post") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/books/journals/new")}>New journal</Button>} />
      {!!drafts.data?.drafts.length && (
        <Card title="Drafts" className="mb-5" padded={false}>
          <Table rows={drafts.data.drafts} rowKey={(d) => d.id} onRowClick={(d) => navigate(`/books/drafts/${d.id}`)}
            columns={[
              { header: "Date", cell: (d) => day(d.date) },
              { header: "Narration", cell: (d) => d.narration || "—" },
              { header: "Kind", cell: (d) => (d.kind === "opening" ? "Opening balances" : "Journal") },
              { header: "Saved", cell: (d) => formatDateTime(d.updatedAt) },
            ]} />
        </Card>
      )}
      <div className="mb-3 max-w-sm"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or narration" aria-label="Search journals" /></div>
      <Card padded={false}>
        {!list.data ? <Spinner /> : (
          <Table rows={list.data.journals} rowKey={(j) => j.id} onRowClick={(j) => navigate(`/books/journals/${j.id}`)}
            empty={<Empty title="Nothing posted yet" />}
            columns={[
              { header: "Date", cell: (j) => day(j.date) },
              { header: "Number", cell: (j) => <span className="font-mono text-[13px]">{j.number}</span> },
              { header: "Narration", cell: (j) => j.narration },
              { header: "Kind", cell: (j) => SOURCE_LABELS[j.sourceType] ?? j.sourceType },
              { header: "Amount", cell: (j) => money(j.totalFils), align: "right" },
            ]} />
        )}
      </Card>
    </>
  );
}

/** One journal: its lines, where it came from, and Reverse for journals people posted. */
export function JournalView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canSee } = useAuth();
  const { data, error } = useApi<{ entry: Entry }>(`/api/books/journals/${id}`);
  const [busy, setBusy] = useState(false);
  if (error) return <Empty title="Journal not found">{error}</Empty>;
  if (!data) return <Spinner />;
  const e = data.entry;
  const reversible = ["manual", "opening", "revaluation"].includes(e.sourceType) && !e.reversedBy;
  const reverse = async () => {
    if (!window.confirm(`Reverse ${e.number}? A mirror journal is posted today; ${e.number} stays in the books.`)) return;
    setBusy(true);
    try {
      const { entry } = await post<{ entry: Entry }>(`/api/books/journals/${e.id}/reverse`, {});
      toast.success(`${entry.number} posted`);
      navigate(`/books/journals/${entry.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const debits = e.lines.reduce((s, l) => s + l.debitFils, 0);
  const source = e.sourceId && ["invoice", "credit_note", "cogs"].includes(e.sourceType) ? `/documents/${e.sourceId}` : null;
  return (
    <>
      <PageHeader
        back={<Link to="/books/journals" className="mb-1 inline-block text-sm text-zinc-500 hover:text-zinc-800">← Journals</Link>}
        title={`${e.number} · ${e.narration}`}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          {day(e.date)}{e.originalDate && <Badge tone="red">dated {day(e.originalDate)}, posted after the lock</Badge>}
          <Badge>{SOURCE_LABELS[e.sourceType] ?? e.sourceType}</Badge>
          {source && <Link to={source} className="text-brand-700 hover:underline">{e.sourceNumber ?? "source document"}</Link>}
          {e.reversesId && <Link to={`/books/journals/${e.reversesId}`} className="text-brand-700 hover:underline">reverses a journal</Link>}
          {e.reversedBy && <Link to={`/books/journals/${e.reversedBy}`} className="text-brand-700 hover:underline">reversed</Link>}
        </span>}
        actions={reversible && canSee("books.post") && <Button icon={<Undo2 className="size-4" />} busy={busy} onClick={() => void reverse()}>Reverse</Button>}
      />
      <Card padded={false}>
        <Table rows={e.lines} rowKey={(l) => l.id}
          columns={[
            { header: "Account", cell: (l) => <Link to={`/books/ledger?accountId=${l.accountId}`} className="hover:underline">{l.code} {l.name}</Link> },
            { header: "Memo", cell: (l) => l.memo ?? "" },
            { header: "Debit", cell: (l) => amount(l.debitFils), align: "right" },
            { header: "Credit", cell: (l) => amount(l.creditFils), align: "right" },
          ]} />
        <div className="flex justify-between border-t border-zinc-200 px-4 py-2 text-sm font-medium"><span>Total</span><span className="tabular">{money(debits)}</span></div>
      </Card>
      <p className="mt-3 text-xs text-zinc-500">Posted {formatDateTime(e.createdAt)}{e.createdBy ? ` by ${e.createdBy}` : " automatically"}.</p>
    </>
  );
}
