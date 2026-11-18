import { useEffect, useState } from "react";
import { toast } from "sonner";
import { post } from "../lib/api";
import { Button, Modal } from "./ui";

interface ImportResult { created: number; updated: number; errors: { row: number; message: string }[] }

const EXAMPLE = "part_no,name,brand,unit,stocked,sell_price,cost,qty,reorder_level,location,fits\nOF-1001,Oil filter,Bosch,each,yes,35.00,18.00,10,4,A1,Nissan Sunny";

export function PartImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setCsv(null); setFileName(""); setCheck(null); }
  }, [open]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setBusy(true);
    try {
      setCheck(await post<ImportResult>("/api/parts/import", { csv: text, dryRun: true }));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!csv) return;
    setBusy(true);
    try {
      const res = await post<ImportResult>("/api/parts/import", { csv, dryRun: false });
      if (res.errors.length) setCheck(res);
      else {
        toast.success(`Imported: ${res.created} new, ${res.updated} updated`);
        onDone();
        onClose();
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ok = check && check.errors.length === 0;
  return (
    <Modal open={open} onClose={onClose} title="Import parts from a spreadsheet" width="max-w-2xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void run()} disabled={!ok} busy={busy}>Import</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-zinc-600">
          Save your parts list as a CSV file. The first row names the columns; <b>part_no</b> and <b>name</b> are required.
          Prices are in AED before VAT. <b>qty</b> and <b>cost</b> set opening stock for new parts. An existing part number updates that part's details.
        </p>
        <pre className="overflow-x-auto rounded-md bg-zinc-50 p-2.5 text-xs text-zinc-600">{EXAMPLE}</pre>
        <label className="flex items-center gap-3">
          <input type="file" accept=".csv,text/csv" onChange={(e) => void choose(e.target.files?.[0])} data-testid="csv-file" />
          {fileName && <span className="text-zinc-500">{fileName}</span>}
        </label>
        {check && ok && <div className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-800">Ready: {check.created} new parts, {check.updated} to update.</div>}
        {check && !ok && (
          <div className="max-h-48 overflow-y-auto rounded-md bg-red-50 px-3 py-2 text-red-800">
            <div className="mb-1 font-medium">Fix these rows and choose the file again — nothing was imported:</div>
            <ul className="list-disc pl-5">{check.errors.map((e) => <li key={`${e.row}-${e.message}`}>Row {e.row}: {e.message}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
