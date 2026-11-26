import type { DocType } from "@ffgp/shared";
import clsx from "clsx";
import { Printer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePicker } from "../../../components/ImagePicker";
import { Button, Card, Field, NumberInput, Textarea } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { printHtml } from "../../../print/print";
import { SAMPLE_DOCUMENTS } from "../../../print/sample";
import { renderDocumentHtml } from "../../../print/templates";
import { Choice, Toggle } from "../fields";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

const A4_WIDTH = 794; // 210 mm at 96 dpi
const A4_HEIGHT = 1123;
const KINDS: { value: DocType; label: string }[] = [
  { value: "invoice", label: "Invoice" },
  { value: "estimate", label: "Estimate" },
  { value: "jobcard", label: "Job card" },
];

/** Documents & printing: logo, stamp, signature, paper, wording — with a live A4 preview of the unsaved values. */
export function DocumentsSection() {
  const { garage, settings } = useAuth();
  const form = useSectionForm("documents");
  const d = form.value;
  const [kind, setKind] = useState<DocType>("invoice");
  const html = useMemo(
    () => renderDocumentHtml(SAMPLE_DOCUMENTS[kind], garage!, { ...settings!, documents: d }),
    [kind, garage, settings, d],
  );

  const preview = (
    <div className="sticky top-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-zinc-900">Preview</div>
        <div className="flex rounded-md bg-zinc-100 p-0.5 text-xs" role="tablist" aria-label="Sample document">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              role="tab"
              aria-selected={kind === k.value}
              onClick={() => setKind(k.value)}
              className={clsx("rounded px-2 py-1", kind === k.value ? "bg-white font-medium text-zinc-900 shadow-xs" : "text-zinc-600 hover:text-zinc-900")}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <A4Preview html={html} />
      <div className="mt-2 flex items-center justify-between text-xs text-zinc-600">
        <span>Sample {KINDS.find((k) => k.value === kind)!.label.toLowerCase()} with your settings</span>
        <Button size="sm" variant="ghost" icon={<Printer className="size-3.5" />} onClick={() => void printHtml(html, "Test page", "print")}>Print a test page</Button>
      </div>
    </div>
  );

  return (
    <SectionShell title="Documents & printing" subtitle="How estimates, job cards and invoices look on A4" dirty={form.dirty} busy={form.busy} onSave={() => void form.save()} aside={preview}>
      <Card title="Images">
        <div className="grid gap-3 sm:grid-cols-3">
          <ImagePicker label="Logo" value={d.logo} onChange={(logo) => form.set({ logo })} hint="Top left of every page" />
          <ImagePicker label="Stamp" value={d.stamp} onChange={(stamp) => form.set({ stamp })} hint="Beside the signature" />
          <ImagePicker label="Signature" value={d.signature} onChange={(signature) => form.set({ signature })} hint="Above “For your garage”" />
        </div>
        <p className="mt-2 text-xs text-zinc-600">PNG or JPG, up to 500 KB each. A transparent PNG looks best for the stamp and signature.</p>
      </Card>
      <Card title="Paper">
        <Choice
          name="Paper"
          value={d.paper}
          onChange={(paper) => form.set({ paper })}
          options={[
            { value: "plain", label: "Plain paper", hint: "Print the logo and garage details" },
            { value: "letterhead", label: "Letterhead paper", hint: "Leave the top blank for pre-printed paper" },
          ]}
        />
        {d.paper === "letterhead" && (
          <Field label="Blank space at the top (mm)" className="mt-3 max-w-xs">
            <NumberInput value={d.letterheadTopMm} min={10} step={1} onChange={(n) => form.set({ letterheadTopMm: Math.min(120, Math.max(10, Math.round(n))) })} aria-label="Blank space at the top" />
          </Field>
        )}
      </Card>
      <Card title="Wording">
        <div className="space-y-4">
          <Field label="Invoice terms & footer" hint="Printed at the foot of invoices, under your bank details">
            <Textarea rows={3} value={d.terms ?? ""} onChange={(e) => form.set({ terms: e.target.value })} placeholder="e.g. Payment due within 30 days. Cheques payable to …" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Warranty line" hint="Printed on invoices">
              <Textarea rows={2} value={d.warranty ?? ""} onChange={(e) => form.set({ warranty: e.target.value })} placeholder="e.g. Labour: 3 months / 5,000 km" />
            </Field>
            <Field label="Estimates valid for (days)">
              <NumberInput value={d.estimateValidDays} min={1} step={1} onChange={(n) => form.set({ estimateValidDays: Math.min(365, Math.max(1, Math.round(n))) })} aria-label="Estimates valid for" />
            </Field>
          </div>
        </div>
      </Card>
      <Card title="On every document">
        <Toggle label="Show part numbers" checked={d.showPartNumbers} onChange={(showPartNumbers) => form.set({ showPartNumbers })} />
        <Toggle label="Show labour as hours" hint="1.5 h instead of 1.5" checked={d.showLabourHours} onChange={(showLabourHours) => form.set({ showLabourHours })} />
        <Toggle label="Customer authorisation on job cards" hint="“I authorise the work above” with a signature line" checked={d.jobCardSignature} onChange={(jobCardSignature) => form.set({ jobCardSignature })} />
      </Card>
    </SectionShell>
  );
}

/** The printed page, scaled down to fit its column. */
function A4Preview({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.45);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / A4_WIDTH);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="overflow-hidden rounded-md bg-white shadow-md ring-1 ring-zinc-200" style={{ height: A4_HEIGHT * scale }}>
      <iframe
        title="Document preview"
        srcDoc={html}
        sandbox=""
        data-testid="print-preview"
        style={{ width: A4_WIDTH, height: A4_HEIGHT, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }}
      />
    </div>
  );
}
