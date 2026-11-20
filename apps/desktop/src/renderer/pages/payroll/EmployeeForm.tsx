import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Modal, MoneyInput, Select } from "../../components/ui";
import { patch, post } from "../../lib/api";
import type { Employee } from "./types";

type Draft = Omit<Employee, "id">;
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const blank = (): Draft => ({
  name: "", nameAr: null, job: "", nationality: null, joinDate: today(), leftDate: null, basicFils: 0, housingFils: 0, transportFils: 0, otherAllowanceFils: 0,
  payMethod: "bank", iban: null, cardNumber: null, routingCode: null, personId: null, emiratesId: null, emiratesIdExpiry: null, labourCard: null,
  labourCardExpiry: null, passport: null, passportExpiry: null, visa: null, visaExpiry: null, language: "en", phone: null, email: null,
});
const DOCS = [["emiratesId", "Emirates ID"], ["labourCard", "Labour card"], ["passport", "Passport"], ["visa", "Visa"]] as const;

/** New or edit employee: who they are, their pay, how WPS pays them, and their documents with expiry dates. */
export function EmployeeForm({ open, employee, onClose, onSaved }: { open: boolean; employee: Employee | null; onClose: () => void; onSaved: (e: Employee) => void }) {
  const [d, setD] = useState<Draft>(blank());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setD(employee ? { ...employee } : blank()); }, [open, employee]);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const text = (key: keyof Draft, label: string, extra: Record<string, unknown> = {}) => (
    <Field label={label}><Input value={(d[key] as string | null) ?? ""} onChange={(e) => set({ [key]: e.target.value || null } as Partial<Draft>)} aria-label={label} {...extra} /></Field>
  );
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...d, iban: d.iban?.replace(/\s/g, "") || null };
      const r = employee ? await patch<{ employee: Employee }>(`/api/employees/${employee.id}`, body) : await post<{ employee: Employee }>("/api/employees", body);
      toast.success(employee ? "Employee saved" : "Employee added");
      onSaved(r.employee);
      onClose();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={employee ? `Edit ${employee.name}` : "New employee"} onClose={onClose} width="max-w-3xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save employee</Button></>}>
      <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        {text("name", "Name")}
        {text("nameAr", "Name in Arabic", { dir: "rtl" })}
        {text("job", "Job")}
        {text("nationality", "Nationality")}
        <Field label="Joined"><Input type="date" value={d.joinDate} onChange={(e) => set({ joinDate: e.target.value })} aria-label="Joined" /></Field>
        <Field label="Left"><Input type="date" value={d.leftDate ?? ""} onChange={(e) => set({ leftDate: e.target.value || null })} aria-label="Left" /></Field>
      </div>
      <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Pay (monthly)</h3>
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <Field label="Basic"><MoneyInput fils={d.basicFils} onChange={(v) => set({ basicFils: v })} aria-label="Basic" /></Field>
        <Field label="Housing"><MoneyInput fils={d.housingFils} onChange={(v) => set({ housingFils: v })} aria-label="Housing" /></Field>
        <Field label="Transport"><MoneyInput fils={d.transportFils} onChange={(v) => set({ transportFils: v })} aria-label="Transport" /></Field>
        <Field label="Other allowance"><MoneyInput fils={d.otherAllowanceFils} onChange={(v) => set({ otherAllowanceFils: v })} aria-label="Other allowance" /></Field>
      </div>
      <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">WPS</h3>
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <Field label="Paid by">
          <Select value={d.payMethod} onChange={(e) => set({ payMethod: e.target.value as Draft["payMethod"] })} aria-label="Paid by">
            <option value="bank">Bank account</option><option value="salary_card">Salary card</option>
          </Select>
        </Field>
        {d.payMethod === "bank" ? text("iban", "IBAN") : text("cardNumber", "Salary card number")}
        {text("routingCode", "Bank routing code", { inputMode: "numeric" })}
        {text("personId", "MOHRE person ID", { inputMode: "numeric" })}
      </div>
      <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Documents</h3>
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        {DOCS.map(([key, label]) => (
          <div key={key} className="contents">
            {text(key, `${label} number`)}
            <Field label={`${label} expires`}>
              <Input type="date" value={(d[`${key}Expiry`] as string | null) ?? ""} onChange={(e) => set({ [`${key}Expiry`]: e.target.value || null } as Partial<Draft>)} aria-label={`${label} expires`} />
            </Field>
          </div>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-3 gap-3 max-md:grid-cols-1">
        <Field label="Payslip language">
          <Select value={d.language} onChange={(e) => set({ language: e.target.value as Draft["language"] })} aria-label="Payslip language">
            <option value="en">English</option><option value="en_ar">English + Arabic</option>
          </Select>
        </Field>
        {text("phone", "Phone")}
        {text("email", "Email")}
      </div>
    </Modal>
  );
}
