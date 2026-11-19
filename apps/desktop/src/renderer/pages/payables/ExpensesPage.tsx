import { dubaiDate, lineVat, type BillVat } from "@ffgp/shared";
import { Image, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Table } from "../../components/ui";
import { toFils, type Account } from "../../books/types";
import { get, post } from "../../lib/api";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import type { Expense, MoneyAccount } from "../../payables/types";
import { billAccounts } from "./BillsPage";

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);

const readPhoto = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the photo"));
    r.readAsDataURL(file);
  });

/** Expenses paid there and then (fuel, petty cash), each with an optional photo of the receipt. */
export function ExpensesPage() {
  const { data, reload } = useApi<{ expenses: Expense[] }>("/api/expenses");
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const showPhoto = async (id: string) => {
    try { setPhoto((await get<{ photo: string | null }>(`/api/expenses/${id}/photo`)).photo); } catch (err) { toast.error((err as Error).message); }
  };
  return (
    <>
      <PageHeader title="Expenses" subtitle="Paid on the spot: fuel, petty cash, small purchases"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New expense</Button>} />
      <Card padded={false}>
        {!data ? <Spinner /> : (
          <Table rows={data.expenses} rowKey={(e) => e.id} empty={<Empty title="No expenses yet" />}
            columns={[
              { header: "Number", cell: (e) => <span className="font-mono text-[13px]">{e.number}</span> },
              { header: "Date", cell: (e) => day(e.date) },
              { header: "For", cell: (e) => `${e.description}${e.payee ? ` · ${e.payee}` : ""}` },
              { header: "Account", cell: (e) => e.accountName },
              { header: "Paid from", cell: (e) => e.paidFromName },
              { header: "", cell: (e) => (e.hasPhoto ? <button type="button" aria-label={`Receipt photo for ${e.number}`} onClick={() => void showPhoto(e.id)}><Image className="size-4 text-brand-700" /></button> : null) },
              { header: "Total", cell: (e) => formatAED(e.grossFils).replace("AED ", ""), align: "right" },
            ]} />
        )}
      </Card>
      <ExpenseModal open={open} onClose={() => setOpen(false)} onSaved={() => void reload()} />
      <Modal open={photo !== null} onClose={() => setPhoto(null)} title="Receipt photo" width="max-w-2xl">
        {photo && <img src={photo} alt="Receipt" className="max-h-[70vh] w-full object-contain" />}
      </Modal>
    </>
  );
}

function ExpenseModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const accounts = useApi<{ accounts: Account[] }>(open ? "/api/books/accounts" : null);
  const money = useApi<{ accounts: MoneyAccount[] }>(open ? "/api/money-accounts" : null);
  const blank = { date: dubaiDate(new Date().toISOString()), accountId: "", description: "", net: "", vat: "standard" as BillVat, paidFrom: "", payee: "", photo: null as string | null };
  const [v, setV] = useState(blank);
  const [busy, setBusy] = useState(false);
  const net = toFils(v.net);
  const gross = net + lineVat({ netFils: net, vat: v.vat });
  const save = async () => {
    setBusy(true);
    try {
      await post("/api/expenses", { date: v.date, accountId: v.accountId, description: v.description, netFils: net, vat: v.vat, paidFromAccountId: v.paidFrom, payee: v.payee || null, photo: v.photo });
      toast.success("Expense saved");
      onSaved();
      onClose();
      setV(blank);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New expense"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!v.accountId || !v.paidFrom || net <= 0 || !v.description.trim()} onClick={() => void save()}>Save expense</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Date"><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} aria-label="Date" /></Field>
        <Field label="Account">
          <Select value={v.accountId} onChange={(e) => setV({ ...v, accountId: e.target.value })} aria-label="Account">
            <option value="">Choose…</option>
            {billAccounts(accounts.data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </Select>
        </Field>
        <Field label="Description" className="col-span-2"><Input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} aria-label="Description" /></Field>
        <Field label="Net" hint={`Total ${formatAED(gross)}`}><Input inputMode="decimal" value={v.net} onChange={(e) => setV({ ...v, net: e.target.value })} aria-label="Net" /></Field>
        <Field label="VAT">
          <Select value={v.vat} onChange={(e) => setV({ ...v, vat: e.target.value as BillVat })} aria-label="VAT">
            <option value="standard">5% VAT</option>
            <option value="none">No VAT</option>
          </Select>
        </Field>
        <Field label="Paid from">
          <Select value={v.paidFrom} onChange={(e) => setV({ ...v, paidFrom: e.target.value })} aria-label="Paid from">
            <option value="">Choose…</option>
            {money.data?.accounts.filter((a) => a.moneyKind !== "cheques_in_hand").map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </Select>
        </Field>
        <Field label="Paid to"><Input value={v.payee} onChange={(e) => setV({ ...v, payee: e.target.value })} aria-label="Paid to" placeholder="e.g. ENOC Al Quoz" /></Field>
        <Field label="Receipt photo" className="col-span-2" hint={v.photo ? "Photo added" : "PNG or JPG under 1 MB"}>
          <Input type="file" accept="image/png,image/jpeg" aria-label="Receipt photo"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void readPhoto(f).then((photo) => setV((x) => ({ ...x, photo })), (err: Error) => toast.error(err.message)); }} />
        </Field>
      </div>
    </Modal>
  );
}
