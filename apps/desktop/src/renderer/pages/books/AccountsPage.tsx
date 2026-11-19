import { ACCOUNT_TYPES, type AccountType } from "@ffgp/shared";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table } from "../../components/ui";
import type { Account } from "../../books/types";
import { patch, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useApi } from "../../lib/useApi";
import { BackToBooks } from "./ReportPage";

export const TYPE_LABELS: Record<AccountType, string> = {
  asset: "Asset", liability: "Liability", equity: "Equity", income: "Income", cost_of_sales: "Cost of sales", expense: "Expense",
};

/** The chart of accounts: add accounts, rename or recode them, switch off ones no longer used. */
export function AccountsPage() {
  const { canSee } = useAuth();
  const { data, reload } = useApi<{ accounts: Account[] }>("/api/books/accounts");
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  return (
    <>
      <PageHeader back={<BackToBooks />} title="Chart of accounts" subtitle="1 assets · 2 liabilities · 3 equity · 4 income · 5 cost of sales · 6 expenses"
        actions={canSee("books.post") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>Add account</Button>} />
      <Card padded={false}>
        {!data ? <Spinner /> : (
          <Table rows={data.accounts} rowKey={(a) => a.id} onRowClick={canSee("books.post") ? (a) => setEditing(a) : undefined}
            columns={[
              { header: "Code", cell: (a) => <span className="font-mono">{a.code}</span> },
              { header: "Name", cell: (a) => <span className={a.active ? "" : "text-zinc-400 line-through"}>{a.name}</span> },
              { header: "Type", cell: (a) => TYPE_LABELS[a.type] },
              { header: "", cell: (a) => (a.systemKey ? <Badge>Used by the app</Badge> : a.active ? null : <Badge>Off</Badge>) },
            ]} />
        )}
      </Card>
      <AccountModal account={editing === "new" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} onSaved={() => void reload()} />
    </>
  );
}

function AccountModal({ account, open, onClose, onSaved }: { account: Account | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ code: "", name: "", type: "expense" as AccountType, active: true });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setV(account ? { code: account.code, name: account.name, type: account.type, active: account.active } : { code: "", name: "", type: "expense", active: true });
  }, [open, account]);
  const save = async () => {
    setBusy(true);
    try {
      if (account) await patch(`/api/books/accounts/${account.id}`, v);
      else await post("/api/books/accounts", { code: v.code, name: v.name, type: v.type });
      toast.success("Account saved");
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const system = !!account?.systemKey;
  return (
    <Modal open={open} onClose={onClose} title={account ? `${account.code} ${account.name}` : "New account"}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!v.name.trim() || !/^\d{4}$/.test(v.code)} onClick={() => void save()}>Save account</Button></>}>
      <div className="grid grid-cols-[120px_1fr] gap-4">
        <Field label="Code"><Input value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} aria-label="Code" inputMode="numeric" maxLength={4} /></Field>
        <Field label="Name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} aria-label="Name" /></Field>
        <Field label="Type" className="col-span-2" hint={system ? "The app posts to this account, so its type is fixed" : undefined}>
          <Select value={v.type} disabled={system} onChange={(e) => setV({ ...v, type: e.target.value as AccountType })} aria-label="Type">
            {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </Select>
        </Field>
        {account && !system && (
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> In use (switched-off accounts stay in reports)
          </label>
        )}
      </div>
    </Modal>
  );
}
