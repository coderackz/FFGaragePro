import { Card, Field, NumberInput } from "../../../components/ui";
import { OptionalMoney, OptionalNumber } from "../fields";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

export function PricingSection() {
  const form = useSectionForm("pricing");
  const p = form.value;
  const pct = (n: number) => Math.min(100, Math.max(0, n));
  return (
    <SectionShell title="Pricing & discounts" subtitle="Defaults for new lines, and how much each role may discount" dirty={form.dirty} busy={form.busy} onSave={() => void form.save()}>
      <Card title="Defaults">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Labour rate (AED per hour)" hint="New labour lines start at this price">
            <OptionalMoney fils={p.labourRateFils} onChange={(labourRateFils) => form.set({ labourRateFils })} aria-label="Labour rate" placeholder="e.g. 180.00" />
          </Field>
          <Field label="Parts markup (%)" hint="Suggests a selling price from the average cost">
            <OptionalNumber value={p.partsMarkupPct} onChange={(partsMarkupPct) => form.set({ partsMarkupPct })} aria-label="Parts markup" placeholder="e.g. 30" />
          </Field>
        </div>
      </Card>
      <Card title="Largest discount without the Owner">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Admin / Accountant (%)">
            <NumberInput value={p.maxDiscountAccountantPct} min={0} step={1} onChange={(n) => form.set({ maxDiscountAccountantPct: pct(n) })} aria-label="Largest discount for Admin / Accountant" />
          </Field>
          <Field label="Service Advisor (%)">
            <NumberInput value={p.maxDiscountAdvisorPct} min={0} step={1} onChange={(n) => form.set({ maxDiscountAdvisorPct: pct(n) })} aria-label="Largest discount for Service Advisor" />
          </Field>
        </div>
        <p className="mt-3 text-sm text-zinc-600">Above this, the Owner approves with their password. Owners have no limit.</p>
      </Card>
      <Card title="Overall discount on a document">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Confirm discounts above (%)" hint="Above this share of the bill, whoever gives it ticks a confirmation and writes a remark">
            <NumberInput value={p.discountConfirmAbovePct} min={0} step={1} onChange={(n) => form.set({ discountConfirmAbovePct: pct(n) })} aria-label="Confirm discounts above" />
          </Field>
        </div>
      </Card>
    </SectionShell>
  );
}
