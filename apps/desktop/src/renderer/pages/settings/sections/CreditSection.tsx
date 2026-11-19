import { Card, Field, NumberInput } from "../../../components/ui";
import { Choice } from "../fields";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

export function CreditSection() {
  const form = useSectionForm("credit");
  return (
    <SectionShell title="Customers & credit" subtitle="Payment terms, and what happens when a customer goes over their credit limit" dirty={form.dirty} busy={form.busy} onSave={() => void form.save()}>
      <Card title="Payment terms">
        <Field label="Default payment terms (days)" hint="For credit customers without their own terms. Cash customers pay on the day." className="max-w-xs">
          <NumberInput value={form.value.defaultTermsDays} min={0} step={1} onChange={(n) => form.set({ defaultTermsDays: Math.min(365, Math.max(0, Math.round(n))) })} aria-label="Default payment terms" />
        </Field>
      </Card>
      <Card title="Over the credit limit">
        <Choice
          name="Over the credit limit"
          value={form.value.overLimit}
          onChange={(overLimit) => form.set({ overLimit })}
          options={[
            { value: "warn", label: "Warn", hint: "Issue the invoice and show a warning" },
            { value: "block", label: "Block", hint: "Don't issue invoices or open job cards over the limit" },
            { value: "approve", label: "Owner approves", hint: "The Owner types their password to allow it" },
          ]}
        />
        <p className="mt-3 text-sm text-zinc-600">Checked when an invoice is issued and when a job card is opened. Set each customer's limit on their page.</p>
      </Card>
    </SectionShell>
  );
}
