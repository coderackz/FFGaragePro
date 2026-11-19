import { Card, Field, Select } from "../../../components/ui";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

const CHOICES = [0, 5, 10, 15, 30, 60];

export function SecuritySection() {
  const form = useSectionForm("security");
  const minutes = form.value.idleLockMinutes;
  const options = CHOICES.includes(minutes) ? CHOICES : [...CHOICES, minutes].sort((a, b) => a - b);
  return (
    <SectionShell title="Security" subtitle="Keep the garage's data safe when a screen is left alone" dirty={form.dirty} busy={form.busy} onSave={() => void form.save()}>
      <Card title="Lock the screen">
        <Field label="Lock after" hint="Unlock with the same person's password. Unsaved work stays as it was." className="max-w-xs">
          <Select value={String(minutes)} onChange={(e) => form.set({ idleLockMinutes: Number(e.target.value) })} aria-label="Lock after">
            {options.map((m) => <option key={m} value={m}>{m === 0 ? "Never" : `${m} minutes without use`}</option>)}
          </Select>
        </Field>
      </Card>
    </SectionShell>
  );
}
