import { DATE_FORMATS, type BankMapping } from "@ffgp/shared";
import { ArrowLeft, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { Button, Card, Field, Input, PageHeader, Select, Spinner, Table } from "../../components/ui";
import type { Account } from "../../books/types";
import { post, put } from "../../lib/api";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);

interface View {
  mapping: BankMapping | null;
  lines: { id: string; date: string; description: string; amountFils: number; reference: string | null; matchedLineId: string | null }[];
  suggestions: { bankLineId: string; journalLineId: string }[];
  unmatchedBookLines: { journalLineId: string; entryId: string; number: string; date: string; narration: string; amountFils: number }[];
  bookBalanceFils: number;
  statementBalanceFils: number;
}

/** The first row of a CSV, split into cells (quoted cells may hold commas). */
function headerCells(csv: string): string[] {
  const line = csv.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cell.trim()); cell = ""; } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

type Cols = { date: string; description: string; out: string; in: string; amount: string; reference: string; dateFormat: string; hasHeader: boolean };
const toCols = (m: BankMapping | null): Cols => ({
  date: m ? String(m.date) : "", description: m ? String(m.description) : "", out: m?.debit !== undefined ? String(m.debit) : "", in: m?.credit !== undefined ? String(m.credit) : "",
  amount: m?.amount !== undefined ? String(m.amount) : "", reference: m?.reference !== undefined ? String(m.reference) : "", dateFormat: m?.dateFormat ?? "dd/mm/yyyy", hasHeader: m?.hasHeader ?? true,
});
const toMapping = (c: Cols): BankMapping => ({
  date: Number(c.date), description: Number(c.description), dateFormat: c.dateFormat as BankMapping["dateFormat"], hasHeader: c.hasHeader,
  ...(c.amount ? { amount: Number(c.amount) } : { debit: Number(c.out), credit: Number(c.in) }), ...(c.reference ? { reference: Number(c.reference) } : {}),
});

