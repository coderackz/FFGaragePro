import { CloudOff, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Badge, Button, Card, Field, Input, Select, Spinner } from "../../../components/ui";
import { get, post, put } from "../../../lib/api";
import { formatDateTime } from "../../../lib/format";
import { useApi } from "../../../lib/useApi";
import { SectionShell } from "../SectionShell";

type Provider = "whatsapp" | "zoho" | "quickbooks";
interface Status { connected: boolean; label: string | null; since: string; needsSetup: boolean }
interface Failure { provider: Provider; label: string; error: string; attempts: number; nextAttemptAt: string | null }
interface Overview { available: boolean; hookBase?: string; status: Partial<Record<Provider, Status>>; failures: Failure[] }
const NAMES: Record<Provider, string> = { whatsapp: "WhatsApp Business API", zoho: "Zoho Books", quickbooks: "QuickBooks Online" };

const fail = (err: unknown) => toast.error((err as Error).message);
function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} aria-label={label} className="font-mono text-xs" />
        <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard?.writeText(value).then(() => toast.success("Copied"))}>Copy</Button>
      </div>
    </Field>
  );
}
function State({ s }: { s?: Status }) {
  if (!s?.connected) return <Badge>Not connected</Badge>;
  return s.needsSetup ? <Badge>Connected: finish setting up</Badge> : <Badge tone="brand">Connected</Badge>;
}

/**
 * Settings → Integrations: WhatsApp Business API (messages sent by the app), and Zoho Books or QuickBooks Online
 * (customers, invoices, credit notes and payments sent one way). They run in Fleetfix Cloud, where the keys stay.
 */
export function IntegrationsSection() {
  const { data, reload } = useApi<Overview>("/api/integrations");
  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    const p = search.get("connected") as Provider | null;
    if (p && NAMES[p]) {
      toast.success(`${NAMES[p]} connected`);
      search.delete("connected");
      setSearch(search, { replace: true });
    }
  }, [search, setSearch]);

  return (
    <SectionShell title="Integrations" subtitle="WhatsApp Business API, Zoho Books and QuickBooks Online">
      {!data ? <Spinner /> : !data.available ? (
        <Card>
          <div className="flex gap-3 text-sm text-zinc-700">
            <CloudOff className="size-5 shrink-0 text-zinc-400" />
            <div>
              <p className="font-medium text-zinc-900">Integrations run in Fleetfix Cloud.</p>
              <p className="mt-1">Open your garage at garagepro.fleetfix.ae as the owner to connect them. Their keys stay in the cloud and never come to this PC.</p>
              {data.status.whatsapp?.connected && <p className="mt-2">WhatsApp Business API is connected: messages with an approved template go through it.</p>}
            </div>
          </div>
        </Card>
      ) : (
        <div className="space-y-5">
          <WhatsAppCard status={data.status.whatsapp} onChange={reload} />
          <AccountingCard provider="zoho" hookBase={data.hookBase!} status={data.status.zoho} failures={data.failures.filter((f) => f.provider === "zoho")} onChange={reload} />
          <AccountingCard provider="quickbooks" hookBase={data.hookBase!} status={data.status.quickbooks} failures={data.failures.filter((f) => f.provider === "quickbooks")} onChange={reload} />
        </div>
      )}
    </SectionShell>
  );
}

function ProviderCard({ provider, status, children, onDisconnect }: { provider: Provider; status?: Status; children: ReactNode; onDisconnect: () => void }) {
  return (
    <div data-testid={`card-${provider}`}>
      <Card title={NAMES[provider]} actions={<div className="flex items-center gap-2"><State s={status} />{status?.connected && <Button size="sm" variant="ghost" onClick={onDisconnect}>Disconnect</Button>}</div>}>
        {status?.connected && status.label && <p className="mb-3 text-sm font-medium text-zinc-900">{status.label}</p>}
        {children}
      </Card>
    </div>
  );
}

const disconnect = async (p: Provider, onChange: () => void) => {
  if (!window.confirm(`Disconnect ${NAMES[p]}? Its keys are removed from the cloud. What was already sent stays there.`)) return;
  try { await post(`/api/integrations/${p}/disconnect`, {}); toast.success(`${NAMES[p]} disconnected`); onChange(); } catch (err) { fail(err); }
};

