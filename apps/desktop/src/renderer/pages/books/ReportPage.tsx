import { dubaiDate } from "@ffgp/shared";
import { ArrowLeft, FileDown, Sheet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button, Card, Empty, Field, Input, PageHeader, Select, Spinner } from "../../components/ui";
import { exportPdf, exportXlsx, type ExportSheet } from "../../books/export";
import { amount, money, SOURCE_LABELS, type Account } from "../../books/types";
import { useAuth } from "../../lib/auth";
import { formatAED, formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";

export type ReportKind = "trial-balance" | "profit-loss" | "balance-sheet" | "ledger";
const TITLES: Record<ReportKind, string> = { "trial-balance": "Trial balance", "profit-loss": "Profit and loss", "balance-sheet": "Balance sheet", ledger: "General ledger" };

interface Row { accountId: string; code: string; name: string; amountFils: number }
interface Section { from: string; to: string; income: Row[]; costOfSales: Row[]; expenses: Row[]; incomeFils: number; costOfSalesFils: number; grossProfitFils: number; expensesFils: number; netProfitFils: number }

const day = (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`);
const today = () => dubaiDate(new Date().toISOString());

export const BackToBooks = () => (
  <Link to="/books" className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> Books</Link>
);

/** A books report with its dates, drill-down, and Excel and PDF export. */
export function ReportPage({ kind }: { kind: ReportKind }) {
  const { garage } = useAuth();
  const [params, setParams] = useSearchParams();
  const t = today();
  const asOf = params.get("asOf") ?? t;
  const from = params.get("from") ?? `${t.slice(0, 8)}01`;
  const to = params.get("to") ?? t;
  const accountId = params.get("accountId") ?? "";
  const set = (k: string, v: string) => setParams((p) => { p.set(k, v); return p; }, { replace: true });
  const accounts = useApi<{ accounts: Account[] }>(kind === "ledger" ? "/api/books/accounts" : null);

  const path = kind === "trial-balance" ? `/api/books/trial-balance?asOf=${asOf}`
    : kind === "balance-sheet" ? `/api/books/balance-sheet?asOf=${asOf}`
    : kind === "profit-loss" ? `/api/books/profit-loss?from=${from}&to=${to}`
    : accountId ? `/api/books/ledger?accountId=${accountId}&from=${from}&to=${to}${params.get("customerId") ? `&customerId=${params.get("customerId")}` : ""}` : null;
  const { data, error } = useApi<any>(path);

  const range = kind === "trial-balance" || kind === "balance-sheet" ? `As at ${day(asOf)}` : `${day(from)} to ${day(to)}`;
  const sheet: ExportSheet | null = data ? toSheet(kind, data, range, accounts.data?.accounts.find((a) => a.id === accountId)) : null;
  const run = async (fn: () => Promise<void>) => { try { await fn(); } catch (err) { toast.error((err as Error).message); } };

  return (
    <>
      <PageHeader
        back={<BackToBooks />} title={TITLES[kind]} subtitle={range}
        actions={sheet && (
          <>
            <Button icon={<Sheet className="size-4" />} onClick={() => void run(() => exportXlsx(`${TITLES[kind]} ${kind === "trial-balance" || kind === "balance-sheet" ? asOf : `${from} to ${to}`}`, sheet))}>Excel</Button>
            <Button icon={<FileDown className="size-4" />} onClick={() => void run(() => exportPdf(garage?.name ?? "", sheet))}>PDF</Button>
          </>
        )}
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {kind === "ledger" && (
          <Field label="Account" className="min-w-72">
            <Select value={accountId} onChange={(e) => set("accountId", e.target.value)} aria-label="Account">
              <option value="">Choose an account…</option>
              {accounts.data?.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </Select>
          </Field>
        )}
        {kind === "trial-balance" || kind === "balance-sheet" ? (
          <Field label="As at"><Input type="date" value={asOf} onChange={(e) => set("asOf", e.target.value)} aria-label="As at" /></Field>
        ) : (
          <>
            <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => set("from", e.target.value)} aria-label="From" /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => set("to", e.target.value)} aria-label="To" /></Field>
          </>
        )}
      </div>
      {error ? <Empty title="Couldn't load the report">{error}</Empty> : !path ? <Empty title="Choose an account" /> : !data ? <Spinner /> : (
        <Card padded={false}>
          <div data-testid="report">
            {kind === "trial-balance" && <TrialBalance data={data} />}
            {kind === "profit-loss" && <ProfitLoss data={data} />}
            {kind === "balance-sheet" && <BalanceSheet data={data} />}
            {kind === "ledger" && <Ledger data={data} />}
          </div>
        </Card>
      )}
    </>
  );
}

const th = "px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500";
const num = "px-4 py-2 text-right tabular";

function TrialBalance({ data }: { data: { rows: { accountId: string; code: string; name: string; debitFils: number; creditFils: number }[]; totals: { debitFils: number; creditFils: number } } }) {
  const navigate = useNavigate();
  if (!data.rows.length) return <Empty title="Nothing posted up to this date" />;
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-zinc-200 bg-zinc-50/80"><tr><th className={th}>Account</th><th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th></tr></thead>
      <tbody className="divide-y divide-zinc-100">
        {data.rows.map((r) => (
          <tr key={r.accountId} className="cursor-pointer hover:bg-brand-50/60" onClick={() => navigate(`/books/ledger?accountId=${r.accountId}`)}>
            <td className="px-4 py-2">{r.code} {r.name}</td><td className={num}>{amount(r.debitFils)}</td><td className={num}>{amount(r.creditFils)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr data-testid="totals" className="border-t-2 border-zinc-300 font-semibold"><td className="px-4 py-2">Total</td><td className={num}>{money(data.totals.debitFils)}</td><td className={num}>{money(data.totals.creditFils)}</td></tr></tfoot>
    </table>
  );
}

function Lines({ title, rows, totalLabel, total }: { title: string; rows: Row[]; totalLabel: string; total: number }) {
  const navigate = useNavigate();
  return (
    <>
      <tr className="bg-zinc-50/80"><td colSpan={2} className={th}>{title}</td></tr>
      {rows.map((r) => (
        <tr key={r.accountId} className="cursor-pointer hover:bg-brand-50/60" onClick={() => navigate(`/books/ledger?accountId=${r.accountId}`)}>
          <td className="px-4 py-2 pl-8">{r.code} {r.name}</td><td className={num}>{money(r.amountFils)}</td>
        </tr>
      ))}
      <tr className="font-medium"><td className="px-4 py-2">{totalLabel}</td><td className={num}>{money(total)}</td></tr>
    </>
  );
}

const Strong = ({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) => (
  <tr className="border-t-2 border-zinc-300 font-semibold"><td className="px-4 py-2.5">{label}</td><td className={num} data-testid={testId}>{value}</td></tr>
);

function ProfitLoss({ data }: { data: { current: Section; previous: Section } }) {
  const c = data.current;
  return (
    <>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-zinc-100">
          <Lines title="Income" rows={c.income} totalLabel="Total income" total={c.incomeFils} />
          <Lines title="Cost of sales" rows={c.costOfSales} totalLabel="Total cost of sales" total={c.costOfSalesFils} />
          <Strong label="Gross profit" value={money(c.grossProfitFils)} />
          <Lines title="Expenses" rows={c.expenses} totalLabel="Total expenses" total={c.expensesFils} />
          <Strong label="Net profit" value={formatAED(c.netProfitFils)} testId="net-profit" />
        </tbody>
      </table>
      <div className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
        Previous period ({day(data.previous.from)} to {day(data.previous.to)}): net profit {formatAED(data.previous.netProfitFils)}
      </div>
    </>
  );
}

function BalanceSheet({ data }: { data: { assets: Row[]; liabilities: Row[]; equity: Row[]; assetsFils: number; liabilitiesFils: number; equityFils: number; profitThisYearFils: number } }) {
  return (
    <table className="w-full text-sm">
      <tbody className="divide-y divide-zinc-100">
        <Lines title="Assets" rows={data.assets} totalLabel="Total assets" total={data.assetsFils} />
        <Lines title="Liabilities" rows={data.liabilities} totalLabel="Total liabilities" total={data.liabilitiesFils} />
        <Lines title="Equity" rows={[...data.equity, { accountId: "profit", code: "", name: "Profit not yet closed", amountFils: data.profitThisYearFils }]} totalLabel="Total equity" total={data.equityFils} />
        <Strong label="Liabilities and equity" value={money(data.liabilitiesFils + data.equityFils)} />
      </tbody>
    </table>
  );
}

function Ledger({ data }: { data: { openingFils: number; closingFils: number; rows: { entryId: string; number: string; date: string; narration: string; sourceType: string; sourceNumber: string | null; debitFils: number; creditFils: number; balanceFils: number }[] } }) {
  const navigate = useNavigate();
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-zinc-200 bg-zinc-50/80">
        <tr><th className={th}>Date</th><th className={th}>Journal</th><th className={th}>Details</th><th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th><th className={`${th} text-right`}>Balance</th></tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        <tr className="text-zinc-600"><td className="px-4 py-2" colSpan={5}>Opening balance</td><td className={num}>{money(data.openingFils)}</td></tr>
        {data.rows.map((r) => (
          <tr key={`${r.entryId}-${r.balanceFils}`} className="cursor-pointer hover:bg-brand-50/60" onClick={() => navigate(`/books/journals/${r.entryId}`)}>
            <td className="px-4 py-2">{day(r.date)}</td>
            <td className="px-4 py-2 font-mono text-[13px]">{r.number}</td>
            <td className="px-4 py-2">{r.narration}<span className="block text-xs text-zinc-500">{SOURCE_LABELS[r.sourceType] ?? r.sourceType}{r.sourceNumber ? ` · ${r.sourceNumber}` : ""}</span></td>
            <td className={num}>{amount(r.debitFils)}</td><td className={num}>{amount(r.creditFils)}</td><td className={num}>{money(r.balanceFils)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr data-testid="totals" className="border-t-2 border-zinc-300 font-semibold"><td className="px-4 py-2" colSpan={5}>Closing balance</td><td className={num}>{money(data.closingFils)}</td></tr></tfoot>
    </table>
  );
}

/** The report as rows for Excel and PDF (the same figures as on screen). */
function toSheet(kind: ReportKind, d: any, subtitle: string, account?: Account): ExportSheet {
  if (kind === "trial-balance") {
    return {
      title: "Trial balance", subtitle,
      columns: [{ header: "Code", key: "code", width: 8 }, { header: "Account", key: "name" }, { header: "Debit", key: "debit", money: true }, { header: "Credit", key: "credit", money: true }],
      rows: [...d.rows.map((r: any) => ({ code: r.code, name: r.name, debit: r.debitFils, credit: r.creditFils })), { name: "Total", debit: d.totals.debitFils, credit: d.totals.creditFils }],
    };
  }
  const section = (title: string, rows: Row[], total: number, totalLabel: string) => [
    { name: title }, ...rows.map((r) => ({ code: r.code, name: r.name, amount: r.amountFils })), { name: totalLabel, amount: total },
  ];
  const cols = [{ header: "Code", key: "code", width: 8 }, { header: "Account", key: "name" }, { header: "AED", key: "amount", money: true }];
  if (kind === "profit-loss") {
    const c = d.current as Section;
    return {
      title: "Profit and loss", subtitle, columns: cols,
      rows: [...section("Income", c.income, c.incomeFils, "Total income"), ...section("Cost of sales", c.costOfSales, c.costOfSalesFils, "Total cost of sales"),
        { name: "Gross profit", amount: c.grossProfitFils }, ...section("Expenses", c.expenses, c.expensesFils, "Total expenses"), { name: "Net profit", amount: c.netProfitFils }],
    };
  }
  if (kind === "balance-sheet") {
    return {
      title: "Balance sheet", subtitle, columns: cols,
      rows: [...section("Assets", d.assets, d.assetsFils, "Total assets"), ...section("Liabilities", d.liabilities, d.liabilitiesFils, "Total liabilities"),
        ...section("Equity", [...d.equity, { accountId: "p", code: "", name: "Profit not yet closed", amountFils: d.profitThisYearFils }], d.equityFils, "Total equity"),
        { name: "Liabilities and equity", amount: d.liabilitiesFils + d.equityFils }],
    };
  }
  return {
    title: `General ledger: ${account ? `${account.code} ${account.name}` : ""}`, subtitle,
    columns: [{ header: "Date", key: "date", width: 12 }, { header: "Journal", key: "number", width: 12 }, { header: "Details", key: "narration", width: 40 },
      { header: "Debit", key: "debit", money: true }, { header: "Credit", key: "credit", money: true }, { header: "Balance", key: "balance", money: true }],
    rows: [{ narration: "Opening balance", balance: d.openingFils }, ...d.rows.map((r: any) => ({ date: r.date, number: r.number, narration: r.narration, debit: r.debitFils || null, credit: r.creditFils || null, balance: r.balanceFils })),
      { narration: "Closing balance", balance: d.closingFils }],
  };
}
