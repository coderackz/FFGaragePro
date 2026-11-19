import type { Settings, SettingsSection } from "@ffgp/shared";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { put } from "../../lib/api";
import { useAuth } from "../../lib/auth";

/** A Settings section's unsaved copy, whether it differs, and its Save (only this section's fields are sent). */
export function useSectionForm<S extends SettingsSection>(section: S) {
  const { settings, refreshGarage } = useAuth();
  const saved = settings![section];
  const [value, setValue] = useState<Settings[S]>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(saved), [saved]);
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  const set = (patch: Partial<Settings[S]>) => setValue((v) => ({ ...v, ...patch }));
  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      await put(`/api/settings/${section}`, value);
      await refreshGarage();
      toast.success("Saved");
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { value, set, setValue, dirty, busy, save, saved };
}
