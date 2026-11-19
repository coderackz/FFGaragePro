import { ArrowLeft, Car, FileText, Pencil, Plus, Wrench } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DOC_LABELS } from "@ffgp/shared";
import { AccountCard } from "../components/AccountCard";
import { CustomerFormModal, VehicleFormModal } from "../components/forms";
import { Badge, Button, Card, Empty, PageHeader, Spinner, StatusBadge, Table } from "../components/ui";
import { formatAED, formatDate, formatKm, vehicleLabel } from "../lib/format";
import type { Customer, DocumentSummary, Vehicle } from "../lib/types";
import { useApi } from "../lib/useApi";

export function CustomerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, reload, error } = useApi<{ customer: Customer; vehicles: Vehicle[] }>(`/api/customers/${id}`);
  const docs = useApi<{ documents: DocumentSummary[] }>(`/api/documents?customerId=${id}`);
  const [editing, setEditing] = useState(false);
  const [vehicleModal, setVehicleModal] = useState<{ vehicle: Vehicle | null } | null>(null);

  if (error) return <Empty title="Customer not found">{error}</Empty>;
  if (!data) return <Spinner />;
  const { customer, vehicles } = data;

  return (
    <>
      <PageHeader
        back={<Link to="/customers" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Customers</Link>}
        title={customer.name}
        subtitle={<span className="flex items-center gap-2"><Badge>{customer.kind === "company" ? "Company" : "Individual"}</Badge>{customer.phone}</span>}
        actions={
          <>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
            <Button icon={<FileText className="size-4" />} onClick={() => navigate(`/documents/new/estimate?customerId=${customer.id}`)}>New estimate</Button>
            <Button variant="primary" icon={<Wrench className="size-4" />} onClick={() => navigate(`/documents/new/jobcard?customerId=${customer.id}`)}>New job card</Button>
          </>
        }
      />
      <div className="grid grid-cols-3 gap-5">
        <Card title="Details" className="col-span-1">
          <dl className="grid grid-cols-[90px_1fr] gap-y-2 text-sm">
            <dt className="text-zinc-500">Phone</dt><dd>{customer.phone ?? "—"}</dd>
            <dt className="text-zinc-500">Email</dt><dd className="truncate">{customer.email ?? "—"}</dd>
            {customer.kind === "company" && (<><dt className="text-zinc-500">TRN</dt><dd className="font-mono text-[13px]">{customer.trn ?? "—"}</dd></>)}
            <dt className="text-zinc-500">Address</dt><dd className="whitespace-pre-line">{customer.address ?? "—"}</dd>
            {customer.notes && (<><dt className="text-zinc-500">Notes</dt><dd className="whitespace-pre-line">{customer.notes}</dd></>)}
            <dt className="text-zinc-500">Since</dt><dd>{formatDate(customer.createdAt)}</dd>
          </dl>
        </Card>
        <Card title={`Vehicles (${vehicles.length})`} className="col-span-2" padded={false} actions={<Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setVehicleModal({ vehicle: null })}>Add vehicle</Button>}>
          <Table
            rows={vehicles}
            rowKey={(v) => v.id}
            onRowClick={(v) => setVehicleModal({ vehicle: v })}
            empty={<Empty icon={<Car className="size-9" />} title="No vehicles yet" />}
            columns={[
              { header: "Plate", cell: (v) => <span className="font-mono font-medium">{v.plate}</span> },
              { header: "Vehicle", cell: vehicleLabel },
              { header: "Colour", cell: (v) => v.colour ?? "—" },
              { header: "Odometer", cell: (v) => formatKm(v.odometer), align: "right" },
            ]}
          />
        </Card>
        <AccountCard customer={customer} onChanged={() => { void reload(); void docs.reload(); }} />
        <Card title="History" className="col-span-3" padded={false}>
          <Table
            rows={docs.data?.documents ?? []}
            rowKey={(d) => d.id}
            onRowClick={(d) => navigate(`/documents/${d.id}`)}
            empty={<Empty title="No estimates, job cards or invoices yet" />}
            columns={[
              { header: "Number", cell: (d) => <span className="font-mono font-medium">{d.number}</span> },
              { header: "Type", cell: (d) => DOC_LABELS[d.type] },
              { header: "Date", cell: (d) => formatDate(d.createdAt) },
              { header: "Vehicle", cell: (d) => <span className="font-mono text-[13px]">{d.plate ?? "—"}</span> },
              { header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
              { header: "Total", cell: (d) => formatAED(d.grossFils), align: "right" },
            ]}
          />
        </Card>
      </div>
      <CustomerFormModal open={editing} customer={customer} onClose={() => setEditing(false)} onSaved={() => void reload()} />
      <VehicleFormModal open={vehicleModal !== null} vehicle={vehicleModal?.vehicle} customerId={customer.id} onClose={() => setVehicleModal(null)} onSaved={() => void reload()} />
    </>
  );
}
