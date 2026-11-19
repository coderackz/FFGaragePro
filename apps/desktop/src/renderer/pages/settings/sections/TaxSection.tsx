import { Card, Field, Input, Select } from "../../../components/ui";
import { Choice } from "../fields";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

export function TaxSection() {
  const form = useSectionForm("tax");
  const t = form.value;
  return (
    <SectionShell title="Tax" subtitle="VAT on your documents" dirty={form.dirty} busy={form.busy} onSave={() => void form.save()}>
      <Card title="VAT rate">
        <div className="text-sm text-zinc-700">VAT is <b>5%</b> on every line (UAE standard rate).</div>
      </Card>
      <Card title="Prices I type">
        <Choice
          name="Prices I type"
          value={t.pricesIncludeVat ? "incl" : "excl"}
          onChange={(v) => form.set({ pricesIncludeVat: v === "incl" })}
          options={[
            { value: "excl", label: "Excluding VAT", hint: "AED 100 typed → AED 105 on the invoice" },
            { value: "incl", label: "Including VAT", hint: "AED 105 typed → AED 105 on the invoice, VAT taken out of it" },
          ]}
        />
        <p className="mt-3 text-sm text-zinc-600">Applies to new documents; existing ones keep theirs.</p>
      </Card>
      <Card title="VAT returns">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Return period">
            <Select value={t.returnPeriod} onChange={(e) => form.set({ returnPeriod: e.target.value as "quarterly" | "monthly" })}>
              <option value="quarterly">Quarterly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
          <Field label="First period starts" hint="From your VAT registration certificate">
            <Input type="date" value={t.firstPeriodStart ?? ""} onChange={(e) => form.set({ firstPeriodStart: e.target.value || null })} />
          </Field>
        </div>
      </Card>
    </SectionShell>
  );
}
