import { addDays, DEFAULT_SETTINGS, dubaiDate } from "@ffgp/shared";
import { Banknote, FileDown, Printer, Undo2, WalletCards } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { get } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatAED, formatDate, PAYMENT_LABELS } from "../lib/format";
import type { Customer, Receipt, Statement } from "../lib/types";
import { useApi } from "../lib/useApi";
import { printReceipt, printStatement } from "../print/print";
import { ReceivePaymentDialog } from "./ReceivePaymentDialog";
import { Badge, Button, Card, Field, Input, Table } from "./ui";

/** The customer page's money: where the account stands, take or use payments, statement, receipts. */
export function AccountCard({ customer, onChanged }: { customer: Customer; onChanged: () => void }) {
  const { can, garage, settings } = useAuth();
  const [mode, setMode] = useState<"receive" | "allocate" | "refund" | null>(null);
  const today = dubaiDate(new Date().toISOString());
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const receipts = useApi<{ receipts: Receipt[] }>(`/api/receipts?customerId=${customer.id}`);
  const balance = customer.balanceFils ?? 0;
  const credit = customer.creditFils ?? 0;
  const terms = customer.creditAllowed ? `${customer.termsDays ?? settings?.credit.defaultTermsDays ?? 30} days` : "Cash (due on the day)";

  const statement = async (mode: "pdf" | "print") => {
    try {
      const s = await get<{ statement: Statement; from: string; to: string }>(`/api/customers/${customer.id}/statement?from=${from}&to=${to}`);
      await printStatement(s.statement, customer, garage!, settings ?? DEFAULT_SETTINGS, { from: s.from, to: s.to }, mode);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const done = () => {
    onChanged();
    void receipts.reload();
  };

  return (
    <>
      <Card title="Account" className="col-span-3"
        actions={can("payments.record") && (
          <div className="flex gap-2">
            {credit > 0 && <Button size="sm" icon={<WalletCards className="size-3.5" />} onClick={() => setMode("allocate")}>Use credit</Button>}
            {credit > 0 && <Button size="sm" icon={<Undo2 className="size-3.5" />} onClick={() => setMode("refund")}>Refund</Button>}
            <Button size="sm" variant="primary" icon={<Banknote className="size-3.5" />} onClick={() => setMode("receive")}>Receive payment</Button>
          </div>
        )}>
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <dl className="grid grid-cols-2 gap-3 text-sm" data-testid="account">
            <div className="rounded-md bg-zinc-50 p-3">
              <dt className="text-zinc-600">{balance < 0 ? "In credit" : "Balance"}</dt>
              <dd className={`tabular text-lg font-semibold ${balance > 0 ? "text-zinc-900" : "text-emerald-700"}`}>{formatAED(Math.abs(balance))}</dd>
              {customer.overLimit && <Badge tone="red">Over the limit</Badge>}
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <dt className="text-zinc-600">Overdue</dt>
              <dd className={`tabular text-lg font-semibold ${(customer.overdueFils ?? 0) > 0 ? "text-red-700" : "text-zinc-900"}`}>{formatAED(customer.overdueFils ?? 0)}</dd>
            </div>
            <div><dt className="text-zinc-600">Terms</dt><dd>{terms}</dd></div>
            <div><dt className="text-zinc-600">Credit limit</dt><dd>{customer.creditLimitFils ? formatAED(customer.creditLimitFils) : "No limit"}</dd></div>
            {credit > 0 && <div className="col-span-2"><dt className="text-zinc-600">Unused payments (credit)</dt><dd className="tabular">{formatAED(credit)}</dd></div>}
          </dl>
          <div>
            <div className="mb-2 text-sm font-medium text-zinc-900">Statement of account</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Statement from" /></Field>
              <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Statement to" /></Field>
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" icon={<Printer className="size-3.5" />} onClick={() => void statement("print")}>Print statement</Button>
              <Button size="sm" icon={<FileDown className="size-3.5" />} onClick={() => void statement("pdf")}>PDF</Button>
              <Button size="sm" variant="ghost" onClick={() => { setFrom(addDays(today, -90)); setTo(today); }}>Last 90 days</Button>
            </div>
          </div>
        </div>
      </Card>
      <Card title="Receipts" className="col-span-3" padded={false}>
        <Table
          rows={receipts.data?.receipts ?? []}
          rowKey={(r) => r.id}
          empty={<div className="px-4 py-3 text-sm text-zinc-600">No payments yet</div>}
          columns={[
            { header: "Number", cell: (r) => <span className="font-mono font-medium">{r.number}</span> },
            { header: "Date", cell: (r) => formatDate(r.receivedAt) },
            { header: "Method", cell: (r) => [PAYMENT_LABELS[r.method] ?? r.method, r.reference].filter(Boolean).join(" · ") },
            { header: "Against", cell: (r) => r.allocations.filter((a) => a.amountFils > 0).map((a) => a.number).join(", ") || (r.amountFils < 0 ? "Refund" : "—") },
            { header: "Amount", cell: (r) => formatAED(r.amountFils), align: "right" },
            { header: "On account", cell: (r) => (r.unallocatedFils ? formatAED(r.unallocatedFils) : ""), align: "right" },
            { header: "", cell: (r) => <Button size="sm" variant="ghost" icon={<Printer className="size-3.5" />} aria-label={`Print ${r.number}`} onClick={() => void printReceipt(r, garage!, settings ?? DEFAULT_SETTINGS, "print")} /> },
          ]}
        />
      </Card>
      <ReceivePaymentDialog customer={customer} mode={mode} onClose={() => setMode(null)} onDone={done} />
    </>
  );
}
