import { DEFAULT_SETTINGS } from "@ffgp/shared";
import { Printer } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button, Empty, PageHeader, SearchInput, Table } from "../components/ui";
import { useAuth } from "../lib/auth";
import { formatAED, formatDate, PAYMENT_LABELS } from "../lib/format";
import type { Receipt } from "../lib/types";
import { useApi, useDebounced } from "../lib/useApi";
import { printReceipt } from "../print/print";

/** Every payment received (and refund paid), newest first. Payments are taken from the customer's page. */
export function ReceiptsPage() {
  const navigate = useNavigate();
  const { garage, settings } = useAuth();
  const [q, setQ] = useState("");
  const query = useDebounced(q, 200);
  const { data } = useApi<{ receipts: Receipt[] }>(`/api/receipts?q=${encodeURIComponent(query)}`);
  return (
    <>
      <PageHeader title="Receipts" subtitle="Payments received from customers — take a payment from the customer's page" />
      <div className="mb-4 max-w-sm"><SearchInput value={q} onChange={setQ} placeholder="Search number, customer or reference" /></div>
      <Table
        rows={data?.receipts ?? []}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/customers/${r.customerId}`)}
        empty={<Empty title="No receipts yet" />}
        columns={[
          { header: "Number", cell: (r) => <span className="font-mono font-medium">{r.number}</span> },
          { header: "Date", cell: (r) => formatDate(r.receivedAt) },
          { header: "Customer", cell: (r) => r.customerName },
          { header: "Method", cell: (r) => [PAYMENT_LABELS[r.method] ?? r.method, r.reference].filter(Boolean).join(" · ") },
          { header: "Amount", cell: (r) => formatAED(r.amountFils), align: "right" },
          { header: "Credit left", cell: (r) => (r.unallocatedFils ? formatAED(r.unallocatedFils) : ""), align: "right" },
          {
            header: "", cell: (r) => (
              <Button size="sm" variant="ghost" icon={<Printer className="size-3.5" />} aria-label={`Print ${r.number}`}
                onClick={(e) => { e.stopPropagation(); void printReceipt(r, garage!, settings ?? DEFAULT_SETTINGS, "print"); }} />
            ),
          },
        ]}
      />
    </>
  );
}
