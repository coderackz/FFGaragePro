import { formatDocNumber, formatPoNumber, NUMBER_KINDS, type NumberKind, type Settings } from "@ffgp/shared";
import { useEffect } from "react";
import { Card, Field, Input, NumberInput } from "../../../components/ui";
import { useApi } from "../../../lib/useApi";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

const KIND: Record<NumberKind, { label: string; key: "estimate" | "jobcard" | "invoice" | "purchaseOrder" }> = {
  estimate: { label: "Estimates", key: "estimate" },
  jobcard: { label: "Job cards", key: "jobcard" },
  invoice: { label: "Invoices", key: "invoice" },
  purchase_order: { label: "Purchase orders", key: "purchaseOrder" },
};
const digits = (number: string) => Number(/(\d+)$/.exec(number)?.[1] ?? 1);

/** Prefixes and the next number of each series. Numbers only ever move forward. */
export function NumberingSection() {
  const form = useSectionForm("numbering");
  const overview = useApi<{ nextNumbers: Record<NumberKind, string> }>("/api/settings/overview");
  // Show the real next number (not the stored start), so the field never suggests going back.
  useEffect(() => {
    const next = overview.data?.nextNumbers;
    if (!next) return;
    form.setValue((v) => {
      const out = { ...v } as Settings["numbering"];
      for (const k of NUMBER_KINDS) {
        const key = `${KIND[k].key}Start` as const;
        // Only fields the person hasn't changed yet (the numbers can arrive after they start typing).
        if (v[key] === form.saved[key]) out[key] = Math.max(form.saved[key], digits(next[k]));
      }
      return out;
    });
  }, [overview.data, form.saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = overview.data ? NUMBER_KINDS.some((k) => {
    const p = `${KIND[k].key}Prefix` as const;
    const s = `${KIND[k].key}Start` as const;
    return form.value[p] !== form.saved[p] || form.value[s] !== Math.max(form.saved[s], digits(overview.data!.nextNumbers[k]));
  }) : false;

  return (
    <SectionShell title="Numbering" subtitle="How estimates, job cards, invoices and purchase orders are numbered" dirty={dirty} busy={form.busy} onSave={() => void form.save()}>
      <Card>
        <div className="space-y-5">
          {NUMBER_KINDS.map((k) => {
            const p = `${KIND[k].key}Prefix` as const;
            const s = `${KIND[k].key}Start` as const;
            const example = k === "purchase_order" ? formatPoNumber(form.value[s], "", form.value[p]) : formatDocNumber(k, form.value[s], "", form.value[p]);
            return (
              <div key={k} className="grid items-end gap-4 sm:grid-cols-[1fr_140px_160px]">
                <div>
                  <div className="font-medium text-zinc-900">{KIND[k].label}</div>
                  <div className="text-sm text-zinc-600">Next will be <span className="font-mono font-semibold text-zinc-900" data-testid={`next-${k}`}>{example}</span></div>
                </div>
                <Field label="Prefix">
                  <Input value={form.value[p]} onChange={(e) => form.set({ [p]: e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) } as Partial<Settings["numbering"]>)} aria-label={`${KIND[k].label} prefix`} />
                </Field>
                <Field label="Next number">
                  <NumberInput value={form.value[s]} min={1} step={1} onChange={(n) => form.set({ [s]: Math.max(1, Math.round(n)) } as Partial<Settings["numbering"]>)} aria-label={`Next ${KIND[k].label.toLowerCase()} number`} />
                </Field>
              </div>
            );
          })}
        </div>
      </Card>
      <p className="text-sm text-zinc-600">
        Numbers can only move forward, so an invoice number is never used twice. Changing a prefix applies to new documents; old ones keep
        their numbers. A PC working offline uses its own series (e.g. INV-P1-00003).
      </p>
    </SectionShell>
  );
}
