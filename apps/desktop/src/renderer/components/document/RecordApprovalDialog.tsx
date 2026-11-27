import { useEffect, useState } from "react";
import { toast } from "sonner";
import { APPROVAL_WAYS, type ApprovalWay } from "@ffgp/shared";
import { post } from "../../lib/api";
import { formatAED } from "../../lib/format";
import type { DocumentFull } from "../../lib/types";
import { Button, Field, Input, Modal, Textarea } from "../ui";

export const APPROVAL_WAY_LABELS: Record<ApprovalWay | "status", string> = {
  phone: "Phone call", in_person: "In person", signed: "Signed copy", reply: "WhatsApp / email reply", status: "Status set by hand",
};

/** "Now" as a datetime-local box wants it, in this computer's time. */
const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/**
 * Records the client's approval of an estimate: who approved it, how and when, and which lines they declined (those
 * stay listed but count nothing, and come off the job card).
 */
export function RecordApprovalDialog({ doc, open, onClose, onDone }: { doc: DocumentFull; open: boolean; onClose: () => void; onDone: (d: DocumentFull) => void }) {
  const [byName, setByName] = useState("");
  const [via, setVia] = useState<ApprovalWay>("phone");
  const [at, setAt] = useState(localNow());
  const [note, setNote] = useState("");
  const [declined, setDeclined] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setByName(doc.customer.name);
    setVia("phone");
    setAt(localNow());
    setNote("");
    setDeclined(new Set());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const approvedTotal = doc.lines.filter((_, i) => !declined.has(i)).reduce((s, l) => s + (l.grossFils ?? 0), 0);
  const save = async () => {
    setBusy(true);
    try {
      const res = await post<{ document: DocumentFull }>(`/api/documents/${doc.id}/approve`, {
        via, byName: byName.trim(), at: new Date(at).toISOString(), note: note.trim() || null, declined: [...declined],
      });
      toast.success(`${res.document.number} approved${doc.forJob ? `: ${doc.forJob.number} updated` : ""}`);
      onDone(res.document);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Record approval — ${doc.number}`} width="max-w-xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!byName.trim() || declined.size === doc.lines.length} onClick={() => void save()}>Record approval</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Approved by" className="col-span-2"><Input value={byName} onChange={(e) => setByName(e.target.value)} aria-label="Approved by" /></Field>
        <fieldset className="col-span-2">
          <legend className="mb-1 text-sm font-medium text-zinc-800">How</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {APPROVAL_WAYS.map((w) => (
              <label key={w} className="inline-flex items-center gap-1.5"><input type="radio" name="approval-way" checked={via === w} onChange={() => setVia(w)} />{APPROVAL_WAY_LABELS[w]}</label>
            ))}
          </div>
        </fieldset>
        <Field label="When"><Input type="datetime-local" value={at} max={localNow()} onChange={(e) => setAt(e.target.value)} aria-label="When" /></Field>
        <fieldset className="col-span-2">
          <legend className="mb-1 text-sm font-medium text-zinc-800">What they approved</legend>
          <ul className="max-h-56 overflow-y-auto rounded-md border border-zinc-200 text-sm">
            {doc.lines.map((l, i) => (
              <li key={l.id ?? i} className="flex items-center gap-2 border-b border-zinc-100 px-3 py-1.5 last:border-0">
                <input type="checkbox" checked={!declined.has(i)} aria-label={`Approved: ${l.description}`}
                  onChange={(e) => setDeclined((d) => { const n = new Set(d); if (e.target.checked) n.delete(i); else n.add(i); return n; })} />
                <span className={`flex-1 ${declined.has(i) ? "text-zinc-400 line-through" : ""}`}>{l.description}</span>
                <span className="tabular text-zinc-600">{formatAED(l.grossFils ?? 0)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-right text-sm">Approved total <b className="tabular">{formatAED(approvedTotal)}</b>{declined.size ? <span className="text-zinc-500"> · {declined.size} declined</span> : null}</div>
        </fieldset>
        <Field label="Note" className="col-span-2"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called at 10:40, agreed to the brakes only" aria-label="Note" /></Field>
      </div>
    </Modal>
  );
}
