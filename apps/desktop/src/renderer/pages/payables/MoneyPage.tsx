import { dubaiDate } from "@ffgp/shared";
import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button, Card, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, Table } from "../../components/ui";
import { post } from "../../lib/api";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import type { MoneyAccount } from "../../payables/types";

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);
const today = () => dubaiDate(new Date().toISOString());
const KIND: Record<string, string> = { cash: "Cash", bank: "Bank", card_clearing: "Card receipts", cheques_in_hand: "Cheques in hand" };

interface InHand { receiptId: string; number: string; customerName: string; amountFils: number; chequeDate: string | null; reference: string | null }
interface Issued { paymentId: string; number: string; supplierName: string; amountFils: number; chequeNo: string | null; chequeDate: string | null; paidAt: string }

/** Bank and cash accounts with their balances; moving money; cheques waiting to be paid in or to clear. */
export function MoneyPage() {
  const navigate = useNavigate();
  const accounts = useApi<{ accounts: MoneyAccount[] }>("/api/money-accounts");
  const inHand = useApi<{ cheques: InHand[] }>("/api/cheques/in-hand");
  const issued = useApi<{ cheques: Issued[] }>("/api/cheques/issued");
  const [transfer, setTransfer] = useState(false);
  // Cheques being paid in, or marked cleared: the day it happened (as on the bank statement) and, to pay in, which bank.
  const [paying, setPaying] = useState<InHand[] | null>(null);
  const [clearing, setClearing] = useState<Issued | null>(null);
  const reload = () => { void accounts.reload(); void inHand.reload(); void issued.reload(); };
  const banks = (accounts.data?.accounts ?? []).filter((a) => a.moneyKind === "bank");

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); toast.success(done); reload(); return true; } catch (err) { toast.error((err as Error).message); return false; }
  };
  const due = (inHand.data?.cheques ?? []).filter((c) => !c.chequeDate || c.chequeDate <= today());

  return (
    <>
      <PageHeader title="Bank & cash" subtitle="Balances from the books"
        actions={<Button icon={<ArrowLeftRight className="size-4" />} onClick={() => setTransfer(true)}>Move money</Button>} />
      <Card padded={false} className="mb-5">
        {!accounts.data ? <Spinner /> : (
          <Table rows={accounts.data.accounts} rowKey={(a) => a.id}
            columns={[
              { header: "Account", cell: (a) => `${a.code} ${a.name}` },
              { header: "Kind", cell: (a) => KIND[a.moneyKind] ?? a.moneyKind },
              { header: "Balance", cell: (a) => formatAED(a.balanceFils), align: "right" },
              { header: "", cell: (a) => (a.moneyKind === "bank" ? <Button size="sm" onClick={() => navigate(`/bank/${a.id}/reconcile`)}>Reconcile</Button> : null) },
            ]} />
        )}
      </Card>
      <div className="grid grid-cols-2 gap-5 max-lg:grid-cols-1">
        <Card title="Customer cheques to pay in" padded={false}
          actions={due.length > 1 && <Button size="sm" onClick={() => setPaying(due)}>Pay in all due</Button>}>
          <Table rows={inHand.data?.cheques ?? []} rowKey={(c) => c.receiptId} empty={<div className="px-4 py-3 text-sm text-zinc-600">None waiting</div>}
            columns={[
              { header: "Receipt", cell: (c) => <span className="font-mono text-[13px]">{c.number}</span> },
              { header: "From", cell: (c) => c.customerName },
              { header: "Dated", cell: (c) => (c.chequeDate ? <span className={c.chequeDate > today() ? "text-amber-700" : ""}>{day(c.chequeDate)}</span> : "—") },
              { header: "Amount", cell: (c) => formatAED(c.amountFils), align: "right" },
              { header: "", cell: (c) => (!c.chequeDate || c.chequeDate <= today() ? <Button size="sm" variant="ghost" onClick={() => setPaying([c])}>Pay in</Button> : null) },
            ]} />
        </Card>
        <Card title="Our cheques not yet cleared" padded={false}>
          <Table rows={issued.data?.cheques ?? []} rowKey={(c) => c.paymentId} empty={<div className="px-4 py-3 text-sm text-zinc-600">None waiting</div>}
            columns={[
              { header: "Payment", cell: (c) => <span className="font-mono text-[13px]">{c.number}</span> },
              { header: "To", cell: (c) => c.supplierName },
              { header: "Cheque", cell: (c) => `${c.chequeNo ?? ""}${c.chequeDate ? ` · ${day(c.chequeDate)}` : ""}` },
              { header: "Amount", cell: (c) => formatAED(c.amountFils), align: "right" },
              { header: "", cell: (c) => <Button size="sm" variant="ghost" onClick={() => setClearing(c)}>Cleared</Button> },
            ]} />
        </Card>
      </div>
      <PayInModal cheques={paying} banks={banks} onClose={() => setPaying(null)}
        onSubmit={(bankAccountId, date) => run(() => post("/api/cheques/deposits", { receiptIds: paying!.map((c) => c.receiptId), bankAccountId, date }), "Paid in")} />
      <ClearModal cheque={clearing} onClose={() => setClearing(null)}
        onSubmit={(date) => run(() => post("/api/cheques/clearances", { paymentIds: [clearing!.paymentId], date }), "Marked cleared")} />
      <TransferModal open={transfer} accounts={accounts.data?.accounts ?? []} onClose={() => setTransfer(false)} onDone={reload} />
    </>
  );
}

