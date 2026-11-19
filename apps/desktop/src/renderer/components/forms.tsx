import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { filsToInput, parseAED } from "@ffgp/shared";
import { patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Customer, Vehicle } from "../lib/types";
import { CustomerPicker } from "./CustomerPicker";
import { Button, Field, Input, Modal, MoneyInput, Select, Textarea } from "./ui";

const emptyCustomer = {
  kind: "individual" as Customer["kind"], name: "", phone: "", email: "", trn: "", address: "", notes: "",
  nameAr: "", addressAr: "", docLanguage: "en" as NonNullable<Customer["docLanguage"]>,
};
const emptyCredit = { creditAllowed: false, creditLimitFils: 0, termsDays: "", discountPct: "", lpoRequired: false, openingBalance: "", openingBalanceDate: "" };
const creditOf = (c: Customer) => ({
  creditAllowed: !!c.creditAllowed, creditLimitFils: c.creditLimitFils ?? 0, termsDays: c.termsDays == null ? "" : String(c.termsDays),
  discountPct: c.discountPct ? String(c.discountPct) : "", lpoRequired: !!c.lpoRequired,
  openingBalance: c.openingBalanceFils ? filsToInput(c.openingBalanceFils) : "", openingBalanceDate: c.openingBalanceDate ?? "",
});

export function CustomerFormModal({ open, customer, initialName, onClose, onSaved }: { open: boolean; customer?: Customer | null; initialName?: string; onClose: () => void; onSaved: (c: Customer) => void }) {
  const { can } = useAuth();
  // Credit terms are the Owner's or an Accountant's to set (the server checks too).
  const canCredit = can("payments.record");
  const [form, setForm] = useState(emptyCustomer);
  const [credit, setCredit] = useState(emptyCredit);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(customer
      ? {
          kind: customer.kind, name: customer.name, phone: customer.phone ?? "", email: customer.email ?? "", trn: customer.trn ?? "", address: customer.address ?? "",
          notes: customer.notes ?? "", nameAr: customer.nameAr ?? "", addressAr: customer.addressAr ?? "", docLanguage: customer.docLanguage ?? "en",
        }
      : { ...emptyCustomer, name: initialName ?? "" });
    setCredit(customer ? creditOf(customer) : emptyCredit);
  }, [open, customer, initialName]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const opening = credit.openingBalance.trim() ? parseAED(credit.openingBalance) : 0;
    if (opening === null) return void toast.error("The opening balance isn't a number");
    const body = canCredit
      ? {
          ...form, creditAllowed: credit.creditAllowed, creditLimitFils: credit.creditLimitFils,
          termsDays: credit.termsDays.trim() ? Number(credit.termsDays) : null, discountPct: credit.discountPct.trim() ? Number(credit.discountPct) : 0,
          lpoRequired: credit.lpoRequired, openingBalanceFils: opening, openingBalanceDate: opening ? credit.openingBalanceDate || null : null,
        }
      : form;
    setBusy(true);
    try {
      const res = customer ? await patch<{ customer: Customer }>(`/api/customers/${customer.id}`, body) : await post<{ customer: Customer }>("/api/customers", body);
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
        <Field label="Document language" hint="What their estimates, invoices and statements print in">
          <Select {...f("docLanguage")}>
            <option value="en">English</option>
            <option value="en_ar">English + Arabic</option>
          </Select>
        </Field>
        <Field label="Arabic name" hint="Printed on English + Arabic documents">
          <Input {...f("nameAr")} dir="rtl" lang="ar" />
        </Field>
        <Field label="Arabic address" className="col-span-2">
          <Textarea {...f("addressAr")} rows={2} className="min-h-0" dir="rtl" lang="ar" />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea {...f("notes")} rows={2} className="min-h-0" />
        </Field>
        {canCredit && (
          <fieldset className="col-span-2 rounded-lg border border-zinc-200 p-3" data-testid="credit-terms">
            <legend className="px-1 text-sm font-semibold text-zinc-900">Credit</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={credit.creditAllowed} onChange={(e) => setCredit({ ...credit, creditAllowed: e.target.checked })} className="size-4 accent-zinc-900" />
              Allow credit (pays later, by its payment terms)
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Credit limit (AED)" hint="0 = no limit">
                <MoneyInput fils={credit.creditLimitFils} onChange={(v) => setCredit({ ...credit, creditLimitFils: v })} aria-label="Credit limit" />
              </Field>
              <Field label="Payment terms (days)" hint="Blank = the garage's default">
                <Input inputMode="numeric" value={credit.termsDays} onChange={(e) => setCredit({ ...credit, termsDays: e.target.value.replace(/\D/g, "").slice(0, 3) })} aria-label="Payment terms" />
              </Field>
              <Field label="Standing discount (%)">
                <Input inputMode="decimal" value={credit.discountPct} onChange={(e) => setCredit({ ...credit, discountPct: e.target.value.replace(/[^\d.]/g, "").slice(0, 5) })} aria-label="Standing discount" />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input type="checkbox" checked={credit.lpoRequired} onChange={(e) => setCredit({ ...credit, lpoRequired: e.target.checked })} className="size-4 accent-zinc-900" />
                Needs an LPO number on invoices
              </label>
              <Field label="Opening balance (AED)" hint="Owed before using the app; negative if in credit">
                <Input inputMode="decimal" value={credit.openingBalance} onChange={(e) => setCredit({ ...credit, openingBalance: e.target.value })} aria-label="Opening balance" />
              </Field>
              <Field label="As of">
                <Input type="date" value={credit.openingBalanceDate} onChange={(e) => setCredit({ ...credit, openingBalanceDate: e.target.value })} aria-label="Opening balance date" />
              </Field>
            </div>
          </fieldset>
        )}
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
