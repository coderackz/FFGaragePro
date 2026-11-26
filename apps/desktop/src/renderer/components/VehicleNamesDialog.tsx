import { useEffect, useState } from "react";
import { toast } from "sonner";
import { correctMake, correctModel } from "@ffgp/shared";
import { post } from "../lib/api";
import { forgetGarageNames, garageNames, type VehicleNames } from "./MakeModelFields";
import { Button, Input, Modal } from "./ui";

type Editing = { kind: "make" | "model"; make?: string; from: string; to: string };

/**
 * The owner tidies the garage's makes and models: how many vehicles use each, which look like a name on the list
 * ("looks like Toyota"), and renaming or merging a spelling — every vehicle and part with it changes.
 */
export function VehicleNamesDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [names, setNames] = useState<VehicleNames | null>(null);
  const [make, setMake] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setMake(null);
    setEditing(null);
    void garageNames(true).then(setNames);
  }, [open]);

  const rename = async (e: Editing) => {
    setBusy(true);
    try {
      const res = await post<VehicleNames & { vehicles: number; fitments: number }>("/api/vehicle-names/rename", e);
      forgetGarageNames();
      setNames({ makes: res.makes, models: res.models });
      setEditing(null);
      if (e.kind === "make" && make === e.from) setMake(e.to);
      toast.success(`${e.from} is now ${e.to}: ${res.vehicles} ${res.vehicles === 1 ? "vehicle" : "vehicles"}${res.fitments ? `, ${res.fitments} on parts` : ""}`);
      onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const others = (except: string) => (names?.makes ?? []).map((m) => m.name).filter((n) => n !== except);
  const row = (kind: "make" | "model", name: string, vehicles: number, looksLike: string | null, ofMake?: string) => {
    const isEditing = editing && editing.kind === kind && editing.from === name && editing.make === ofMake;
    return (
      <li key={`${kind}:${ofMake ?? ""}:${name}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-100 px-3 py-2 text-sm last:border-0">
        {kind === "make"
          ? <button type="button" className={`font-medium hover:underline ${make === name ? "text-brand-700" : "text-zinc-800"}`} onClick={() => setMake(make === name ? null : name)}>{name}</button>
          : <span className="font-medium text-zinc-800">{name}</span>}
        <span className="text-xs text-zinc-500">{vehicles} {vehicles === 1 ? "vehicle" : "vehicles"}</span>
        {looksLike && !isEditing && (
          <span className="text-xs text-amber-700">
            Looks like {looksLike} ·{" "}
            <button type="button" className="font-medium text-brand-700 hover:underline" disabled={busy} onClick={() => void rename({ kind, make: ofMake, from: name, to: looksLike })}>
              Change to {looksLike}
            </button>
          </span>
        )}
        {isEditing ? (
          <span className="ml-auto flex items-center gap-2">
            <Input value={editing.to} onChange={(e) => setEditing({ ...editing, to: e.target.value })} className="h-8 w-48" aria-label={`New name for ${name}`} autoFocus />
            <Button size="sm" variant="primary" busy={busy} disabled={!editing.to.trim()} onClick={() => void rename(editing)}>Save</Button>
            <Button size="sm" onClick={() => setEditing(null)}>Cancel</Button>
          </span>
        ) : (
          <button type="button" className="ml-auto text-xs font-medium text-brand-700 hover:underline" onClick={() => setEditing({ kind, make: ofMake, from: name, to: name })}>Rename</button>
        )}
      </li>
    );
  };

  const models = (names?.models ?? []).filter((m) => m.make === make);
  return (
    <Modal open={open} onClose={onClose} title="Makes & models" width="max-w-2xl" footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-3 text-sm text-zinc-600">
        The names your vehicles and parts use. Renaming one changes every vehicle and part with it; renaming to a name already here merges the two.
      </p>
      {!names ? <div className="text-sm text-zinc-500">Loading…</div> : names.makes.length === 0 ? <div className="text-sm text-zinc-500">No vehicles yet.</div> : (
        <div className="grid grid-cols-2 gap-4">
          <ul className="max-h-96 overflow-y-auto rounded-md border border-zinc-200" data-testid="garage-makes">
            {names.makes.map((m) => {
              const c = correctMake(m.name, others(m.name));
              return row("make", m.name, m.vehicles, c?.note ? c.value : null);
            })}
          </ul>
          <ul className="max-h-96 overflow-y-auto rounded-md border border-zinc-200" data-testid="garage-models">
            {!make ? <li className="px-3 py-2 text-sm text-zinc-500">Choose a make to see its models.</li>
              : models.length === 0 ? <li className="px-3 py-2 text-sm text-zinc-500">No models for {make}.</li>
                : models.map((m) => {
                  const c = correctModel(m.name, make, models.filter((x) => x.name !== m.name));
                  return row("model", m.name, m.vehicles, c?.note ? c.value : null, make);
                })}
          </ul>
        </div>
      )}
    </Modal>
  );
}