/** Bank reconciliation: import the bank's statement, match its lines to the books, add bank charges, until it agrees. */
export function ReconcilePage() {
  const { id } = useParams();
  const view = useApi<View>(`/api/money-accounts/${id}/reconcile`);
  const accounts = useApi<{ accounts: Account[] }>("/api/books/accounts");
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [cols, setCols] = useState<Cols>(toCols(null));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => { if (view.data) setCols(toCols(view.data.mapping)); }, [view.data?.mapping]); // eslint-disable-line react-hooks/exhaustive-deps

  const account = accounts.data?.accounts.find((a) => a.id === id);
  const charges = accounts.data?.accounts.find((a) => a.code === "6030") ?? accounts.data?.accounts.find((a) => a.type === "expense" && a.active);
  const headers = csv ? headerCells(csv.text) : [];
  const needsMapping = !view.data?.mapping || editing;
  const colOptions = headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>);
  const set = (p: Partial<Cols>) => setCols((c) => ({ ...c, ...p }));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await view.reload(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  const importFile = () => run(async () => {
    if (!csv) return;
    if (needsMapping) await put(`/api/money-accounts/${id}/mapping`, toMapping(cols));
    const r = await post<{ added: number; skipped: number }>(`/api/money-accounts/${id}/imports`, { fileName: csv.name, csv: csv.text });
    setResult(`${r.added} line${r.added === 1 ? "" : "s"} imported${r.skipped ? `, ${r.skipped} already here` : ""}`);
    setCsv(null);
    setEditing(false);
  });

  if (!view.data) return <Spinner />;
  const v = view.data;
  const suggestion = (lineId: string) => v.suggestions.find((s) => s.bankLineId === lineId);
  const book = (journalLineId: string) => v.unmatchedBookLines.find((b) => b.journalLineId === journalLineId);
  const unmatched = v.lines.filter((l) => !l.matchedLineId).length;
  const reconciled = v.lines.length > 0 && unmatched === 0 && v.unmatchedBookLines.length === 0 && v.bookBalanceFils === v.statementBalanceFils;

  return (
    <>
      <PageHeader back={<Link to="/bank" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Bank & cash</Link>}
        title={`Reconcile ${account ? `${account.code} ${account.name}` : ""}`}
        subtitle={<span data-testid="reconciled" className={reconciled ? "text-emerald-700" : "text-amber-700"}>
          {reconciled ? "Reconciled" : `Books ${formatAED(v.bookBalanceFils)} · statement ${formatAED(v.statementBalanceFils)} · ${unmatched} statement line${unmatched === 1 ? "" : "s"} and ${v.unmatchedBookLines.length} book entr${v.unmatchedBookLines.length === 1 ? "y" : "ies"} to match`}
        </span>} />
      <Card title="Import a statement" className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Bank statement (CSV)">
            <Input type="file" accept=".csv,text/csv" aria-label="Bank statement (CSV)"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((text) => setCsv({ name: f.name, text })); }} />
          </Field>
          {v.mapping && !editing && <Button variant="ghost" onClick={() => setEditing(true)}>Change columns</Button>}
          <Button variant="primary" icon={<Upload className="size-4" />} busy={busy} disabled={!csv} onClick={() => void importFile()}>Import</Button>
          {result && <span className="text-sm text-zinc-700">{result}</span>}
        </div>
        {csv && needsMapping && (
          <div className="mt-4 grid grid-cols-4 gap-3 max-md:grid-cols-2">
            <Field label="Date column"><Select value={cols.date} onChange={(e) => set({ date: e.target.value })} aria-label="Date column"><option value="">Choose…</option>{colOptions}</Select></Field>
            <Field label="Details column"><Select value={cols.description} onChange={(e) => set({ description: e.target.value })} aria-label="Details column"><option value="">Choose…</option>{colOptions}</Select></Field>
            <Field label="Money out column"><Select value={cols.out} onChange={(e) => set({ out: e.target.value, amount: "" })} aria-label="Money out column"><option value="">—</option>{colOptions}</Select></Field>
            <Field label="Money in column"><Select value={cols.in} onChange={(e) => set({ in: e.target.value, amount: "" })} aria-label="Money in column"><option value="">—</option>{colOptions}</Select></Field>
            <Field label="Or one amount column" hint="Money out as minus"><Select value={cols.amount} onChange={(e) => set({ amount: e.target.value, out: "", in: "" })} aria-label="Amount column"><option value="">—</option>{colOptions}</Select></Field>
            <Field label="Reference column"><Select value={cols.reference} onChange={(e) => set({ reference: e.target.value })} aria-label="Reference column"><option value="">—</option>{colOptions}</Select></Field>
            <Field label="Date format"><Select value={cols.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })} aria-label="Date format">{DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}</Select></Field>
            <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={cols.hasHeader} onChange={(e) => set({ hasHeader: e.target.checked })} /> First row is headings</label>
          </div>
        )}
      </Card>
      <Card title="Statement lines" padded={false}>
        <Table rows={v.lines} rowKey={(l) => l.id} empty={<div className="px-4 py-3 text-sm text-zinc-600">Import a statement to start</div>}
          columns={[
            { header: "Date", cell: (l) => day(l.date) },
            { header: "Details", cell: (l) => `${l.description}${l.reference ? ` · ${l.reference}` : ""}` },
            { header: "Amount", cell: (l) => formatAED(l.amountFils), align: "right" },
            {
              header: "Books",
              cell: (l) => {
                if (l.matchedLineId) return <span className="flex items-center gap-2 text-emerald-700">Matched <Button size="sm" variant="ghost" onClick={() => void run(() => post(`/api/bank-lines/${l.id}/unmatch`, {}))}>Undo</Button></span>;
                const s = suggestion(l.id);
                const b = s ? book(s.journalLineId) : null;
                if (s && b) {
                  return <span className="flex items-center gap-2"><span className="text-xs text-zinc-600">{b.number} · {b.narration}</span>
                    <Button size="sm" onClick={() => void run(() => post(`/api/bank-lines/${l.id}/match`, { journalLineId: s.journalLineId }))}>Accept match</Button></span>;
                }
                if (l.amountFils < 0 && charges) {
                  return <Button size="sm" variant="ghost" onClick={() => void run(() => post(`/api/bank-lines/${l.id}/expense`, { accountId: charges.id, vat: "none", description: l.description || "Bank charges" }))}>Add as bank charge</Button>;
                }
                return <span className="text-xs text-zinc-500">Nothing in the books yet</span>;
              },
            },
          ]} />
      </Card>
      {v.unmatchedBookLines.length > 0 && (
        <Card title="In the books, not on the statement" className="mt-5" padded={false}>
          <Table rows={v.unmatchedBookLines} rowKey={(b) => b.journalLineId}
            columns={[
              { header: "Date", cell: (b) => day(b.date) },
              { header: "Journal", cell: (b) => <Link to={`/books/journals/${b.entryId}`} className="font-mono text-[13px] text-brand-700 hover:underline">{b.number}</Link> },
              { header: "Details", cell: (b) => b.narration },
              { header: "Amount", cell: (b) => formatAED(b.amountFils), align: "right" },
            ]} />
        </Card>
      )}
    </>
  );
}
