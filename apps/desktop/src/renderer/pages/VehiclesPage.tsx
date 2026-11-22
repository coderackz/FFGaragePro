import { Car, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { VehicleFormModal } from "../components/forms";
import { ShowMore, usePageLimit } from "../components/ShowMore";
import { Button, Card, Empty, PageHeader, SearchInput, Spinner, Table } from "../components/ui";
import { formatKm, vehicleLabel } from "../lib/format";
import type { Vehicle } from "../lib/types";
import { useApi, useDebounced } from "../lib/useApi";

export function VehiclesPage() {
  const [q, setQ] = useState("");
  const query = useDebounced(q);
  const [limit, showMore] = usePageLimit(query);
  const { data, loading } = useApi<{ vehicles: Vehicle[]; more: boolean }>(`/api/vehicles?q=${encodeURIComponent(query)}&limit=${limit}`);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <PageHeader title="Vehicles" subtitle="Every vehicle you've registered, with its owner" actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New vehicle</Button>} />
      <div className="mb-3 flex items-center gap-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search plate, make, model, VIN or owner" />
        {loading && <Spinner className="size-4 text-zinc-400" />}
      </div>
      <Card padded={false}>
        <Table
          rows={data?.vehicles ?? []}
          rowKey={(v) => v.id}
          onRowClick={(v) => navigate(`/customers/${v.customerId}`)}
          empty={!loading && <Empty icon={<Car className="size-10" />} title={q ? "No matching vehicles" : "No vehicles yet"} />}
          columns={[
            { header: "Plate", cell: (v) => <span className="font-mono font-medium">{v.plate}</span> },
            { header: "Vehicle", cell: vehicleLabel },
            { header: "Owner", cell: (v) => v.customerName },
            { header: "VIN", cell: (v) => <span className="font-mono text-xs text-zinc-500">{v.vin ?? "—"}</span> },
            { header: "Odometer", cell: (v) => formatKm(v.odometer), align: "right" },
          ]}
        />
        <ShowMore more={data?.more} loading={loading} shown={data?.vehicles.length ?? 0} onMore={showMore} />
      </Card>
      <VehicleFormModal open={creating} onClose={() => setCreating(false)} onSaved={(v) => navigate(`/customers/${v.customerId}`)} />
    </>
  );
}
