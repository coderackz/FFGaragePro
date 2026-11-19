import { Card, Field, NumberInput } from "../../../components/ui";
import { Choice } from "../fields";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

export function InventorySection() {
  const form = useSectionForm("inventory");
  return (
    <SectionShell title="Inventory" subtitle="Stock rules for parts on job cards and invoices" dirty={form.dirty} busy={form.busy} onSave={() => void form.save()}>
      <Card title="When a job needs more than is on the shelf">
        <Choice
          name="Stock below zero"
          value={form.value.belowZero}
          onChange={(belowZero) => form.set({ belowZero })}
          options={[
            { value: "warn", label: "Warn only", hint: "Stock can go below zero; count it later" },
            { value: "block", label: "Block", hint: "A job card can't take more than is on the shelf" },
          ]}
        />
      </Card>
      <Card title="New parts">
        <Field label="Default reorder level" hint="New parts start with this level" className="max-w-xs">
          <NumberInput value={form.value.defaultReorderLevel} min={0} onChange={(n) => form.set({ defaultReorderLevel: Math.max(0, n) })} aria-label="Default reorder level" />
        </Field>
      </Card>
    </SectionShell>
  );
}
