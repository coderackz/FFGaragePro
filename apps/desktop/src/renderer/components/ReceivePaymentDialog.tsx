import { allocateOldestFirst, DEFAULT_SETTINGS, PAYMENT_METHODS } from "@ffgp/shared";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { get, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatAED, formatDate, PAYMENT_LABELS } from "../lib/format";
import type { Customer, DocumentSummary, Receipt } from "../lib/types";
import { printReceipt } from "../print/print";
import { afterAction, receiptRequest } from "../messages/triggers";
import { Button, Field, Input, Modal, MoneyInput, Select, Spinner } from "./ui";

type Mode = "receive" | "allocate" | "refund";
interface Open { id: string; number: string; dueDate: string; issuedAt: string; owedFils: number }

/** A customer's issued invoices that still owe something, oldest due first. */
async function openInvoices(customerId: string): Promise<Open[]> {
  const { documents } = await get<{ documents: DocumentSummary[] }>(`/api/documents?type=invoice&customerId=${customerId}`);
  return documents
    .filter((d) => (d.status === "issued" || d.status === "part_paid") && d.balanceFils > 0)
    .map((d) => ({ id: d.id, number: d.number, dueDate: d.dueDate ?? (d.issuedAt ?? d.createdAt).slice(0, 10), issuedAt: d.issuedAt ?? d.createdAt, owedFils: d.balanceFils }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.issuedAt.localeCompare(b.issuedAt));
}

/**
 * Customer page money actions. receive: a payment split across invoices (oldest due first, editable); what isn't
 * put against an invoice is kept as credit. allocate: put existing credit against invoices. refund: pay credit out.
 */
export function ReceivePaymentDialog({ customer, mode, onClose, onDone }: {
  customer: Customer; mode: Mode | null; onClose: () => void; onDone: () => void;
}) {
  const { garage, settings } = useAuth();
  const [invoices, setInvoices] = useState<Open[] | null>(null);
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<string>("bank_transfer");
  const [reference, setReference] = useState("");
  const [chequeDate, setChequeDate] = useState("");
  const [split, setSplit] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const credit = customer.creditFils ?? 0;

  useEffect(() => {
    if (!mode) return;
    setInvoices(null);
    setReference("");
    setChequeDate("");
    setMethod(mode === "refund" ? "cash" : "bank_transfer");
    void openInvoices(customer.id).then((invoicesOnly) => {
      const openingDue = customer.openingDueFils ?? 0;
      const list = mode === "receive" && openingDue > 0
        ? [{ id: OPENING_ROW, number: "Opening balance", dueDate: customer.openingBalanceDate ?? "0000-00-00", issuedAt: "", owedFils: openingDue }, ...invoicesOnly]
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        : invoicesOnly;
      setInvoices(list);
      const start = mode === "receive" ? list.reduce((s, i) => s + i.owedFils, 0) : mode === "allocate" ? Math.min(credit, list.reduce((s, i) => s + i.owedFils, 0)) : credit;
      setAmount(start);
      setSplit(oldestFirst(start, list));
    });
  }, [mode, customer.id, credit]);

  const allocated = useMemo(() => Object.values(split).reduce((s, v) => s + v, 0), [split]);
  const kept = amount - allocated;
  const tooMuch = invoices?.some((i) => (split[i.id] ?? 0) > i.owedFils) || kept < 0;

  const submit = async () => {
    setBusy(true);
    try {
      const allocations = Object.entries(split).filter(([id, v]) => v > 0 && id !== OPENING_ROW).map(([documentId, amountFils]) => ({ documentId, amountFils }));
      if (mode === "receive") {
        const { receipt } = await post<{ receipt: Receipt }>("/api/receipts", {
          customerId: customer.id, amountFils: amount, method, reference, chequeDate: method === "cheque" && chequeDate ? chequeDate : null, allocations,
        });
        toast.success(`${receipt.number} saved`, { action: { label: "Print", onClick: () => void printReceipt(receipt, garage!, settings ?? DEFAULT_SETTINGS, "print") } });
        void afterAction(receiptRequest(receipt, garage!, settings ?? DEFAULT_SETTINGS), settings ?? DEFAULT_SETTINGS);
      } else if (mode === "refund") {
        const { receipt } = await post<{ receipt: Receipt }>("/api/receipts", { customerId: customer.id, amountFils: -amount, method, reference });
        toast.success(`Refund ${receipt.number} saved`, { action: { label: "Print", onClick: () => void printReceipt(receipt, garage!, settings ?? DEFAULT_SETTINGS, "print") } });
      } else {
        await allocateCredit(customer.id, allocations);
        toast.success("Credit put against invoices");
      }
      onDone();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "receive" ? "Receive payment" : mode === "allocate" ? "Use credit" : "Refund credit";
  const action = mode === "receive" ? `Save ${formatAED(amount)}` : mode === "allocate" ? `Use ${formatAED(allocated)}` : `Refund ${formatAED(amount)}`;
  const disabled = !invoices || amount <= 0 || !!tooMuch || (mode !== "receive" && amount > credit) || (mode === "allocate" && allocated <= 0);
  return (
    <Modal open={mode !== null} onClose={onClose} title={`${title} — ${customer.name}`} width="max-w-2xl"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={disabled} onClick={() => void submit()}>{action}</Button></>}>
      {!invoices ? <Spinner /> : (
        <div className="space-y-4">
          {mode !== "receive" && <div className="rounded-md bg-zinc-50 px-3 py-2 text-sm">Credit available: <b className="tabular">{formatAED(credit)}</b></div>}
          {mode !== "allocate" && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Amount (AED)">
                <MoneyInput fils={amount} onChange={(v) => { setAmount(v); if (mode === "receive") setSplit(oldestFirst(v, invoices)); }} autoFocus aria-label="Amount" />
              </Field>
              <Field label="Method">
                <Select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>)}
                </Select>
              </Field>
              <Field label="Reference" hint="Transfer, card slip or cheque number">
                <Input value={reference} onChange={(e) => setReference(e.target.value)} aria-label="Reference" />
              </Field>
              {method === "cheque" && mode === "receive" && (
                <Field label="Cheque date"><Input type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} aria-label="Cheque date" /></Field>
              )}
            </div>
          )}
          {mode !== "refund" && (
            invoices.length === 0 ? <div className="text-sm text-zinc-600">No unpaid invoices{mode === "receive" ? " — the whole amount is kept as credit." : "."}</div> : (
              <table className="w-full text-sm" data-testid="allocations">
                <thead><tr className="text-left text-xs text-zinc-600"><th className="py-1">Invoice</th><th>Due</th><th className="text-right">Owes</th><th className="w-36 text-right">Pay</th></tr></thead>
                <tbody className="divide-y divide-zinc-100">
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td className={i.id === OPENING_ROW ? "py-1.5" : "py-1.5 font-mono"}>{i.number}</td>
                      <td className="text-zinc-600">{i.dueDate === "0000-00-00" ? "—" : formatDate(`${i.dueDate}T00:00:00.000Z`)}</td>
                      <td className="tabular text-right">{formatAED(i.owedFils)}</td>
                      <td className="pl-3"><MoneyInput fils={split[i.id] ?? 0} onChange={(v) => setSplit({ ...split, [i.id]: v })} aria-label={`Pay ${i.number}`} className="h-8" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
          {mode === "receive" && kept > 0 && <div className="text-sm text-zinc-700">Kept as credit: <b className="tabular">{formatAED(kept)}</b></div>}
          {tooMuch && <div className="text-sm text-red-700">That's more than an invoice owes, or more than the payment.</div>}
          {mode !== "receive" && amount > credit && <div className="text-sm text-red-700">That's more than the customer's credit.</div>}
        </div>
      )}
    </Modal>
  );
}

const oldestFirst = (amount: number, list: Open[]) =>
  Object.fromEntries(allocateOldestFirst(amount, list.map((i) => ({ id: i.id, dueDate: i.dueDate, issuedAt: i.issuedAt, owedFils: i.owedFils }))).map((a) => [a.documentId, a.amountFils]));

/** An opening balance still owed is the oldest debt: shown as a row; what goes to it isn't put against an invoice. */
export const OPENING_ROW = "opening-balance";

/** Puts a customer's credit against invoices, taking it from their oldest receipts with something left. */
async function allocateCredit(customerId: string, wanted: { documentId: string; amountFils: number }[]): Promise<void> {
  const { receipts } = await get<{ receipts: Receipt[] }>(`/api/receipts?customerId=${customerId}`);
  const withCredit = receipts.filter((r) => r.unallocatedFils > 0).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const queue = wanted.map((w) => ({ ...w }));
  for (const r of withCredit) {
    let left = r.unallocatedFils;
    const batch: { documentId: string; amountFils: number }[] = [];
    for (const w of queue) {
      if (left <= 0 || w.amountFils <= 0) continue;
      const take = Math.min(left, w.amountFils);
      batch.push({ documentId: w.documentId, amountFils: take });
      w.amountFils -= take;
      left -= take;
    }
    if (batch.length) await post(`/api/receipts/${r.id}/allocations`, { allocations: batch });
  }
}
