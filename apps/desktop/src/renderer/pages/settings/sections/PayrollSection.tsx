import { Card, Field, Input, Select } from "../../../components/ui";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

const CHOICES = [
  { key: "gratuityDayRate", label: "Gratuity day rate", hint: "A day of basic pay for end-of-service gratuity", options: [["basic_30", "Basic ÷ 30"], ["basic_365", "Basic × 12 ÷ 365"]] },
  { key: "gratuityCap", label: "Gratuity cap", hint: "The most gratuity can come to", options: [["basic", "Two years of basic"], ["gross", "Two years of gross"]] },
  { key: "leaveBasis", label: "Leave not taken paid on", hint: "For a leaver's final settlement", options: [["basic", "Basic"], ["gross", "Gross"]] },
  { key: "salaryDayRate", label: "Salary day rate (part months, unpaid leave)", hint: "A day of pay for joiners, leavers and unpaid leave", options: [["gross_30", "Gross ÷ 30"], ["gross_365", "Gross × 12 ÷ 365"]] },
] as const;

/** Settings → Payroll: the WPS employer details and how pay is worked out (the garage's choice; nothing is assumed). */
export function PayrollSection() {
  const form = useSectionForm("payroll");
  const p = form.value;
  return (
    <SectionShell title="Payroll" subtitle="WPS details and how pay is worked out" dirty={form.dirty} busy={form.busy} onSave={() => void form.save()}>
      <Card title="WPS">
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <Field label="MOHRE establishment ID" hint="13 digits, on the salary file">
            <Input inputMode="numeric" value={p.establishmentId ?? ""} onChange={(e) => form.set({ establishmentId: e.target.value || null })} aria-label="MOHRE establishment ID" />
          </Field>
          <Field label="Employer's bank routing code" hint="9 digits: the bank or exchange that sends the salaries">
            <Input inputMode="numeric" value={p.employerRoutingCode ?? ""} onChange={(e) => form.set({ employerRoutingCode: e.target.value || null })} aria-label="Employer's bank routing code" />
          </Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.bonusInWps} onChange={(e) => form.set({ bonusInWps: e.target.checked })} />
          Put the bonus in WPS as variable pay (otherwise it's paid in cash, on a voucher)
        </label>
      </Card>
      <Card title="How pay is worked out">
        <p className="mb-4 text-sm text-zinc-600">The garage decides these: nothing is assumed. A payroll can't be approved until the first, second and fourth are chosen.</p>
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          {CHOICES.map((c) => (
            <Field key={c.key} label={c.label} hint={c.hint}>
              <Select value={p[c.key] ?? ""} onChange={(e) => form.set({ [c.key]: e.target.value || null })} aria-label={c.label}>
                <option value="">Choose…</option>
                {c.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
          ))}
        </div>
      </Card>
    </SectionShell>
  );
}
