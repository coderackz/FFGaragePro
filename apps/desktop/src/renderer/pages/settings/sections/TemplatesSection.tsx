import { PLACEHOLDERS, TEMPLATE_CHANNELS } from "@ffgp/shared";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Card, Empty, Field, Input, Modal, Select, Table, Textarea } from "../../../components/ui";
import { patch, post } from "../../../lib/api";
import { useApi } from "../../../lib/useApi";
import { SectionShell } from "../SectionShell";

export interface MessageTemplate {
  id: string; name: string; channel: "email" | "whatsapp" | "both"; subjectEn: string | null; subjectAr: string | null; textEn: string; textAr: string;
  waTemplateName: string | null; waLanguage: string | null; waParams: string[]; archived: boolean;
}
const CHANNEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", both: "Email and WhatsApp" };
type Draft = Omit<MessageTemplate, "id" | "archived">;
const blank = (): Draft => ({ name: "", channel: "both", subjectEn: "", subjectAr: "", textEn: "", textAr: "", waTemplateName: null, waLanguage: null, waParams: [] });

/** Settings → Message templates: the garage's own texts, picked in the Send dialog (the per-message texts stay the default). */
export function TemplatesSection() {
  const { data, reload } = useApi<{ templates: MessageTemplate[] }>("/api/message-templates?archived=1");
  const [editing, setEditing] = useState<MessageTemplate | "new" | null>(null);
  const archive = async (t: MessageTemplate) => {
    if (!window.confirm(`Archive "${t.name}"? It won't be offered any more; messages already sent keep their text.`)) return;
    try { await post(`/api/message-templates/${t.id}/archive`, {}); toast.success("Archived"); await reload(); } catch (err) { toast.error((err as Error).message); }
  };
  return (
    <SectionShell title="Message templates" subtitle="Your own texts for email and WhatsApp, picked when sending">
      <Card padded={false} title="Templates" actions={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing("new")}>New template</Button>}>
        <Table rows={data?.templates ?? []} rowKey={(t) => t.id} onRowClick={(t) => !t.archived && setEditing(t)}
          empty={<Empty title="No templates yet">The texts in Settings → Messages are used until you add your own.</Empty>}
          columns={[
            { header: "Name", cell: (t) => <span className="font-medium">{t.name}{t.archived && <span className="ml-2"><Badge>Archived</Badge></span>}</span> },
            { header: "For", cell: (t) => CHANNEL[t.channel] },
            { header: "Text", cell: (t) => <span className="line-clamp-1 text-zinc-600">{t.textEn}</span> },
            { header: "WhatsApp API", cell: (t) => t.waTemplateName ?? "" },
            { header: "", cell: (t) => (!t.archived ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void archive(t); }}>Archive</Button> : null) },
          ]} />
      </Card>
      <TemplateForm template={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />
    </SectionShell>
  );
}

function TemplateForm({ template, onClose, onSaved }: { template: MessageTemplate | "new" | null; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(blank());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (template) setD(template === "new" ? blank() : { ...template }); }, [template]);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const email = d.channel !== "whatsapp";
  const save = async () => {
    setBusy(true);
    try {
      if (template === "new") await post("/api/message-templates", d); else if (template) await patch(`/api/message-templates/${template.id}`, d);
      toast.success("Template saved"); onClose(); onSaved();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!template} title={template === "new" ? "New template" : `Edit ${template ? (template as MessageTemplate).name : ""}`} onClose={onClose} width="max-w-2xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save template</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><Input value={d.name} onChange={(e) => set({ name: e.target.value })} aria-label="Name" /></Field>
        <Field label="Used for">
          <Select value={d.channel} onChange={(e) => set({ channel: e.target.value as Draft["channel"] })} aria-label="Used for">
            {TEMPLATE_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL[c]}</option>)}
          </Select>
        </Field>
        {email && <Field label="Subject (English)"><Input value={d.subjectEn ?? ""} onChange={(e) => set({ subjectEn: e.target.value })} aria-label="Subject (English)" /></Field>}
        {email && <Field label="Subject (Arabic)"><Input dir="rtl" value={d.subjectAr ?? ""} onChange={(e) => set({ subjectAr: e.target.value })} aria-label="Subject (Arabic)" /></Field>}
        <Field label="Text (English)" className="col-span-2"><Textarea rows={4} value={d.textEn} onChange={(e) => set({ textEn: e.target.value })} aria-label="Text (English)" /></Field>
        <Field label="Text (Arabic)" className="col-span-2"><Textarea rows={4} dir="rtl" value={d.textAr} onChange={(e) => set({ textAr: e.target.value })} aria-label="Text (Arabic)" /></Field>
      </div>
      <p className="mt-2 text-xs text-zinc-500">Placeholders: {PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}</p>
      {d.channel !== "email" && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-zinc-700">WhatsApp Business API (when connected)</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Approved template name" hint="As approved by Meta"><Input value={d.waTemplateName ?? ""} onChange={(e) => set({ waTemplateName: e.target.value || null })} aria-label="Approved template name" /></Field>
            <Field label="Language code" hint="e.g. en, ar"><Input value={d.waLanguage ?? ""} onChange={(e) => set({ waLanguage: e.target.value || null })} aria-label="Language code" /></Field>
            <Field label="Body parameters, in order" hint="Placeholder names separated by commas, e.g. customer, plate" className="col-span-2">
              <Input value={d.waParams.join(", ")} onChange={(e) => set({ waParams: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} aria-label="Body parameters" />
            </Field>
          </div>
        </details>
      )}
    </Modal>
  );
}
