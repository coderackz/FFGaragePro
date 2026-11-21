import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Card, Field, Input, Modal, NumberInput, Select, Table } from "../../../components/ui";
import { patch, post } from "../../../lib/api";
import type { PartCategory } from "../../../lib/types";
import { useApi } from "../../../lib/useApi";
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
      <CategoriesCard />
      <Card title="New parts">
        <Field label="Default reorder level" hint="New parts start with this level" className="max-w-xs">
          <NumberInput value={form.value.defaultReorderLevel} min={0} onChange={(n) => form.set({ defaultReorderLevel: Math.max(0, n) })} aria-label="Default reorder level" />
        </Field>
      </Card>
    </SectionShell>
  );
}

type Attr = PartCategory["attributes"][number];
/** Parts categories and the specs each one asks for (a tyre's width, profile and rim; an oil's grade…). */
function CategoriesCard() {
  const { data, reload } = useApi<{ categories: PartCategory[] }>("/api/part-categories");
  const [editing, setEditing] = useState<PartCategory | "new" | null>(null);
  return (
    <Card padded={false} title="Parts categories" actions={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing("new")}>New category</Button>}>
      <Table rows={data?.categories ?? []} rowKey={(c) => c.id} onRowClick={(c) => setEditing(c)}
        columns={[
          { header: "Category", cell: (c) => <span className="font-medium">{c.name}</span> },
          { header: "Specs", cell: (c) => <span className="text-zinc-600">{c.attributes.map((a) => a.label).join(", ") || "—"}</span> },
        ]} />
      <CategoryForm category={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />
    </Card>
  );
}

function CategoryForm({ category, onClose, onSaved }: { category: PartCategory | "new" | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [attrs, setAttrs] = useState<Attr[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!category) return;
    setName(category === "new" ? "" : category.name);
    setAttrs(category === "new" ? [] : category.attributes);
  }, [category]);
  const set = (i: number, p: Partial<Attr>) => setAttrs((a) => a.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "a$1").slice(0, 30) || "spec";
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, attributes: attrs.map((a) => ({ ...a, key: a.key || keyOf(a.label), options: a.type === "choice" ? a.options ?? [] : undefined })) };
      if (category === "new") await post("/api/part-categories", body); else if (category) await patch(`/api/part-categories/${category.id}`, body);
      toast.success("Category saved"); onClose(); onSaved();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!category} onClose={onClose} title={category === "new" ? "New category" : `Edit ${category ? (category as PartCategory).name : ""}`} width="max-w-2xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save category</Button></>}>
      <Field label="Name" className="max-w-sm"><Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Category name" /></Field>
      <div className="mt-4 mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Specs asked for on its parts</span>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setAttrs((a) => [...a, { key: "", label: "", type: "text" }])}>Add spec</Button>
      </div>
      <div className="space-y-2">
        {attrs.map((a, i) => (
          <div key={i} className="grid grid-cols-[1fr_110px_80px_1fr_auto] gap-2">
            <Input value={a.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="Label" aria-label={`Spec ${i + 1}`} />
            <Select value={a.type} onChange={(e) => set(i, { type: e.target.value as Attr["type"] })} aria-label={`Spec type ${i + 1}`}>
              <option value="text">Text</option><option value="number">Number</option><option value="choice">Choice</option>
            </Select>
            <Input value={a.unit ?? ""} onChange={(e) => set(i, { unit: e.target.value || null })} placeholder="Unit" aria-label={`Spec unit ${i + 1}`} />
            <Input value={(a.options ?? []).join(", ")} disabled={a.type !== "choice"} onChange={(e) => set(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
              placeholder={a.type === "choice" ? "Choices, separated by commas" : "—"} aria-label={`Spec choices ${i + 1}`} />
            <button type="button" onClick={() => setAttrs((x) => x.filter((_, j) => j !== i))} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600" aria-label={`Remove spec ${i + 1}`}><Trash2 className="size-4" /></button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

