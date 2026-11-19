import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button, Card, Field, Input, Select } from "../../../components/ui";
import type { Account } from "../../../books/types";
import { post } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { useApi } from "../../../lib/useApi";
import { SectionShell } from "../SectionShell";
import { useSectionForm } from "../useSectionForm";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const METHODS = [["cash", "Cash"], ["card", "Card"], ["bank_transfer", "Bank transfer"], ["cheque", "Cheque"]] as const;

/** Settings → Books: when the books start, the fiscal year, the lock date, where payments are banked, and year end. */
export function BooksSection() {
  const form = useSectionForm("books");
  const b = form.value;
  const { refreshGarage } = useAuth();
  const accounts = useApi<{ accounts: Account[] }>("/api/books/accounts");
  const [yearEnd, setYearEnd] = useState("");
  const [closing, setClosing] = useState(false);
  const assets = accounts.data?.accounts.filter((a) => a.type === "asset" && a.active) ?? [];

  const closeYear = async () => {
    if (!window.confirm(`Close the year ending ${formatDate(`${yearEnd}T00:00:00.000Z`)}? Its profit moves to retained earnings and the books lock up to that day.`)) return;
    setClosing(true);
    try {
      const { entry } = await post<{ entry: { number: string } | null }>("/api/books/year-end", { yearEnd });
      toast.success(entry ? `Year closed (${entry.number})` : "Year closed: nothing to move, the books are locked");
      await refreshGarage();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setClosing(false);
    }
  };

  return (
    <SectionShell title="Books" subtitle="Accounting: when the books start, locking finished months, and year end" dirty={form.dirty} busy={form.busy} onSave={() => void form.save()}>
      <Card title="Start">
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <Field label="Books start date" hint="Everything from this day posts to the books by itself. It can't change once anything is posted.">
            <Input type="date" value={b.startDate ?? ""} onChange={(e) => form.set({ startDate: e.target.value || null })} aria-label="Books start date" />
          </Field>
          <Field label="Fiscal year starts in">
            <Select value={b.fiscalYearStartMonth} onChange={(e) => form.set({ fiscalYearStartMonth: Number(e.target.value) })} aria-label="Fiscal year starts in">
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </Select>
          </Field>
        </div>
        {b.startDate && <p className="mt-3 text-sm text-zinc-600">Next: enter the <Link to="/books/opening" className="font-medium text-brand-700 underline">opening balances</Link> as at the day before.</p>}
      </Card>
      <Card title="Lock">
        <Field label="Books locked up to" hint="Nothing can be posted on or before this date (usually a finished month or VAT period). Late items post on the next open day." className="max-w-xs">
          <Input type="date" value={b.lockDate ?? ""} onChange={(e) => form.set({ lockDate: e.target.value || null })} aria-label="Books locked up to" />
        </Field>
      </Card>
      <Card title="Where payments go">
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          {METHODS.map(([key, label]) => (
            <Field key={key} label={label}>
              <Select value={b.methodAccounts[key]} onChange={(e) => form.set({ methodAccounts: { ...b.methodAccounts, [key]: e.target.value } })} aria-label={`${label} goes to`}>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              </Select>
            </Field>
          ))}
        </div>
      </Card>
      <Card title="Year end">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Last day of the year"><Input type="date" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} aria-label="Last day of the year" /></Field>
          <Button busy={closing} disabled={!yearEnd || form.dirty} onClick={() => void closeYear()}>Close the year</Button>
        </div>
        <p className="mt-2 text-sm text-zinc-600">Moves the year's profit to retained earnings and locks the books up to that day.</p>
      </Card>
    </SectionShell>
  );
}
