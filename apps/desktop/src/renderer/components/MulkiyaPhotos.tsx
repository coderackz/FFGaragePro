import { ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { VehicleFileKind } from "@ffgp/shared";
import { del, get, put } from "../lib/api";

export interface Photo { fileName: string; base64: string }
const SIDES: { kind: VehicleFileKind; label: string }[] = [{ kind: "mulkiya_front", label: "Front" }, { kind: "mulkiya_back", label: "Back" }];

/** A photo shrunk to 1600 px on its longest side, as a JPEG: small enough to sync and to send to a vendor. */
export async function shrinkPhoto(file: File): Promise<Photo> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1]!;
  return { fileName: `${file.name.replace(/\.[^.]+$/, "") || "mulkiya"}.jpg`, base64 };
}

/** A vehicle's saved Mulkiya photo, or null. */
export const loadMulkiya = (vehicleId: string, kind: VehicleFileKind) => get<Photo>(`/api/vehicles/${vehicleId}/files/${kind}`).catch(() => null);

/**
 * The Mulkiya's front and back. A saved vehicle saves each photo as it's chosen; a new one keeps them in `pending`
 * until the vehicle is saved.
 */
export function MulkiyaPhotos({ vehicleId, pending, onPending }: {
  vehicleId: string | null; pending: Partial<Record<VehicleFileKind, Photo>>; onPending: (p: Partial<Record<VehicleFileKind, Photo>>) => void;
}) {
  const [saved, setSaved] = useState<Partial<Record<VehicleFileKind, Photo | null>>>({});
  const [busy, setBusy] = useState<VehicleFileKind | null>(null);
  const inputs = useRef<Partial<Record<VehicleFileKind, HTMLInputElement | null>>>({});
  useEffect(() => {
    if (!vehicleId) return setSaved({});
    let live = true;
    void Promise.all(SIDES.map(async (s) => [s.kind, await loadMulkiya(vehicleId, s.kind)] as const)).then((r) => live && setSaved(Object.fromEntries(r)));
    return () => { live = false; };
  }, [vehicleId]);

  const choose = async (kind: VehicleFileKind, file: File | undefined) => {
    if (!file) return;
    setBusy(kind);
    try {
      const photo = await shrinkPhoto(file);
      if (vehicleId) {
        await put(`/api/vehicles/${vehicleId}/files/${kind}`, photo);
        setSaved((s) => ({ ...s, [kind]: photo }));
        toast.success("Mulkiya photo saved");
      } else onPending({ ...pending, [kind]: photo });
    } catch (error) {
      toast.error((error as Error).message || "That photo can't be read");
    } finally {
      setBusy(null);
    }
  };
  const remove = async (kind: VehicleFileKind) => {
    if (vehicleId) {
      await del(`/api/vehicles/${vehicleId}/files/${kind}`).catch((e: Error) => toast.error(e.message));
      setSaved((s) => ({ ...s, [kind]: null }));
    } else onPending({ ...pending, [kind]: undefined });
  };

  return (
    <div className="col-span-2">
      <div className="mb-1.5 text-sm font-medium text-zinc-700">Mulkiya</div>
      <div className="grid grid-cols-2 gap-3">
        {SIDES.map(({ kind, label }) => {
          const photo = vehicleId ? saved[kind] : pending[kind];
          return (
            <div key={kind} className="flex items-center gap-3 rounded-md border border-zinc-200 p-2">
              {photo ? <img src={`data:image/jpeg;base64,${photo.base64}`} alt={`Mulkiya ${label.toLowerCase()}`} className="h-14 w-20 rounded object-cover" />
                : <div className="flex h-14 w-20 items-center justify-center rounded bg-zinc-50 text-xs text-zinc-400">No photo</div>}
              <div className="flex flex-col items-start gap-1 text-xs">
                <span className="font-medium text-zinc-700">{label}</span>
                <button type="button" disabled={busy === kind} onClick={() => inputs.current[kind]?.click()} className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                  <ImagePlus className="size-3.5" />{photo ? "Replace" : "Add photo"}
                </button>
                {photo && <button type="button" onClick={() => void remove(kind)} className="inline-flex items-center gap-1 text-zinc-500 hover:text-red-700"><Trash2 className="size-3.5" />Remove</button>}
                <input ref={(el) => { inputs.current[kind] = el; }} type="file" accept="image/jpeg,image/png" className="hidden" aria-label={`Mulkiya ${label.toLowerCase()} photo`}
                  onChange={(e) => { void choose(kind, e.target.files?.[0]); e.target.value = ""; }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
