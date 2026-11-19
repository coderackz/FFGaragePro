import { Plus, Truck } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { SupplierFormModal } from "../components/inventoryForms";
import { Badge, Button, Card, Empty, PageHeader, Table } from "../components/ui";
import { useAuth } from "../lib/auth";
import type { Supplier } from "../lib/types";
import { useApi } from "../lib/useApi";

export function SuppliersPage() {
  const { can } = useAuth();
  const { data, loading, reload } = useApi<{ suppliers: Supplier[] }>("/api/suppliers");
  const [editing, setEditing] = useState<{ supplier: Supplier | null } | null>(null);
  const canEdit = can("purchases.manage");
  const navigate = useNavigate();

  return (
    <>
      <PageHeader title="Suppliers" subtitle="Where you buy parts"
        actions={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ supplier: null })}>New supplier</Button>} />
      <Card padded={false}>
        <Table
          rows={data?.suppliers ?? []}
          rowKey={(s) => s.id}
          // Those who pay suppliers open the supplier's page (balance, bills, payments); others edit the details.
          onRowClick={can("payables.manage") ? (s) => navigate(`/suppliers/${s.id}`) : canEdit ? (s) => setEditing({ supplier: s }) : undefined}
          empty={!loading && <Empty icon={<Truck className="size-10" />} title="No suppliers yet" />}
          columns={[
            { header: "Name", cell: (s) => <span className="flex items-center gap-2 font-medium">{s.name}{s.isFleetfix && <Badge tone="brand">Fleet Fix</Badge>}</span> },
            { header: "Phone", cell: (s) => s.phone ?? "—" },
            { header: "Email", cell: (s) => s.email ?? "—" },
            { header: "TRN", cell: (s) => <span className="font-mono text-[13px]">{s.trn ?? "—"}</span> },
          ]}
        />
      </Card>
      <SupplierFormModal open={editing !== null} supplier={editing?.supplier} onClose={() => setEditing(null)} onSaved={() => void reload()} />
    </>
  );
}