function WhatsAppCard({ status, onChange }: { status?: Status; onChange: () => void }) {
  const [f, setF] = useState({ phoneNumberId: "", businessAccountId: "", accessToken: "", appSecret: "" });
  const [test, setTest] = useState({ to: "", templateName: "hello_world", language: "en_US" });
  const [busy, setBusy] = useState<string | null>(null);
  const info = useApi<{ webhookUrl: string; verifyToken: string | null }>(status?.connected ? "/api/integrations/whatsapp" : null);
  const connect = async () => {
    setBusy("connect");
    try { await post("/api/integrations/whatsapp/connect", f); toast.success("WhatsApp Business API connected"); onChange(); } catch (err) { fail(err); } finally { setBusy(null); }
  };
  const sendTest = async () => {
    setBusy("test");
    try { await post("/api/integrations/whatsapp/test", test); toast.success("Test sent"); } catch (err) { fail(err); } finally { setBusy(null); }
  };
  return (
    <ProviderCard provider="whatsapp" status={status} onDisconnect={() => void disconnect("whatsapp", onChange)}>
      {!status?.connected ? (
        <>
          <p className="mb-3 text-sm text-zinc-600">
            Sends messages by itself, with Meta-approved templates (pick the approved name on a message template). Needs a Meta app with
            WhatsApp: copy the IDs from WhatsApp → API Setup, a permanent token from a system user, and the app secret.
          </p>
          <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            <Field label="Phone number ID"><Input value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} aria-label="Phone number ID" /></Field>
            <Field label="WhatsApp business account ID"><Input value={f.businessAccountId} onChange={(e) => setF({ ...f, businessAccountId: e.target.value })} aria-label="WhatsApp business account ID" /></Field>
            <Field label="Permanent access token"><Input type="password" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} aria-label="Permanent access token" /></Field>
            <Field label="App secret"><Input type="password" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} aria-label="App secret" /></Field>
          </div>
          <div className="mt-4 flex justify-end"><Button variant="primary" busy={busy === "connect"} onClick={() => void connect()}>Connect WhatsApp</Button></div>
        </>
      ) : (
        <div className="space-y-4">
          {info.data && (
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <Copyable label="Webhook URL (Meta → WhatsApp → Configuration)" value={info.data.webhookUrl} />
              <Copyable label="Verify token" value={info.data.verifyToken ?? ""} />
            </div>
          )}
          <div className="grid grid-cols-[1fr_1fr_120px_auto] items-end gap-3 max-md:grid-cols-1">
            <Field label="Send a test to"><Input value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} placeholder="050 123 4567" aria-label="Send a test to" /></Field>
            <Field label="Approved template"><Input value={test.templateName} onChange={(e) => setTest({ ...test, templateName: e.target.value })} aria-label="Approved template" /></Field>
            <Field label="Language"><Input value={test.language} onChange={(e) => setTest({ ...test, language: e.target.value })} aria-label="Language" /></Field>
            <Button busy={busy === "test"} disabled={!test.to.trim()} onClick={() => void sendTest()}>Send test</Button>
          </div>
        </div>
      )}
    </ProviderCard>
  );
}

interface Options {
  organizations?: { id: string; name: string }[]; taxes: { id: string; name: string }[]; items: { id: string; name: string }[];
  mapping: { taxId: string; zeroTaxId?: string | null; items: { labour: string; part: string; other: string } } | null;
  organizationId: string | null; fromDate: string; lastPush: { at: string; pushed: number; failed: number } | null;
}

