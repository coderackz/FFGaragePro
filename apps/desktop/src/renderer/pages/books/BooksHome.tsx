import { BookOpen, ChartBar, FileSpreadsheet, HeartPulse, ListTree, Scale, ScrollText, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { PageHeader } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/format";
import { useApi } from "../../lib/useApi";

const CARDS: { to: string; title: string; blurb: string; icon: ReactNode }[] = [
  { to: "/books/trial-balance", title: "Trial balance", blurb: "Every account's balance on a date", icon: <Scale className="size-5" /> },
  { to: "/books/profit-loss", title: "Profit and loss", blurb: "Income, costs and profit for a period", icon: <ChartBar className="size-5" /> },
  { to: "/books/balance-sheet", title: "Balance sheet", blurb: "What the garage owns and owes", icon: <Wallet className="size-5" /> },
  { to: "/books/ledger", title: "General ledger", blurb: "One account's entries, line by line", icon: <ScrollText className="size-5" /> },
  { to: "/books/journals", title: "Journals", blurb: "All entries; post a journal, reverse one", icon: <BookOpen className="size-5" /> },
  { to: "/books/accounts", title: "Chart of accounts", blurb: "Add, rename or switch off accounts", icon: <ListTree className="size-5" /> },
  { to: "/books/opening", title: "Opening balances", blurb: "Where the books start from", icon: <FileSpreadsheet className="size-5" /> },
  { to: "/books/health", title: "Books health", blurb: "Do the books agree with the workshop?", icon: <HeartPulse className="size-5" /> },
];

/** The Books area: what's in it, and a reminder when the books haven't started. */
export function BooksHome() {
  const { settings, canSee } = useAuth();
  const start = settings?.books.startDate ?? null;
  const health = useApi<{ checks: { ok: boolean }[] }>(start ? "/api/books/health" : null);
  const failing = health.data?.checks.filter((c) => !c.ok).length ?? 0;
  return (
    <>
      <PageHeader title="Books" subtitle={start ? `From ${formatDate(`${start}T00:00:00.000Z`)}${settings?.books.lockDate ? ` · locked up to ${formatDate(`${settings.books.lockDate}T00:00:00.000Z`)}` : ""}` : "Accounting"} />
      {!start && (
        <div className="mb-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200" data-testid="books-not-started">
          Books not started: set the start date in {canSee("settings.manage") ? <Link to="/settings/books" className="font-medium underline">Settings → Books</Link> : "Settings → Books (ask the Owner)"}.
        </div>
      )}
      {failing > 0 && (
        <div className="mb-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200">
          {failing} check{failing === 1 ? "" : "s"} in <Link to="/books/health" className="font-medium underline">Books health</Link> need a look.
        </div>
      )}
      <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
        {CARDS.map((c) => (
          <Link key={c.to} to={c.to} className="flex gap-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200 transition hover:ring-brand-300">
            <span className="mt-0.5 text-brand-700">{c.icon}</span>
            <span>
              <span className="block font-medium text-zinc-900">{c.title}</span>
              <span className="block text-sm text-zinc-600">{c.blurb}</span>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}
