import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { CustomerFormModal } from "../components/forms";
import { ShowMore, usePageLimit } from "../components/ShowMore";
import { Badge, Button, Card, Empty, PageHeader, SearchInput, Spinner, Table } from "../components/ui";
import type { Customer } from "../lib/types";
import { useApi, useDebounced } from "../lib/useApi";

export function CustomersPage() {
  const [q, setQ] = useState("");
  const query = useDebounced(q);
  const [limit, showMore] = usePageLimit(query);
  const { data, loading } = useApi<{ customers: Customer[]; more: boolean }>(`/api/customers?q=${encodeURIComponent(query)}&limit=${limit}`);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <PageHeader title="Customers" subtitle="People and companies you work for" actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New customer</Button>} />
      <div className="mb-3 flex items-center gap-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search name, phone or plate" />
        {loading && <Spinner className="size-4 text-zinc-400" />}
      </div>
      <Card padded={false}>
        <Table
          rows={data?.customers ?? []}
          rowKey={(c) => c.id}
          onRowClick={(c) => navigate(`/customers/${c.id}`)}
          empty={!loading && <Empty icon={<Users className="size-10" />} title={q ? "No matching customers" : "No customers yet"}>{q ? "Try a phone number or plate." : "Add your first customer to start an estimate or job card."}</Empty>}
          columns={[
            { header: "Name", cell: (c) => <span className="font-medium">{c.name}</span> },
            { header: "Type", cell: (c) => <Badge>{c.kind === "company" ? "Company" : "Individual"}</Badge> },
            { header: "Phone", cell: (c) => c.phone ?? "—" },
            { header: "Vehicles", cell: (c) => <span className="font-mono text-[13px]">{c.plates?.join(", ") || "—"}</span> },
          ]}
        />
        <ShowMore more={data?.more} loading={loading} shown={data?.customers.length ?? 0} onMore={showMore} />
      </Card>
      <CustomerFormModal open={creating} onClose={() => setCreating(false)} onSaved={(c) => navigate(`/customers/${c.id}`)} />
    </>
  );
}
