import type { DocumentFull } from "../../lib/types";
import { formatKm } from "../../lib/format";
import { Card } from "../ui";

/** The job's vehicle: plate, make and model, VIN and the odometer this visit (with the last one recorded). */
export function VehicleCard({ vehicle, odometer }: { vehicle: NonNullable<DocumentFull["vehicle"]>; odometer: number | null }) {
  return (
    <Card title="Vehicle">
      <dl className="flex flex-col gap-1.5 text-sm" data-testid="vehicle-card">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-zinc-500">Plate No</dt>
          <dd className="font-mono text-lg font-semibold">{vehicle.plate}</dd>
        </div>
        <div className="text-right text-zinc-600">{[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" ")}</div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-zinc-500">VIN No</dt>
          <dd className="font-mono text-xs break-all">{vehicle.vin || <span className="font-sans text-zinc-400">Not recorded</span>}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-zinc-500">Odometer</dt>
          <dd className="tabular">{odometer != null ? formatKm(odometer) : "—"}<span className="text-zinc-400"> · last {formatKm(vehicle.odometer)}</span></dd>
        </div>
      </dl>
    </Card>
  );
}
