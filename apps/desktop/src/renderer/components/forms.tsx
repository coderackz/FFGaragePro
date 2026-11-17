import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { patch, post } from "../lib/api";
import type { Customer, Vehicle } from "../lib/types";
import { CustomerPicker } from "./CustomerPicker";
import { Button, Field, Input, Modal, Select, Textarea } from "./ui";

const emptyCustomer = { kind: "individual" as Customer["kind"], name: "", phone: "", email: "", trn: "", address: "", notes: "" };

export function CustomerFormModal({ open, customer, initialName, onClose, onSaved }: { open: boolean; customer?: Customer | null; initialName?: string; onClose: () => void; onSaved: (c: Customer) => void }) {
  const [form, setForm] = useState(emptyCustomer);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setForm(customer ? { kind: customer.kind, name: customer.name, phone: customer.phone ?? "", email: customer.email ?? "", trn: customer.trn ?? "", address: customer.address ?? "", notes: customer.notes ?? "" } : { ...emptyCustomer, name: initialName ?? "" });
  }, [open, customer, initialName]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = customer ? await patch<{ customer: Customer }>(`/api/customers/${customer.id}`, form) : await post<{ customer: Customer }>("/api/customers", form);
      toast.success(customer ? "Customer updated" : "Customer added");
      onSaved(res.customer);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={customer ? "Edit customer" : "New customer"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="customer-form" busy={busy}>Save customer</Button>
        </>
      }
    >
      <form id="customer-form" onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="Type">
          <Select {...f("kind")}>
            <option value="individual">Individual</option>
            <option value="company">Company</option>
          </Select>
        </Field>
        <Field label={form.kind === "company" ? "Company name" : "Full name"}>
          <Input {...f("name")} required autoFocus />
        </Field>
        <Field label="Mobile / phone">
          <Input {...f("phone")} placeholder="05X XXX XXXX" />
        </Field>
        <Field label="Email">
          <Input {...f("email")} type="email" />
        </Field>
        {form.kind === "company" && (
          <Field label="Customer TRN" hint="Shown on tax invoices." className="col-span-2">
            <Input {...f("trn")} inputMode="numeric" />
          </Field>
        )}
        <Field label="Address" className="col-span-2">
          <Textarea {...f("address")} rows={2} className="min-h-0" />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea {...f("notes")} rows={2} className="min-h-0" />
        </Field>
      </form>
    </Modal>
  );
}

const emptyVehicle = { plate: "", make: "", model: "", year: "", vin: "", colour: "", odometer: "" };

export function VehicleFormModal({ open, vehicle, customerId, onClose, onSaved }: { open: boolean; vehicle?: Vehicle | null; customerId?: string; onClose: () => void; onSaved: (v: Vehicle) => void }) {
  const [form, setForm] = useState(emptyVehicle);
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(vehicle ? { plate: vehicle.plate, make: vehicle.make ?? "", model: vehicle.model ?? "", year: vehicle.year?.toString() ?? "", vin: vehicle.vin ?? "", colour: vehicle.colour ?? "", odometer: vehicle.odometer?.toString() ?? "" } : emptyVehicle);
    setOwner(null);
  }, [open, vehicle]);

  const ownerId = vehicle?.customerId ?? customerId ?? owner?.id;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ownerId) return toast.error("Choose the customer this vehicle belongs to");
    const toInt = (s: string) => (s.trim() === "" ? null : Number.parseInt(s.replace(/[,\s]/g, ""), 10));
    const body = { customerId: ownerId, plate: form.plate, make: form.make, model: form.model, year: toInt(form.year), vin: form.vin, colour: form.colour, odometer: toInt(form.odometer) };
    setBusy(true);
    try {
      const res = vehicle ? await patch<{ vehicle: Vehicle }>(`/api/vehicles/${vehicle.id}`, body) : await post<{ vehicle: Vehicle }>("/api/vehicles", body);
      toast.success(vehicle ? "Vehicle updated" : "Vehicle added");
      onSaved(res.vehicle);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={vehicle ? `Edit ${vehicle.plate}` : "New vehicle"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="vehicle-form" busy={busy}>Save vehicle</Button>
        </>
      }
    >
      <form id="vehicle-form" onSubmit={submit} className="grid grid-cols-2 gap-4">
        {!vehicle && !customerId && (
          <Field label="Customer" className="col-span-2">
            <CustomerPicker value={owner} onChange={setOwner} />
          </Field>
        )}
        <Field label="Plate number" hint="e.g. DXB A 12345">
          <Input {...f("plate")} required autoFocus className="uppercase" />
        </Field>
        <Field label="Odometer (km)">
          <Input {...f("odometer")} inputMode="numeric" />
        </Field>
        <Field label="Make">
          <Input {...f("make")} placeholder="Toyota" />
        </Field>
        <Field label="Model">
          <Input {...f("model")} placeholder="Land Cruiser" />
        </Field>
        <Field label="Year">
          <Input {...f("year")} inputMode="numeric" />
        </Field>
        <Field label="Colour">
          <Input {...f("colour")} />
        </Field>
        <Field label="VIN / chassis number" className="col-span-2">
          <Input {...f("vin")} className="uppercase" />
        </Field>
      </form>
    </Modal>
  );
}
