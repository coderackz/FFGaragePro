import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ROLES, ROLE_LABELS, type Role } from "@ffgp/shared";
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table } from "../components/ui";
import { patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate } from "../lib/format";
import type { User } from "../lib/types";
import { useApi } from "../lib/useApi";

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including users, settings and reports.",
  accountant: "Invoices, payments and (soon) the accounts. Can see costs.",
  advisor: "Customers, vehicles, estimates, job cards and issuing invoices.",
};

export function UsersPage({ back }: { back?: ReactNode } = {}) {
  const { user: me } = useAuth();
  const { data, reload } = useApi<{ users: User[] }>("/api/users");
  const [editing, setEditing] = useState<User | "new" | null>(null);

  return (
    <>
      <PageHeader title="Users & roles" subtitle="Everyone who signs in to this garage" back={back} actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>Add user</Button>} />
      <Card padded={false}>
        <Table
          rows={data?.users ?? []}
          rowKey={(u) => u.id}
          onRowClick={(u) => setEditing(u)}
          columns={[
            { header: "Name", cell: (u) => <span className="font-medium">{u.name}{u.id === me?.id && <span className="ml-2 text-xs text-zinc-400">(you)</span>}</span> },
            { header: "Username", cell: (u) => <span className="font-mono text-[13px]">{u.username}</span> },
            { header: "Role", cell: (u) => <Badge tone={u.role === "owner" ? "brand" : "zinc"}>{ROLE_LABELS[u.role]}</Badge> },
            { header: "Status", cell: (u) => (u.active ? "Active" : <Badge tone="red">Disabled</Badge>) },
            { header: "Added", cell: (u) => formatDate(u.createdAt) },
          ]}
        />
      </Card>
      <UserModal user={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />
    </>
  );
}

function UserModal({ user, onClose, onSaved }: { user: User | "new" | null; onClose: () => void; onSaved: () => void }) {
  const isNew = user === "new";
  const existing = user && user !== "new" ? user : null;
  const [form, setForm] = useState({ name: "", username: "", role: "advisor" as Role, password: "", active: true });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user) setForm(existing ? { name: existing.name, username: existing.username, role: existing.role, password: "", active: existing.active ?? true } : { name: "", username: "", role: "advisor", password: "", active: true });
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) await post("/api/users", { name: form.name, username: form.username, role: form.role, password: form.password });
      else await patch(`/api/users/${existing!.id}`, { name: form.name, role: form.role, active: form.active, ...(form.password ? { password: form.password } : {}) });
      toast.success(isNew ? "User added" : "User updated");
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title={isNew ? "Add user" : `Edit ${existing?.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button></>}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Username"><Input value={form.username} disabled={!isNew} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
        <Field label="Role" hint={ROLE_HELP[form.role]} className="col-span-2">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </Select>
        </Field>
        <Field label={isNew ? "Password" : "New password"} hint={isNew ? "At least 8 characters." : "Leave blank to keep the current password."}>
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
        </Field>
        {!isNew && (
          <Field label="Access">
            <Select value={form.active ? "1" : "0"} onChange={(e) => setForm({ ...form, active: e.target.value === "1" })}>
              <option value="1">Can sign in</option>
              <option value="0">Disabled</option>
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
