import { Copy, LogOut, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AuthShell } from "../components/AuthShell";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Spinner, Table, Textarea } from "../components/ui";
import { PasswordField } from "../components/fields";
import logo from "../assets/fleetfix-logo.png";
import { formatDate, formatDateTime } from "../lib/format";

/** Fleet Fix staff console for Fleetfix Cloud: garages, licences, setup codes. Served at /admin.html. */

const TOKEN_KEY = "ffgp.admin";

interface Garage {
  id: string; code: string; name: string; notes: string | null; status: "trial" | "active" | "paused";
  state: "trial" | "active" | "grace" | "read_only"; endsAt: string; graceEndsAt: string; trialEndsAt: string;
  paidUntil: string | null; pausedAt: string | null; setUp: boolean; userCount: number; lastSyncAt: string | null;
  createdAt: string; setupCode?: string | null; setupCodeExpiresAt?: string | null;
}

let token: string | null = (() => {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
})();
const saveToken = (t: string | null) => {
  token = t;
  try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* memory only */ }
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && path !== "/admin/api/login") {
    saveToken(null);
    window.dispatchEvent(new Event("ffgp-admin:signed-out"));
  }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const STATE: Record<Garage["state"], { label: string; tone: string }> = {
  trial: { label: "Trial", tone: "bg-sky-50 text-sky-700 ring-sky-200" },
  active: { label: "Active", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  grace: { label: "Grace", tone: "bg-amber-50 text-amber-800 ring-amber-200" },
  read_only: { label: "Read-only", tone: "bg-red-50 text-red-700 ring-red-200" },
};
function StateBadge({ g }: { g: Garage }) {
  const s = STATE[g.state];
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.tone}`}>{s.label}</span>
      {g.status === "paused" && <Badge>Paused</Badge>}
    </span>
  );
}

const welcome = (g: Garage) => `Garage ID: ${g.code} · Setup code: ${g.setupCode} · Open ${window.location.origin}`;
const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"));

export function AdminApp() {
  const [signedIn, setSignedIn] = useState(!!token);
  useEffect(() => {
    const out = () => setSignedIn(false);
    window.addEventListener("ffgp-admin:signed-out", out);
    return () => window.removeEventListener("ffgp-admin:signed-out", out);
  }, []);
  return signedIn ? <Garages onSignOut={() => { saveToken(null); setSignedIn(false); }} /> : <SignIn onDone={() => setSignedIn(true)} />;
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ token: string }>("POST", "/admin/api/login", { username: username.trim(), password });
      saveToken(res.token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight">Fleetfix Cloud admin</h1>
      <p className="mt-1 text-sm text-zinc-500">For Fleet Fix staff.</p>
      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <Field label="Username"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" /></Field>
        <PasswordField label="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <Button type="submit" variant="primary" busy={busy} disabled={!username || !password} className="mt-2 h-10">Sign in</Button>
      </form>
    </AuthShell>
  );
}

function Garages({ onSignOut }: { onSignOut: () => void }) {
  const [garages, setGarages] = useState<Garage[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Garage | null>(null);
  const load = useCallback(async () => {
    try {
      setGarages((await call<{ garages: Garage[] }>("GET", "/admin/api/garages")).garages);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  const replace = (g: Garage) => {
    setGarages((gs) => (gs ? [g, ...gs.filter((x) => x.id !== g.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [g]));
    setOpen((o) => (o?.id === g.id ? g : o));
  };

  return (
    <div className="min-h-full bg-zinc-50">
      <header className="flex items-center gap-4 bg-ink px-8 py-3 text-white">
        <img src={logo} alt="Fleet Fix" className="h-8 w-auto" />
        <span className="text-xs font-semibold tracking-[0.18em] text-brand uppercase">Cloud admin</span>
        <button type="button" onClick={onSignOut} className="ml-auto inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white"><LogOut className="size-4" />Sign out</button>
      </header>
      <main className="mx-auto max-w-[1280px] px-8 py-6">
        <PageHeader title="Garages" subtitle="Garages on Fleetfix Cloud, their trials and subscriptions"
          actions={<>
            <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()}>Refresh</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New garage</Button>
          </>} />
        <Card padded={false}>
          {!garages ? <div className="p-6"><Spinner /></div> : (
            <Table
              rows={garages}
              rowKey={(g) => g.id}
              onRowClick={setOpen}
              empty={<Empty title="No garages yet">Create the first garage and send its owner the garage ID and setup code.</Empty>}
              columns={[
                { header: "Garage ID", cell: (g) => <span className="font-mono text-[13px] font-medium">{g.code}</span> },
                { header: "Name", cell: (g) => g.name },
                { header: "Status", cell: (g) => <StateBadge g={g} /> },
                { header: "Ends", cell: (g) => formatDate(g.state === "grace" ? g.graceEndsAt : g.endsAt) },
                { header: "Users", cell: (g) => g.userCount, align: "right" },
                {
                  header: "Set up",
                  cell: (g) => g.setUp ? <span className="text-emerald-700">Yes</span> : (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono text-[13px]" data-testid="setup-code">{g.setupCode}</span>
                      <button type="button" title="Copy welcome message" onClick={(e) => { e.stopPropagation(); copy(welcome(g)); }} className="text-zinc-400 hover:text-zinc-700"><Copy className="size-3.5" /></button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </main>
      <NewGarage open={creating} onClose={() => setCreating(false)} onCreated={(g) => { replace(g); setOpen(g); }} />
      {open && <GarageDialog garage={open} onClose={() => setOpen(null)} onChanged={replace} />}
    </div>
  );
}

function NewGarage({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (g: Garage) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setCode(""); setName(""); setNotes(""); } }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { garage } = await call<{ garage: Garage }>("POST", "/admin/api/garages", { code, name, notes: notes || null });
      toast.success(`${garage.code} created`);
      onCreated(garage);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New garage"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-garage" busy={busy}>Create garage</Button></>}>
      <form id="new-garage" onSubmit={submit} className="grid gap-3">
        <Field label="Garage name"><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="Al Quoz Auto Care" /></Field>
        <Field label="Garage ID" hint="What the owner types to open the garage. Lowercase letters, numbers and dashes, e.g. alquoz-auto.">
          <Input value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} required className="font-mono" />
        </Field>
        <Field label="Notes (Fleet Fix only)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-14" /></Field>
        <p className="text-sm text-zinc-500">The garage starts a 60-day free trial today.</p>
      </form>
    </Modal>
  );
}

function GarageDialog({ garage: g, onClose, onChanged }: { garage: Garage; onClose: () => void; onChanged: (g: Garage) => void }) {
  const [paidUntil, setPaidUntil] = useState(g.paidUntil ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try { await fn(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(null); }
  };
  const patchGarage = (body: unknown, done: string) => run(done, async () => {
    const { garage } = await call<{ garage: Garage }>("PATCH", `/admin/api/garages/${g.id}`, body);
    onChanged(garage);
    toast.success(done);
  });

  return (
    <Modal open onClose={onClose} title={`${g.name} — ${g.code}`} width="max-w-xl">
      <div className="flex flex-col gap-5 text-sm">
        <dl className="grid grid-cols-[130px_1fr] gap-y-1.5">
          <dt className="text-zinc-500">Status</dt><dd><StateBadge g={g} /></dd>
          <dt className="text-zinc-500">Trial ends</dt><dd>{formatDate(g.trialEndsAt)}</dd>
          <dt className="text-zinc-500">Paid until</dt><dd>{g.paidUntil ? formatDate(g.paidUntil) : "—"}</dd>
          {g.state === "grace" && (<><dt className="text-zinc-500">Read-only from</dt><dd className="text-amber-800">{formatDate(g.graceEndsAt)}</dd></>)}
          <dt className="text-zinc-500">Users</dt><dd>{g.userCount}</dd>
          <dt className="text-zinc-500">Last sync</dt><dd>{g.lastSyncAt ? formatDateTime(g.lastSyncAt) : "—"}</dd>
          <dt className="text-zinc-500">Created</dt><dd>{formatDateTime(g.createdAt)}</dd>
          {g.notes && (<><dt className="text-zinc-500">Notes</dt><dd className="whitespace-pre-line">{g.notes}</dd></>)}
        </dl>

        {!g.setUp && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <div className="mb-1 font-medium">Waiting for the owner to set up</div>
            <div className="mb-2 text-zinc-600">Send this to the owner. The code works until {formatDate(g.setupCodeExpiresAt ?? null)}.</div>
            <div className="flex items-center gap-2 rounded bg-white px-2 py-1.5 font-mono text-[13px] ring-1 ring-zinc-200" data-testid="welcome">{welcome(g)}</div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => copy(welcome(g))}>Copy</Button>
              <Button size="sm" busy={busy === "code"} onClick={() => run("code", async () => { onChanged((await call<{ garage: Garage }>("POST", `/admin/api/garages/${g.id}/setup-code`)).garage); toast.success("New setup code"); })}>New setup code</Button>
            </div>
          </div>
        )}

        <div className="flex items-end gap-2">
          <Field label="Paid until" className="flex-1"><Input type="date" value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} /></Field>
          <Button variant="primary" busy={busy === "Subscription saved"} disabled={!paidUntil || paidUntil === g.paidUntil} onClick={() => patchGarage({ paidUntil }, "Subscription saved")}>Save</Button>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-zinc-100 pt-4">
          {g.status === "paused"
            ? <Button busy={busy === "Garage reactivated"} onClick={() => patchGarage({ status: "active" }, "Garage reactivated")}>Reactivate</Button>
            : <Button variant="danger" busy={busy === "Garage paused"} onClick={() => window.confirm(`Pause ${g.name}? It becomes read-only after the 14-day grace period.`) && patchGarage({ status: "paused" }, "Garage paused")}>Pause</Button>}
          {g.setUp && (
            <Button busy={busy === "reset"} onClick={() => window.confirm("Give the owner a temporary password? Their current password stops working.") && run("reset", async () => {
              setTemp(await call<{ username: string; temporaryPassword: string }>("POST", `/admin/api/garages/${g.id}/reset-owner-password`));
            })}>Reset owner password</Button>
          )}
        </div>
        {temp && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
            Temporary password for <b>{temp.username}</b>: <span className="font-mono font-semibold" data-testid="temp-password">{temp.temporaryPassword}</span>
            <div className="mt-1 text-xs">Shown once. The owner should change it in Users after signing in.</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