function TransferModal({ open, accounts, onClose, onDone }: { open: boolean; accounts: MoneyAccount[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ from: "", to: "", amount: 0, date: today(), reference: "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post("/api/transfers", { date: v.date, fromAccountId: v.from, toAccountId: v.to, amountFils: v.amount, reference: v.reference || null });
      toast.success("Money moved");
      onDone();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const options = accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>);
  return (
    <Modal open={open} onClose={onClose} title="Move money"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!v.from || !v.to || v.from === v.to || v.amount <= 0} onClick={() => void save()}>Move {formatAED(v.amount)}</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="From"><Select value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} aria-label="From"><option value="">Choose…</option>{options}</Select></Field>
        <Field label="To"><Select value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} aria-label="To"><option value="">Choose…</option>{options}</Select></Field>
        <Field label="Amount (AED)"><MoneyInput fils={v.amount} onChange={(amount) => setV({ ...v, amount })} aria-label="Amount" /></Field>
        <Field label="Date"><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} aria-label="Date" /></Field>
        <Field label="Reference" className="col-span-2"><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} aria-label="Reference" /></Field>
      </div>
    </Modal>
  );
}

/** Paying in customer cheques: one slip, one bank line. The date is the day on the bank's statement. */
function PayInModal({ cheques, banks, onClose, onSubmit }: { cheques: InHand[] | null; banks: MoneyAccount[]; onClose: () => void; onSubmit: (bankAccountId: string, date: string) => Promise<boolean> }) {
  const [bank, setBank] = useState("");
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const bankId = bank || banks[0]?.id || "";
  const total = (cheques ?? []).reduce((s, c) => s + c.amountFils, 0);
  const latest = (cheques ?? []).reduce((m, c) => (c.chequeDate && c.chequeDate > m ? c.chequeDate : m), "");
  const submit = async () => {
    setBusy(true);
    try { if (await onSubmit(bankId, date)) onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!cheques} title={`Pay in ${cheques?.length === 1 ? "a cheque" : `${cheques?.length ?? 0} cheques`}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Not now</Button><Button variant="primary" busy={busy} disabled={!bankId || !date} onClick={() => void submit()}>Pay in {formatAED(total)}</Button></>}>
      {!banks.length ? <p className="text-sm text-red-700">Add a bank account first (Books, Chart of accounts).</p> : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank account"><Select value={bankId} onChange={(e) => setBank(e.target.value)} aria-label="Bank account">{banks.map((b) => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</Select></Field>
          <Field label="Date paid in" hint={latest ? `Not before ${day(latest)}` : undefined}><Input type="date" value={date} min={latest || undefined} max={today()} onChange={(e) => setDate(e.target.value)} aria-label="Date paid in" /></Field>
        </div>
      )}
    </Modal>
  );
}

/** Our cheque cleared: the bank balance moves on the day the bank shows it. */
function ClearModal({ cheque, onClose, onSubmit }: { cheque: Issued | null; onClose: () => void; onSubmit: (date: string) => Promise<boolean> }) {
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { if (await onSubmit(date)) onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!cheque} title={`Cheque ${cheque?.chequeNo ?? cheque?.number ?? ""} cleared`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Not now</Button><Button variant="primary" busy={busy} disabled={!date} onClick={() => void submit()}>Mark cleared</Button></>}>
      <p className="mb-3 text-sm text-zinc-700">{cheque?.supplierName} · {cheque ? formatAED(cheque.amountFils) : ""}</p>
      <Field label="Date cleared" hint="As on the bank statement"><Input type="date" value={date} min={cheque?.paidAt} max={today()} onChange={(e) => setDate(e.target.value)} aria-label="Date cleared" /></Field>
    </Modal>
  );
}

