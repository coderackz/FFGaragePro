import { FileText, Package, Plus, Receipt, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { FailedMessagesCard, StatementsDueCard } from "../components/MessageCards";
import { Button, Card, Empty, PageHeader, StatusBadge, Table } from "../components/ui";
import { useAuth } from "../lib/auth";
import { formatAED, formatDate } from "../lib/format";
import type { BackupStatus, DocumentSummary, Part } from "../lib/types";
import { useApi } from "../lib/useApi";

/** PC holding the garage: a red notice when backups have stopped (folder gone, or nothing for over 3 days). */
function BackupWarning() {
  const { canSee } = useAuth();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  useEffect(() => {
    void window.ffgp?.backupStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  if (!status) return null;
  const days = status.last ? Math.floor((Date.now() - Date.parse(status.last)) / 86_400_000) : 0;
  const message = !status.folderOk
    ? "The backup folder can't be found (is the USB drive plugged in?)"
    : status.last && days > 3 ? `Your last backup was ${days} days ago` : null;
  if (!message) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200" data-testid="backup-warning">
      <span><b>Backups:</b> {message}.</span>
      {canSee("settings.manage") ? <Link to="/settings/backups" className="font-medium underline underline-offset-2">Check backups</Link> : <span>Tell the Owner.</span>}
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const estimates = useApi<{ documents: DocumentSummary[] }>("/api/documents?type=estimate");
  const jobs = useApi<{ documents: DocumentSummary[] }>("/api/documents?type=jobcard");
  const invoices = useApi<{ documents: DocumentSummary[] }>("/api/documents?type=invoice");
  const lowStock = useApi<{ parts: Part[] }>("/api/parts?lowStock=1&active=1");
  const lowCount = lowStock.data?.parts.length ?? 0;

  const stats = useMemo(() => {
    const est = estimates.data?.documents ?? [];
    const jc = jobs.data?.documents ?? [];
    const inv = invoices.data?.documents ?? [];
    const unpaid = inv.filter((d) => d.status === "issued" || d.status === "part_paid");
    return {
      pendingEstimates: est.filter((d) => d.status === "draft" || d.status === "sent").length,
      approvedEstimates: est.filter((d) => d.status === "approved").length,
      openJobs: jc.filter((d) => d.status !== "converted"),
      readyToInvoice: jc.filter((d) => d.status === "completed").length,
      unpaidCount: unpaid.length,
      unpaidFils: unpaid.reduce((s, d) => s + d.balanceFils, 0),
      draftInvoices: inv.filter((d) => d.status === "draft").length,
    };
  }, [estimates.data, jobs.data, invoices.data]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user?.name.split(" ")[0]}`}
        subtitle={formatDate(new Date().toISOString())}
        actions={
          <>
            <Button icon={<FileText className="size-4" />} onClick={() => navigate("/documents/new/estimate")}>New estimate</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate("/documents/new/jobcard")}>New job card</Button>
          </>
        }
      />
      <BackupWarning />
      <FailedMessagesCard />
      <StatementsDueCard />
      <div className="mb-5 grid grid-cols-4 gap-4">
        <Stat to="/estimates" label="Estimates awaiting reply" value={stats.pendingEstimates} note={`${stats.approvedEstimates} approved, not started`} />
        <Stat to="/jobcards" label="Jobs in the workshop" value={stats.openJobs.length} note={`${stats.readyToInvoice} ready to invoice`} accent />
        <Stat to="/invoices" label="Unpaid invoices" value={stats.unpaidCount} note={`${stats.draftInvoices} drafts not issued`} />
        <Stat to="/invoices" label="Outstanding" value={formatAED(stats.unpaidFils)} note="Balance across unpaid invoices" />
      </div>
      {lowCount > 0 && (
        <Link to="/parts?lowStock=1" data-testid="low-stock" className="mb-5 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 hover:bg-amber-100">
          <Package className="size-4" />
          <span><b>Low stock: {lowCount}</b> {lowCount === 1 ? "part is" : "parts are"} at or below the reorder level.</span>
          <span className="ml-auto font-medium">View</span>
        </Link>
      )}
      <Card title="Workshop now" padded={false} actions={<Link to="/jobcards" className="text-sm text-brand-700 hover:underline">All job cards</Link>}>
        <Table
          rows={stats.openJobs.slice(0, 12)}
          rowKey={(d) => d.id}
          onRowClick={(d) => navigate(`/documents/${d.id}`)}
          empty={<Empty icon={<Wrench className="size-10" />} title="No open job cards">Convert an approved estimate or start a new job card.</Empty>}
          columns={[
            { header: "Job card", cell: (d) => <span className="font-mono font-medium">{d.number}</span> },
            { header: "Vehicle", cell: (d) => <span className="font-mono text-[13px]">{d.plate ?? "—"}</span> },
            { header: "Customer", cell: (d) => d.customerName },
            { header: "Opened", cell: (d) => formatDate(d.createdAt) },
            { header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
            { header: "Value", cell: (d) => formatAED(d.grossFils), align: "right" },
          ]}
        />
      </Card>
      <div className="mt-5 text-xs text-zinc-400"><Receipt className="mr-1 inline size-3" />All amounts in AED including VAT.</div>
    </>
  );
}

function Stat({ to, label, value, note, accent }: { to: string; label: string; value: string | number; note: string; accent?: boolean }) {
  return (
    <Link to={to} className={`group rounded-lg border p-4 shadow-xs transition-colors ${accent ? "border-ink bg-ink text-white hover:bg-ink-2" : "border-zinc-200 bg-white hover:border-zinc-300"}`}>
      <div className={`text-[13px] ${accent ? "text-zinc-400" : "text-zinc-500"}`}>{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular ${accent ? "text-brand" : ""}`}>{value}</div>
      <div className={`mt-1 text-xs ${accent ? "text-zinc-400" : "text-zinc-500"}`}>{note}</div>
    </Link>
  );
}
