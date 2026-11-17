import clsx from "clsx";
import { FileText, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { DOC_LABELS, DOC_STATUSES, STATUS_LABELS, type DocType } from "@ffgp/shared";
import { Button, Card, Empty, PageHeader, SearchInput, Spinner, StatusBadge, Table } from "../components/ui";
import { formatAED, formatDate } from "../lib/format";
import type { DocumentSummary } from "../lib/types";
import { useApi, useDebounced } from "../lib/useApi";

const SUBTITLES: Record<DocType, string> = {
  estimate: "Quotes for the customer to approve",
  jobcard: "Work in the workshop",
  invoice: "Tax invoices and payments",
};

export function DocumentsPage({ type }: { type: DocType }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const query = useDebounced(q);
  const { data, loading } = useApi<{ documents: DocumentSummary[] }>(`/api/documents?type=${type}&q=${encodeURIComponent(query)}${status ? `&status=${status}` : ""}`);
  const navigate = useNavigate();
  const label = DOC_LABELS[type];

  return (
    <div key={type}>
      <PageHeader
        title={`${label}s`}
        subtitle={SUBTITLES[type]}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate(`/documents/new/${type}`)}>New {label.toLowerCase()}</Button>}
      />
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <SearchInput value={q} onChange={setQ} placeholder="Search number, customer, phone or plate" />
          {loading && <Spinner className="size-4 text-zinc-400" />}
        </div>
        <div className="flex rounded-md border border-zinc-300 bg-white p-0.5 shadow-xs">
          {["", ...DOC_STATUSES[type]].map((s) => (
            <button
              key={s || "all"}
              type="button"
              onClick={() => setStatus(s)}
              className={clsx("rounded px-2.5 py-1 text-[13px]", status === s ? "bg-ink font-medium text-white" : "text-zinc-600 hover:bg-zinc-100")}
            >
              {s ? STATUS_LABELS[s] : "All"}
            </button>
          ))}
        </div>
      </div>
      <Card padded={false}>
        <Table
          rows={data?.documents ?? []}
          rowKey={(d) => d.id}
          onRowClick={(d) => navigate(`/documents/${d.id}`)}
          empty={!loading && <Empty icon={<FileText className="size-10" />} title={`No ${label.toLowerCase()}s${status || q ? " match" : " yet"}`} />}
          columns={[
            { header: "Number", cell: (d) => <span className="font-mono font-medium">{d.number}</span> },
            { header: "Date", cell: (d) => formatDate(d.issuedAt ?? d.createdAt) },
            { header: "Customer", cell: (d) => d.customerName },
            { header: "Vehicle", cell: (d) => <span className="font-mono text-[13px]">{d.plate ?? "—"}</span> },
            { header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
            { header: "Total", cell: (d) => formatAED(d.grossFils), align: "right" },
            ...(type === "invoice" ? [{ header: "Balance", cell: (d: DocumentSummary) => <span className={d.balanceFils > 0 && d.status !== "draft" ? "font-medium text-red-700" : "text-zinc-400"}>{formatAED(d.balanceFils)}</span>, align: "right" as const }] : []),
          ]}
        />
      </Card>
    </div>
  );
}
