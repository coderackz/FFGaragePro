import { dubaiDate } from "@ffgp/shared";
import { ArrowLeft, Banknote, Pencil, Plus, Sheet } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { exportXlsx } from "../../books/export";
import { SupplierFormModal } from "../../components/inventoryForms";
import { Button, Card, Empty, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, Table } from "../../components/ui";
import { get, post } from "../../lib/api";
import { formatAED, formatDate } from "../../lib/format";
import type { Supplier } from "../../lib/types";
import { useApi } from "../../lib/useApi";
import { METHOD_LABELS, type MoneyAccount, type OpenItem, type SupplierPayment } from "../../payables/types";
import { BillEditor } from "./BillsPage";

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);
const today = () => dubaiDate(new Date().toISOString());

/** One supplier's money: what we owe and what's due, bills and parts received, payments, statement, and Pay. */
export function SupplierPage() {
  const { id } = useParams();
  const supplier = useApi<{ supplier: Supplier }>(`/api/suppliers/${id}`);
  const items = useApi<{ items: OpenItem[] }>(`/api/suppliers/${id}/open-items`);
  const payments = useApi<{ payments: SupplierPayment[] }>(`/api/supplier-payments?supplierId=${id}`);
  const [paying, setPaying] = useState(false);
  const [billing, setBilling] = useState(false);
  const [editing, setEditing] = useState(false);
  const reload = () => { void supplier.reload(); void items.reload(); void payments.reload(); };
  if (!supplier.data) return <Spinner />;
  const s = supplier.data.supplier;
  const balance = s.balanceFils ?? 0;

  const statement = async () => {
    try {
      const from = `${today().slice(0, 4)}-01-01`;
      const res = await fetchStatement(s.id, from, today());
      await exportXlsx(`Statement ${s.name} ${from} to ${today()}`, {
        title: `Statement: ${s.name}`, subtitle: `${day(from)} to ${day(today())}`,
        columns: [{ header: "Date", key: "date", width: 12 }, { header: "Details", key: "description", width: 40 }, { header: "Number", key: "number", width: 16 },
          { header: "Paid", key: "debitFils", money: true }, { header: "Billed", key: "creditFils", money: true }, { header: "Owed", key: "balanceFils", money: true }],
        rows: [{ description: "Opening balance", balanceFils: res.openingFils }, ...res.rows.map((r) => ({ ...r, debitFils: r.debitFils || null, creditFils: r.creditFils || null })),
          { description: "Closing balance", balanceFils: res.closingFils }],
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/suppliers" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Suppliers</Link>}
        title={s.name}
        subtitle={`Pays in ${s.termsDays ?? 30} days${s.trn ? ` · TRN ${s.trn}` : ""}`}
        actions={<>
          <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
          <Button icon={<Sheet className="size-4" />} onClick={() => void statement()}>Statement</Button>
          <Button icon={<Plus className="size-4" />} onClick={() => setBilling(true)}>New bill</Button>
          <Button variant="primary" icon={<Banknote className="size-4" />} onClick={() => setPaying(true)}>Pay supplier</Button>
        </>}
      />
      <div className="mb-5 grid grid-cols-3 gap-4 max-md:grid-cols-1">
        <Card><div className="text-sm text-zinc-600">{balance < 0 ? "Advance paid" : "We owe"}</div><div className="text-xl font-semibold tabular" data-testid="supplier-balance">{formatAED(Math.abs(balance))}</div></Card>
        <Card><div className="text-sm text-zinc-600">Overdue</div><div className="text-xl font-semibold tabular">{formatAED(s.overdueFils ?? 0)}</div></Card>
        <Card><div className="text-sm text-zinc-600">Advance to use</div><div className="text-xl font-semibold tabular">{formatAED(s.advanceFils ?? 0)}</div></Card>
      </div>
      <Card title="Still owed" className="mb-5" padded={false}>
        <Table rows={items.data?.items ?? []} rowKey={(i) => `${i.target}:${i.id}`} empty={<div className="px-4 py-3 text-sm text-zinc-600">Nothing owed</div>}
          columns={[
            { header: "Their invoice", cell: (i) => <span className="font-mono text-[13px]">{i.number}</span> },
            { header: "Kind", cell: (i) => (i.target === "bill" ? "Bill" : "Parts received") },
            { header: "Date", cell: (i) => day(i.date) },
            { header: "Due", cell: (i) => <span className={i.dueDate < today() ? "text-red-700" : ""}>{day(i.dueDate)}</span> },
            { header: "Owed", cell: (i) => formatAED(i.owedFils), align: "right" },
          ]} />
      </Card>
      <Card title="Payments" padded={false}>
        <Table rows={payments.data?.payments ?? []} rowKey={(p) => p.id} empty={<div className="px-4 py-3 text-sm text-zinc-600">No payments yet</div>}
          columns={[
            { header: "Number", cell: (p) => <span className="font-mono text-[13px]">{p.number}</span> },
            { header: "Date", cell: (p) => day(p.paidAt) },
            { header: "How", cell: (p) => `${METHOD_LABELS[p.method] ?? p.method}${p.chequeNo ? ` ${p.chequeNo}${p.clearedAt ? " (cleared)" : ""}` : ""}${p.reference ? ` · ${p.reference}` : ""}` },
            { header: "Advance left", cell: (p) => (p.unallocatedFils ? formatAED(p.unallocatedFils) : ""), align: "right" },
            { header: "Amount", cell: (p) => formatAED(p.amountFils), align: "right" },
          ]} />
      </Card>
      <PaySupplierDialog open={paying} supplier={s} owedFils={Math.max(balance, 0)} onClose={() => setPaying(false)} onDone={reload} />
      <BillEditor open={billing} supplierId={s.id} onClose={() => setBilling(false)} onSaved={reload} />
      <SupplierFormModal open={editing} supplier={s} onClose={() => setEditing(false)} onSaved={reload} />
    </>
  );
}

async function fetchStatement(id: string, from: string, to: string) {
  const { statement } = await get<{ statement: { openingFils: number; closingFils: number; rows: { date: string; description: string; number: string; debitFils: number; creditFils: number; balanceFils: number }[] } }>(
    `/api/suppliers/${id}/statement?from=${from}&to=${to}`);
  return statement;
}

/** Pay a supplier: split across what's owed, oldest due first; anything over is kept as an advance. */
export function PaySupplierDialog({ open, supplier, owedFils, onClose, onDone }: { open: boolean; supplier: Supplier; owedFils: number; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<{ accounts: MoneyAccount[] }>(open ? "/api/money-accounts" : null);
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState("bank_transfer");
  const [from, setFrom] = useState("");
  const [reference, setReference] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  const [chequeDate, setChequeDate] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setAmount(owedFils); setReference(""); setChequeNo(""); setChequeDate(""); setPaidAt(today()); } }, [open, owedFils]);
  const usable = (accounts.data?.accounts ?? []).filter((a) => (method === "cash" ? a.moneyKind === "cash" : method === "card" ? a.moneyKind !== "cheques_in_hand" : a.moneyKind === "bank"));
  useEffect(() => { if (usable.length && !usable.some((a) => a.id === from)) setFrom(usable[0]!.id); }, [usable, from]);

  const pay = async () => {
    setBusy(true);
    try {
      const { payment } = await post<{ payment: SupplierPayment }>("/api/supplier-payments", {
        supplierId: supplier.id, amountFils: amount, method, paidFromAccountId: from, reference: reference || null, paidAt,
        chequeNo: method === "cheque" ? chequeNo || null : null, chequeDate: method === "cheque" && chequeDate ? chequeDate : null,
      });
      toast.success(`${payment.number} saved${payment.unallocatedFils ? `: ${formatAED(payment.unallocatedFils)} kept as an advance` : ""}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Pay ${supplier.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={amount <= 0 || !from} onClick={() => void pay()}>Pay {formatAED(amount)}</Button></>}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount (AED)" hint={owedFils ? `Owed: ${formatAED(owedFils)}` : "Nothing owed: this is an advance"}><MoneyInput fils={amount} onChange={setAmount} aria-label="Amount" /></Field>
        <Field label="Date"><Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} aria-label="Date" /></Field>
        <Field label="How">
          <Select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="How">
            {Object.entries(METHOD_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Paid from">
          <Select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Paid from">
            {usable.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </Select>
        </Field>
        {method === "cheque" && (
          <>
            <Field label="Cheque number"><Input value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} aria-label="Cheque number" /></Field>
            <Field label="Cheque date"><Input type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} aria-label="Cheque date" /></Field>
          </>
        )}
        <Field label="Reference" className="col-span-2"><Input value={reference} onChange={(e) => setReference(e.target.value)} aria-label="Reference" /></Field>
      </div>
      {!usable.length && accounts.data && <Empty title="No account to pay from">Add a bank or cash account in Books → Chart of accounts.</Empty>}
    </Modal>
  );
}
