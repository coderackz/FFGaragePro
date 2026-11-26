import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { correctMake, correctModel, MAKE_NAMES, makeFromVin, makeOfModel, modelsOf, nameKey, type Correction } from "@ffgp/shared";
import { get } from "../lib/api";
import { Field, Input } from "./ui";

export interface VehicleNames { makes: { name: string; vehicles: number }[]; models: { make: string; name: string; vehicles: number }[] }

// The garage's own names change rarely: fetched once for a little while, shared by every box on the screen.
let cache: { at: number; names: Promise<VehicleNames> } | null = null;
export function garageNames(fresh = false): Promise<VehicleNames> {
  if (fresh || !cache || Date.now() - cache.at > 30_000) {
    cache = { at: Date.now(), names: get<VehicleNames>("/api/vehicle-names").catch(() => ({ makes: [], models: [] })) };
  }
  return cache.names;
}
export const forgetGarageNames = () => { cache = null; };

function useGarageNames(): VehicleNames {
  const [names, setNames] = useState<VehicleNames>({ makes: [], models: [] });
  useEffect(() => {
    let live = true;
    void garageNames().then((n) => live && setNames(n));
    return () => { live = false; };
  }, []);
  return names;
}

/** Names once, in order, whatever their capitals or spaces. */
const unique = (names: string[]) => {
  const seen = new Set<string>();
  return names.filter((n) => { const k = nameKey(n); if (!k || seen.has(k)) return false; seen.add(k); return true; });
};

type Box = "make" | "model";
interface Note { from: string; text: string }

/**
 * Make and model boxes that suggest the list's and the garage's names while typing and, when the box is left,
 * correct a close misspelling or a short name on their own ("Corrected from Toyta · Undo"). A name that isn't close
 * to any is kept as typed. A model typed with no make fills the make when only one make has it; so does a VIN.
 * `layout` "form": labelled fields; "row": bare boxes for a table row.
 */
export function MakeModelFields({ make, model, vin, onChange, layout = "form", label }: {
  make: string; model: string; vin?: string; layout?: "form" | "row";
  /** Row layout: what the boxes are called for screen readers ("Make 2"). */
  label?: { make: string; model: string };
  onChange: (p: { make?: string; model?: string }) => void;
}) {
  const names = useGarageNames();
  const id = useId();
  const [notes, setNotes] = useState<Partial<Record<Box, Note>>>({});
  // What was kept with Undo: not corrected again on this form.
  const kept = useRef<Record<Box, Set<string>>>({ make: new Set(), model: new Set() });
  const garageMakes = names.makes.map((m) => m.name);
  const makeOptions = unique([...MAKE_NAMES, ...garageMakes]);
  const modelOptions = unique([...modelsOf(make), ...names.models.filter((m) => nameKey(m.make) === nameKey(make)).map((m) => m.name)]);

  /** What to change for a correction (none when kept with Undo), and its note. */
  const corrected = (box: Box, typed: string, c: Correction | null): { patch: { make?: string; model?: string }; note?: Note } | null => {
    if (!c || kept.current[box].has(typed)) return null;
    return { patch: { [box]: c.value }, note: c.note ? { from: typed, text: `Corrected from ${typed}` } : undefined };
  };
  const leaveMake = () => {
    const c = corrected("make", make, correctMake(make, garageMakes));
    if (!c) return;
    onChange(c.patch);
    setNotes((n) => ({ ...n, make: c.note }));
  };
  // One change for both boxes: a model with no make fills the make, then the model is corrected among its models.
  const leaveModel = () => {
    if (!nameKey(model)) return;
    const patch: { make?: string; model?: string } = {};
    const next: Partial<Record<Box, Note>> = {};
    let theMake = make;
    if (!nameKey(make) && !kept.current.make.has("")) {
      const found = makeOfModel(model);
      if (found) {
        patch.make = found;
        next.make = { from: "", text: "Filled in from the model" };
        theMake = found;
      }
    }
    const c = corrected("model", model, correctModel(model, theMake, names.models));
    if (c) {
      patch.model = c.patch.model;
      next.model = c.note;
    }
    if (patch.make === undefined && patch.model === undefined) return;
    onChange(patch);
    setNotes((n) => ({ ...n, ...("make" in next ? { make: next.make } : {}), ...("model" in next ? { model: next.model } : {}) }));
  };
  // A VIN typed with no make: the make its manufacturer code says.
  useEffect(() => {
    if (!vin || nameKey(make) || kept.current.make.has("")) return;
    const found = makeFromVin(vin);
    if (found && vin.trim().length >= 17) {
      onChange({ make: found });
      setNotes((n) => ({ ...n, make: { from: "", text: "Filled in from the VIN" } }));
    }
  }, [vin]); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = (box: Box) => {
    const note = notes[box];
    if (!note) return;
    kept.current[box].add(note.from);
    onChange({ [box]: note.from });
    setNotes((n) => ({ ...n, [box]: undefined }));
  };
  const noteLine = (box: Box) => notes[box] && (
    <div className="mt-0.5 text-xs text-zinc-500" data-testid={`${box}-note`}>
      {notes[box]!.text} · <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => undo(box)}>Undo</button>
    </div>
  );
  const box = (which: Box, el: ReactNode) => (layout === "form"
    ? <Field label={which === "make" ? "Make" : "Model"}>{el}{noteLine(which)}</Field>
    : <div>{el}{noteLine(which)}</div>);

  return (
    <>
      {box("make", (
        <Input value={make} list={`${id}-makes`} placeholder={layout === "form" ? "Toyota" : "Make"} aria-label={label?.make ?? "Make"} autoComplete="off"
          onChange={(e) => { setNotes((n) => ({ ...n, make: undefined })); onChange({ make: e.target.value }); }} onBlur={leaveMake} />
      ))}
      {box("model", (
        <Input value={model} list={`${id}-models`} placeholder={layout === "form" ? "Land Cruiser" : "Model"} aria-label={label?.model ?? "Model"} autoComplete="off"
          onChange={(e) => { setNotes((n) => ({ ...n, model: undefined })); onChange({ model: e.target.value }); }} onBlur={leaveModel} />
      ))}
      <datalist id={`${id}-makes`}>{makeOptions.map((n) => <option key={n} value={n} />)}</datalist>
      <datalist id={`${id}-models`}>{modelOptions.map((n) => <option key={n} value={n} />)}</datalist>
    </>
  );
}
