import { useState, type FormEvent } from "react";
import { Button, Field, Input, Modal } from "./ui";

/** The cloud address used until Fleetfix cloud has its own web address (Stage 3). */
export const DEFAULT_CLOUD_URL = "http://localhost:4790";

/**
 * Links this PC to its Fleetfix cloud garage.
 * - download (a new PC with no garage yet): sign in, and the cloud garage is copied to this PC.
 * - upload (this PC already has a garage): the setup code from Fleet Fix, and this PC's garage goes to the new cloud garage.
 */
export function CloudConnectDialog({ mode, onClose }: { mode: "download" | "upload"; onClose: () => void }) {
  const [form, setForm] = useState({ url: DEFAULT_CLOUD_URL, garageCode: "", deviceName: window.ffgp?.hostname ?? "", username: "", password: "", setupCode: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.ffgp) return;
    setBusy(true);
    setError(null);
    const result = await window.ffgp.cloudLink({ mode, ...form, setupCode: form.setupCode.trim().toUpperCase() });
    // On success the app reloads into the linked garage.
    if (result.error) {
      setError(result.error);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Connect to Fleetfix cloud"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="cloud-connect" variant="primary" busy={busy}>{mode === "download" ? "Sign in and download" : "Upload this garage"}</Button>
        </>
      }
    >
      <form id="cloud-connect" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-zinc-600">
          {mode === "download"
            ? "Sign in with your garage's username and password. Your garage's data will be copied to this PC, and from then on changes made here and in the browser are kept in step."
            : "Your garage's data will be copied to Fleetfix cloud. The cloud garage must be new: use the setup code Fleet Fix gave you."}
        </p>
        <Field label="Garage ID" hint="From Fleet Fix, e.g. alquoz-auto">
          <Input {...f("garageCode")} required autoFocus autoComplete="off" />
        </Field>
        {mode === "download" ? (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Username"><Input {...f("username")} required autoComplete="username" /></Field>
            <Field label="Password"><Input {...f("password")} type="password" required autoComplete="current-password" /></Field>
          </div>
        ) : (
          <Field label="Setup code" hint="8 letters and numbers, from the welcome message Fleet Fix sent you.">
            <Input value={form.setupCode} onChange={(e) => setForm({ ...form, setupCode: e.target.value.toUpperCase() })} required autoComplete="off" className="font-mono tracking-widest" />
          </Field>
        )}
        <Field label="This PC's name" hint="So you can tell your PCs apart, e.g. Front desk">
          <Input {...f("deviceName")} required />
        </Field>
        <Field label="Cloud address"><Input {...f("url")} required /></Field>
        {error && <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      </form>
    </Modal>
  );
}
