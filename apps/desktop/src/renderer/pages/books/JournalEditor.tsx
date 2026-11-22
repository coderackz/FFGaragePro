import { dubaiDate, VAT_TAG_INFO, VAT_TAGS, type VatTag } from "@ffgp/shared";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button, Card, Field, Input, PageHeader, Select, Spinner } from "../../components/ui";
import { money, toFils, type Account, type Draft, type DraftLine, type Entry } from "../../books/types";
import { del, get, patch, post } from "../../lib/api";
import type { Customer } from "../../lib/types";
import { useApi } from "../../lib/useApi";
import { BackToBooks } from "./ReportPage";
import { ALL } from "../../components/ShowMore";

interface EditLine { accountId: string; debit: string; credit: string; customerId: string; documentId: string | null; memo: string; vatBox: VatTag | "" }
const blank = (): EditLine => ({ accountId: "", debit: "", credit: "", customerId: "", documentId: null, memo: "", vatBox: "" });
/** A new journal can arrive filled in (the VAT return's "Record the payment"). */
export interface JournalPrefill { date?: string; narration: string; lines: DraftLine[] }
const fromDraft = (l: DraftLine): EditLine => ({
  accountId: l.accountId, debit: l.debitFils ? (l.debitFils / 100).toFixed(2) : "", credit: l.creditFils ? (l.creditFils / 100).toFixed(2) : "",
  customerId: l.customerId ?? "", documentId: l.documentId ?? null, memo: l.memo ?? "", vatBox: l.vatBox ?? "",
});
const toDraft = (l: EditLine): DraftLine => ({
  accountId: l.accountId, debitFils: toFils(l.debit), creditFils: toFils(l.credit), customerId: l.customerId || null, documentId: l.documentId, memo: l.memo || null, vatBox: l.vatBox || null,
});

/**
 * A journal (or the opening balances) being written: date, narration and lines. Totals and the difference show as you
 * type; Save keeps a draft; Post checks it and posts it.
 */