function AccountingCard({ provider, hookBase, status, failures, onChange }: { provider: "zoho" | "quickbooks"; hookBase: string; status?: Status; failures: Failure[]; onChange: () => void }) {
  const [f, setF] = useState({ clientId: "", clientSecret: "", region: "com", sandbox: false, fromDate: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const options = useApi<Options>(status?.connected ? `/api/integrations/${provider}/options` : null);
  const [m, setM] = useState({ organizationId: "", taxId: "", zeroTaxId: "", labour: "", part: "", other: "" });
  useEffect(() => {
    const o = options.data;
    if (!o) return;
    setM({
      organizationId: o.organizationId ?? "", taxId: o.mapping?.taxId ?? "", zeroTaxId: o.mapping?.zeroTaxId ?? "",
      labour: o.mapping?.items.labour ?? "", part: o.mapping?.items.part ?? "", other: o.mapping?.items.other ?? "",
    });
  }, [options.data]);
  const redirectUri = `${hookBase}/${provider}/callback`;
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try { await fn(); } catch (err) { fail(err); } finally { setBusy(null); }
  };
  const connect = () => run("connect", async () => {
    const body = { clientId: f.clientId, clientSecret: f.clientSecret, ...(f.fromDate ? { fromDate: f.fromDate } : {}), ...(provider === "zoho" ? { region: f.region } : { sandbox: f.sandbox }) };
    const { authorizeUrl } = await post<{ authorizeUrl: string }>(`/api/integrations/${provider}/connect`, body);
    window.location.href = authorizeUrl;
  });
  const saveOrg = () => run("org", async () => {
    await put(`/api/integrations/${provider}/mapping`, { organizationId: m.organizationId });
    onChange(); await options.reload();
  });
  const save = () => run("save", async () => {
    await put(`/api/integrations/${provider}/mapping`, {
      ...(m.organizationId ? { organizationId: m.organizationId } : {}), taxId: m.taxId, zeroTaxId: m.zeroTaxId || null,
      items: { labour: m.labour, part: m.part, other: m.other },
    });
    toast.success("Saved"); onChange();
  });
  const pushNow = () => run("push", async () => { await post(`/api/integrations/${provider}/push`, {}); onChange(); await options.reload(); });
  const retry = () => run("retry", async () => { await post(`/api/integrations/${provider}/retry`, {}); await post(`/api/integrations/${provider}/push`, {}); onChange(); await options.reload(); });
  const o = options.data;
  const pick = (label: string, key: "taxId" | "zeroTaxId" | "labour" | "part" | "other", list: { id: string; name: string }[], optional = false) => (
    <Field label={label}>
      <Select value={m[key]} onChange={(e) => setM({ ...m, [key]: e.target.value })} aria-label={label}>
        <option value="">{optional ? "None" : "Choose…"}</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </Select>
    </Field>
  );

  return (
    <ProviderCard provider={provider} status={status} onDisconnect={() => void disconnect(provider, onChange)}>
      {!status?.connected ? (
        <>
          <p className="mb-3 text-sm text-zinc-600">
            Sends customers, issued invoices, credit notes and payments one way, as they happen; nothing there is ever changed afterwards.
            Make a developer app at {provider === "zoho" ? "api-console.zoho.com (Server-based application)" : "developer.intuit.com (Accounting scope)"} with
            this redirect URI, then paste its client ID and secret.
          </p>
          <Copyable label="Redirect URI" value={redirectUri} />
          <div className="mt-3 grid grid-cols-2 gap-3 max-md:grid-cols-1">
            {provider === "zoho" && (
              <Field label="Zoho data centre">
                <Select value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} aria-label="Zoho data centre">
                  <option value="com">United States (.com)</option><option value="eu">Europe (.eu)</option><option value="in">India (.in)</option>
                  <option value="com.au">Australia (.com.au)</option><option value="sa">Saudi Arabia (.sa)</option>
                </Select>
              </Field>
            )}
            <Field label="Send earlier documents from" hint="Blank: only from today">
              <Input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value })} aria-label="Send earlier documents from" />
            </Field>
            <Field label="Client ID"><Input value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} aria-label="Client ID" /></Field>
            <Field label="Client secret"><Input type="password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} aria-label="Client secret" /></Field>
            {provider === "quickbooks" && (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.sandbox} onChange={(e) => setF({ ...f, sandbox: e.target.checked })} /> Sandbox company (for trying it out)</label>
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" busy={busy === "connect"} disabled={!f.clientId.trim() || !f.clientSecret.trim()} onClick={() => void connect()}>Connect {NAMES[provider]}</Button>
          </div>
        </>
      ) : !o ? <Spinner /> : (
        <div className="space-y-4">
          {provider === "zoho" && (o.organizations?.length ?? 0) > 1 && (
            <div className="flex items-end gap-3">
              <Field label="Organization">
                <Select value={m.organizationId} onChange={(e) => setM({ ...m, organizationId: e.target.value })} aria-label="Organization">
                  <option value="">Choose…</option>
                  {o.organizations!.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              </Field>
              <Button busy={busy === "org"} disabled={!m.organizationId || m.organizationId === o.organizationId} onClick={() => void saveOrg()}>Use this organization</Button>
            </div>
          )}
          {(provider === "quickbooks" || o.organizationId) && (
            <>
              <p className="text-sm text-zinc-600">How Fleetfix lines go across:</p>
              <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
                {pick("VAT 5% tax", "taxId", o.taxes)}
                {pick("Zero-rated tax", "zeroTaxId", o.taxes, true)}
                <div />
                {pick("Labour item", "labour", o.items)}
                {pick("Parts item", "part", o.items)}
                {pick("Other item", "other", o.items)}
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-zinc-600">
                  {status.needsSetup ? "Choose these, then Save: nothing is sent until then." : "Ready"}
                  {o.lastPush && ` · Last sent ${formatDateTime(o.lastPush.at)}: ${o.lastPush.pushed} sent${o.lastPush.failed ? `, ${o.lastPush.failed} failed` : ""}`}
                  {` · From ${o.fromDate}`}
                </span>
                <div className="flex gap-2">
                  {!status.needsSetup && <Button busy={busy === "push"} onClick={() => void pushNow()}>Send now</Button>}
                  <Button variant="primary" busy={busy === "save"} disabled={!m.taxId || !m.labour || !m.part || !m.other} onClick={() => void save()}>Save</Button>
                </div>
              </div>
            </>
          )}
          {failures.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium text-red-800">{failures.length} not sent</span>
                <Button size="sm" busy={busy === "retry"} onClick={() => void retry()}>Retry all</Button>
              </div>
              <ul className="space-y-1 text-red-800">
                {failures.map((x) => <li key={`${x.label}`}><span className="font-medium">{x.label}</span>: {x.error}{x.nextAttemptAt ? ` (tries again ${formatDateTime(x.nextAttemptAt)})` : " (waiting for Retry all)"}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </ProviderCard>
  );
}

/** For the Send dialog: is the WhatsApp Business API connected (in the cloud; the status syncs to PCs)? */
export const integrationStatus = () => get<{ whatsapp: boolean; zoho: boolean; quickbooks: boolean }>("/api/integrations/status");