export function JournalEditor({ opening = false }: { opening?: boolean }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const prefill = (useLocation().state as { prefill?: JournalPrefill } | null)?.prefill;
  const accounts = useApi<{ accounts: Account[] }>("/api/books/accounts");
  const customers = useApi<{ customers: Customer[] }>(`/api/customers?limit=${ALL}`);
  const [draftId, setDraftId] = useState<string | null>(id ?? null);
  const [kind, setKind] = useState<"manual" | "opening">(opening ? "opening" : "manual");
  const [date, setDate] = useState(prefill?.date ?? dubaiDate(new Date().toISOString()));
  const [narration, setNarration] = useState(opening ? "Opening balances" : prefill?.narration ?? "");
  const [lines, setLines] = useState<EditLine[]>(prefill ? prefill.lines.map(fromDraft) : [blank(), blank()]);
  const [loaded, setLoaded] = useState(!id && !opening);
  const [busy, setBusy] = useState<"save" | "post" | null>(null);

  useEffect(() => {
    if (id) {
      void get<{ drafts: Draft[] }>("/api/books/drafts").then(({ drafts }) => {
        const d = drafts.find((x) => x.id === id);
        if (!d) return toast.error("Draft not found");
        setKind(d.kind); setDate(d.date); setNarration(d.narration); setLines(d.lines.length ? d.lines.map(fromDraft) : [blank(), blank()]); setLoaded(true);
      });
    } else if (opening) {
      void get<{ date: string; lines: DraftLine[] }>("/api/books/opening/proposal").then(
        (p) => { setDate(p.date); setLines([...p.lines.map(fromDraft), blank()]); setLoaded(true); },
        (err: Error) => { toast.error(err.message); setLoaded(true); },
      );
    }
  }, [id, opening]);

  const debits = lines.reduce((s, l) => s + toFils(l.debit), 0);
  const credits = lines.reduce((s, l) => s + toFils(l.credit), 0);
  const diff = debits - credits;
  const set = (i: number, p: Partial<EditLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const receivables = accounts.data?.accounts.find((a) => a.systemKey === "receivables")?.id;

  const save = async (): Promise<string> => {
    const body = { kind, date, narration, lines: lines.filter((l) => l.accountId).map(toDraft) };
    if (draftId) {
      await patch(`/api/books/drafts/${draftId}`, body);
      return draftId;
    }
    const { draft } = await post<{ draft: Draft }>("/api/books/drafts", body);
    setDraftId(draft.id);
    return draft.id;
  };
  const run = async (name: "save" | "post", fn: () => Promise<void>) => {
    setBusy(name);
    try { await fn(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(null); }
  };
  const onSave = () => run("save", async () => { await save(); toast.success("Draft saved"); });
  const onPost = () => run("post", async () => {
    const d = await save();
    const { entry } = await post<{ entry: Entry }>(`/api/books/drafts/${d}/post`, {});
    toast.success(`${entry.number} posted`);
    navigate(`/books/journals/${entry.id}`, { replace: true });
  });
  const onDelete = () => run("save", async () => {
    if (draftId && window.confirm("Delete this draft?")) { await del(`/api/books/drafts/${draftId}`); navigate("/books/journals"); }
  });

  if (!loaded || !accounts.data) return <Spinner />;
  const active = accounts.data.accounts.filter((a) => a.active);
  return (
    <>
      <PageHeader back={<BackToBooks />} title={kind === "opening" ? "Opening balances" : draftId ? "Draft journal" : "New journal"}
        subtitle={kind === "opening" ? "The day before the books start. Filled from what the app knows; add the rest. Any difference goes to Opening balance equity." : undefined}
        actions={<>
          {draftId && <Button variant="ghost" onClick={() => void onDelete()}>Delete draft</Button>}
          <Button busy={busy === "save"} onClick={() => void onSave()}>Save draft</Button>
          <Button variant="primary" busy={busy === "post"} onClick={() => void onPost()}>Post</Button>
        </>} />
      <Card>
        <div className="mb-4 grid grid-cols-[180px_1fr] gap-4">
          <Field label="Date"><Input type="date" value={date} disabled={kind === "opening"} onChange={(e) => setDate(e.target.value)} aria-label="Date" /></Field>
          <Field label="Narration"><Input value={narration} onChange={(e) => setNarration(e.target.value)} aria-label="Narration" placeholder="What it's for, e.g. Rent for November" /></Field>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-zinc-500"><th className="pb-1">Account</th><th className="pb-1">Customer</th><th className="pb-1">Memo</th>{kind === "manual" && <th className="pb-1">VAT box</th>}<th className="w-32 pb-1 text-right">Debit</th><th className="w-32 pb-1 text-right">Credit</th><th className="w-8" /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <Select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={`Account, line ${i + 1}`}>
                    <option value="">Choose…</option>
                    {active.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                  </Select>
                </td>
                <td className="py-1 pr-2">
                  {l.accountId === receivables ? (
                    <Select value={l.customerId} onChange={(e) => set(i, { customerId: e.target.value })} aria-label={`Customer, line ${i + 1}`}>
                      <option value="">—</option>
                      {customers.data?.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                  ) : <span className="text-zinc-400">—</span>}
                </td>
                <td className="py-1 pr-2"><Input value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} aria-label={`Memo, line ${i + 1}`} /></td>
                {kind === "manual" && (
                  <td className="py-1 pr-2">
                    <Select value={l.vatBox} onChange={(e) => set(i, { vatBox: e.target.value as VatTag | "" })} aria-label={`VAT box, line ${i + 1}`} className="max-w-44">
                      <option value="">—</option>
                      {VAT_TAGS.map((t) => <option key={t} value={t}>{VAT_TAG_INFO[t].label}</option>)}
                    </Select>
                  </td>
                )}
                <td className="py-1 pr-2"><Input inputMode="decimal" className="text-right" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} aria-label={`Debit, line ${i + 1}`} /></td>
                <td className="py-1 pr-2"><Input inputMode="decimal" className="text-right" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} aria-label={`Credit, line ${i + 1}`} /></td>
                <td className="py-1">{lines.length > 2 && <button type="button" className="text-zinc-400 hover:text-red-700" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-200 font-medium">
              <td className="pt-2"><Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setLines((ls) => [...ls, blank()])}>Add line</Button></td>
              <td colSpan={kind === "manual" ? 3 : 2} className={`pt-2 text-right ${diff && kind === "manual" ? "text-red-700" : "text-zinc-500"}`} data-testid="difference">
                {diff ? `${kind === "opening" ? "To Opening balance equity" : "Difference"}: ${money(Math.abs(diff))}` : "Balanced"}
              </td>
              <td className="pt-2 pr-2 text-right tabular">{money(debits)}</td>
              <td className="pt-2 pr-2 text-right tabular">{money(credits)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </Card>
    </>
  );
}
