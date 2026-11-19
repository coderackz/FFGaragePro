import { ArrowLeft, ArrowRight, Banknote, CircleCheck, FileDown, FileMinus, PackagePlus, Plus, Printer, Save, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  catalogueLinePrice, CONVERTS_TO, DEFAULT_SETTINGS, DOC_LABELS, DOC_STATUSES, LINE_KINDS, PAYMENT_METHODS, STATUS_LABELS, docTotals, lineTotals, type DocType, type LineKind,
} from "@ffgp/shared";
import { CustomerPicker } from "../components/CustomerPicker";
import { CustomerFormModal } from "../components/forms";
import { PartLink, PartPicker } from "../components/PartPicker";
import { RequestPartDialog } from "../components/RequestPartDialog";
import { Badge, Button, Card, Empty, Field, Input, Modal, MoneyInput, NumberInput, PageHeader, Select, Spinner, StatusBadge, Textarea } from "../components/ui";
import { get, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PAYMENT_LABELS, formatAED, formatDate, formatDateTime, formatKm } from "../lib/format";
import type { Customer, DocLine, DocumentFull, Vehicle } from "../lib/types";
import { useApi } from "../lib/useApi";
import { CreditNoteDialog } from "../components/CreditNoteDialog";
import { useOwnerApproval } from "../components/OwnerApproval";
import { printDocument } from "../print/print";

const LIST_PATH: Record<DocType, string> = { estimate: "/estimates", jobcard: "/jobcards", invoice: "/invoices", credit_note: "/credit-notes" };
const KIND_LABELS: Record<LineKind, string> = { labour: "Labour", part: "Part", other: "Other" };
const MANUAL: Record<DocType, readonly string[]> = { estimate: ["draft", "sent", "approved"], jobcard: ["open", "in_progress", "completed"], invoice: [], credit_note: [] };

interface Draft {
  customer: { id: string; name: string } | null;
  vehicleId: string | null;
  odometer: number | null;
  notes: string;
  lines: DocLine[];
  /** Invoices: the customer's LPO number. */
  lpoNumber: string;
}

/** A new empty line; labour starts at the garage's labour rate (Settings → Pricing). */
const blankLine = (kind: LineKind, labourRateFils?: number | null): DocLine => ({
  kind, description: "", qty: 1, unitPriceFils: kind === "labour" ? labourRateFils ?? 0 : 0, discountPct: 0,
});

export function DocumentPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { garage, settings, can, readOnly } = useAuth();
  const isNew = !params.id;
  const docQuery = useApi<{ document: DocumentFull }>(isNew ? null : `/api/documents/${params.id}`);
  const doc = docQuery.data?.document ?? null;
  const type = (doc?.type ?? params.type) as DocType;
  const label = DOC_LABELS[type] ?? "Document";

  const [draft, setDraft] = useState<Draft>({ customer: null, vehicleId: null, odometer: null, notes: "", lines: [blankLine("labour", settings?.pricing.labourRateFils)], lpoNumber: "" });
  const [crediting, setCrediting] = useState(false);
  const approval = useOwnerApproval();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newCustomer, setNewCustomer] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [requesting, setRequesting] = useState<{ documentId: string; position: number; line: DocLine } | null>(null);

  // Initialise from the loaded document, or from ?customerId= for a new one.
  useEffect(() => {
    if (doc) {
      setDraft({
        customer: { id: doc.customer.id, name: doc.customer.name },
        vehicleId: doc.vehicle?.id ?? null,
        odometer: doc.odometer,
        notes: doc.notes ?? "",
        lines: doc.lines.length ? doc.lines : doc.editable ? [blankLine("labour", settings?.pricing.labourRateFils)] : [],
        lpoNumber: doc.lpoNumber ?? "",
      });
      setDirty(false);
    }
  }, [doc]);
  const presetCustomer = useApi<{ customer: Customer; vehicles: Vehicle[] }>(isNew && search.get("customerId") ? `/api/customers/${search.get("customerId")}` : null);
  useEffect(() => {
    if (isNew && presetCustomer.data) {
      const vehicles = presetCustomer.data.vehicles;
      setDraft((d) => ({ ...d, customer: presetCustomer.data!.customer, vehicleId: vehicles.length === 1 ? vehicles[0]!.id : null, odometer: vehicles.length === 1 ? vehicles[0]!.odometer : null }));
    }
  }, [isNew, presetCustomer.data]);

  // Re-read when this document's money changes (issued, paid, credited) so the account balance shown is current.
  const moneyKey = doc ? `${doc.id}:${doc.status}:${doc.paidFils}:${doc.creditedFils ?? 0}` : "new";
  const customerDetail = useApi<{ customer: Customer; vehicles: Vehicle[] }>(draft.customer ? `/api/customers/${draft.customer.id}?v=${encodeURIComponent(moneyKey)}` : null);
  const vehicles = customerDetail.data?.vehicles ?? [];

  const editable = !readOnly && (isNew || (doc?.editable ?? false));
  const vatRate = garage?.vatRateBp ?? 500;
  // A saved document keeps the VAT choice it was created with; a new one follows Settings → Tax.
  const includeVat = doc ? doc.pricesIncludeVat : (settings?.tax.pricesIncludeVat ?? false);
  const totals = useMemo(() => docTotals(draft.lines, vatRate, includeVat), [draft.lines, vatRate, includeVat]);

  const update = (patchDraft: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patchDraft }));
    setDirty(true);
  };
  const updateLine = (i: number, patchLine: Partial<DocLine>) => update({ lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patchLine } : l)) });

  const cleanLines = () => draft.lines.filter((l) => l.description.trim() !== "" || l.unitPriceFils > 0);

  const validate = (): string | null => {
    if (!draft.customer) return "Choose a customer";
    const bad = cleanLines().find((l) => l.description.trim() === "");
    if (bad) return "Every charged line needs a description";
    return null;
  };

  /** Saves and returns the document id (creating it if new). */
  const save = async (): Promise<string | null> => {
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return null;
    }
    const lines = cleanLines().map(({ kind, description, qty, unitPriceFils, discountPct, partId, suppliedBy, poLineId }) => ({
      kind, description: description.trim(), qty, unitPriceFils, discountPct,
      partId: kind === "part" ? partId ?? null : null, suppliedBy: kind === "part" ? suppliedBy ?? "garage" : "garage", poLineId: poLineId ?? null,
    }));
    const body = { vehicleId: draft.vehicleId, odometer: draft.odometer, notes: draft.notes, lines, ...(type === "invoice" && !isNew ? { lpoNumber: draft.lpoNumber } : {}) };
    if (isNew) {
      const res = await approval.withApproval((a) => post<{ document: DocumentFull }>("/api/documents", { type, customerId: draft.customer!.id, ...body, approval: a }));
      setDirty(false);
      navigate(`/documents/${res.document.id}`, { replace: true });
      return res.document.id;
    }
    if (dirty && editable) {
      const res = await approval.withApproval((a) => patch<{ document: DocumentFull }>(`/api/documents/${doc!.id}`, { ...body, approval: a }));
      docQuery.setData(res);
    }
    setDirty(false);
    return doc!.id;
  };

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onSave = () => run("save", async () => {
    if (await save()) toast.success(`${label} saved`);
  });

  const onStatus = (status: string) => run("status", async () => {
    if (!(await save())) return;
    const res = await patch<{ document: DocumentFull }>(`/api/documents/${doc!.id}`, { status });
    docQuery.setData(res);
    toast.success(`Marked as ${STATUS_LABELS[status]}`);
  });

  const onConvert = () => run("convert", async () => {
    const id = await save();
    if (!id) return;
    const res = await post<{ document: DocumentFull }>(`/api/documents/${id}/convert`);
    toast.success(`${res.document.number} created`);
    navigate(`/documents/${res.document.id}`);
  });

  const onIssue = () => run("issue", async () => {
    const id = await save();
    if (!id) return;
    if (!window.confirm("Issue this tax invoice? After issuing, it can no longer be edited.")) return;
    // Over the customer's credit limit: a warning, a refusal, or the Owner's approval (Settings → Customers & credit).
    const res = await approval.withApproval((a) => post<{ document: DocumentFull; warning?: string }>(`/api/documents/${id}/issue`, { approval: a }));
    docQuery.setData({ document: res.document });
    toast.success(`${res.document.number} issued`);
    if (res.warning) toast.warning(res.warning);
  });

  /** Saves first if needed, then opens "Request part" for the line (positions are counted after blank lines are dropped). */
  const onRequest = (i: number) => run("request", async () => {
    const line = draft.lines[i]!;
    const position = cleanLines().indexOf(line);
    const id = await save();
    if (!id || position < 0) return;
    setRequesting({ documentId: id, position, line });
  });

  const onPrint = (mode: "pdf" | "print") => run(mode, async () => {
    const id = dirty ? await save() : doc?.id;
    if (!id || !garage) return;
    const { document } = await get<{ document: DocumentFull }>(`/api/documents/${id}`);
    docQuery.setData({ document });
    await printDocument(document, garage, settings ?? DEFAULT_SETTINGS, mode);
  });

  if (!isNew && docQuery.error) return <Empty title="Document not found">{docQuery.error}</Empty>;
  if (!isNew && !doc) return <Spinner />;
  if (!DOC_LABELS[type]) return <Empty title="Unknown document type" />;

  const next = CONVERTS_TO[type];
  const isInvoice = type === "invoice";

  return (
    <>
      {approval.dialog}
      <PageHeader
        back={<Link to={LIST_PATH[type]} className="mb-1 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"><ArrowLeft className="size-3.5" /> {label}s</Link>}
        title={
          <span className="flex items-center gap-3">
            {doc ? <span className="font-mono">{doc.number}</span> : `New ${label.toLowerCase()}`}
            {doc && <StatusBadge status={doc.status} />}
            {dirty && <span className="text-sm font-normal text-amber-700">Unsaved changes</span>}
          </span>
        }
        subtitle={
          doc && (
            <span className="flex items-center gap-3">
              <span>Created {formatDateTime(doc.createdAt)}{doc.createdBy ? ` by ${doc.createdBy}` : ""}</span>
              {doc.source && <Link className="text-brand-700 hover:underline" to={`/documents/${doc.source.id}`}>{type === "credit_note" ? "credit for" : "from"} {doc.source.number}</Link>}
              {doc.derived && <Link className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline" to={`/documents/${doc.derived.id}`}>converted to {doc.derived.number} <ArrowRight className="size-3.5" /></Link>}
            </span>
          )
        }
        actions={
          <>
            {doc && (
              <>
                <Button icon={<Printer className="size-4" />} busy={busy === "print"} onClick={() => onPrint("print")}>Print</Button>
                <Button icon={<FileDown className="size-4" />} busy={busy === "pdf"} onClick={() => onPrint("pdf")}>PDF</Button>
              </>
            )}
            {doc && MANUAL[type].includes(doc.status) && (
              <Select value={doc.status} onChange={(e) => onStatus(e.target.value)} className="w-40" disabled={busy !== null} aria-label="Status">
                {MANUAL[type].map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </Select>
            )}
            {editable && <Button icon={<Save className="size-4" />} busy={busy === "save"} onClick={onSave} variant={next || isInvoice ? "secondary" : "primary"}>Save</Button>}
            {doc && next && doc.status !== "converted" && (
              <Button variant="primary" icon={<ArrowRight className="size-4" />} busy={busy === "convert"} onClick={onConvert}>
                {next === "jobcard" ? "Convert to job card" : "Create invoice"}
              </Button>
            )}
            {doc && isInvoice && doc.status === "draft" && can("invoices.issue") && (
              <Button variant="primary" icon={<CircleCheck className="size-4" />} busy={busy === "issue"} onClick={onIssue}>Issue invoice</Button>
            )}
            {doc && isInvoice && doc.status !== "draft" && can("credit_notes.issue") && (
              <Button icon={<FileMinus className="size-4" />} onClick={() => setCrediting(true)}>Credit note</Button>
            )}
            {doc && isInvoice && ["issued", "part_paid"].includes(doc.status) && can("payments.record") && (
              <Button variant="primary" icon={<Banknote className="size-4" />} onClick={() => setPaying(true)}>Record payment</Button>
            )}
          </>
        }
      />

      <div className="grid gap-5 min-[1440px]:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card title="Customer & vehicle">
            <div className="grid grid-cols-3 gap-4">
              <Field label="Customer">
                <CustomerPicker
                  value={draft.customer}
                  disabled={!isNew}
                  onChange={(c) => update({ customer: c, vehicleId: null, odometer: null })}
                  onCreate={(name) => setNewCustomer(name)}
                />
              </Field>
              <Field label="Vehicle">
                <Select
                  value={draft.vehicleId ?? ""}
                  disabled={!editable || !draft.customer}
                  onChange={(e) => {
                    const v = vehicles.find((x) => x.id === e.target.value);
                    update({ vehicleId: e.target.value || null, odometer: v?.odometer ?? draft.odometer });
                  }}
                >
                  <option value="">{draft.customer ? (vehicles.length ? "Choose vehicle…" : "No vehicles on file") : "Choose a customer first"}</option>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} — {[v.make, v.model].filter(Boolean).join(" ")}</option>)}
                </Select>
              </Field>
              <Field label="Odometer (km)">
                <Input
                  inputMode="numeric"
                  disabled={!editable}
                  value={draft.odometer?.toString() ?? ""}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value.replace(/[,\s]/g, ""), 10);
                    update({ odometer: Number.isFinite(n) ? n : null });
                  }}
                />
              </Field>
              {isInvoice && (doc || isNew) && (
                <Field label="LPO number" hint={customerDetail.data?.customer.lpoRequired ? "This customer needs one before the invoice is issued" : "The customer's purchase order, if any"}>
                  <Input value={draft.lpoNumber} disabled={!editable || isNew} onChange={(e) => update({ lpoNumber: e.target.value })} placeholder={isNew ? "Save first" : ""} aria-label="LPO number" />
                </Field>
              )}
              {customerDetail.data && !!customerDetail.data.customer.balanceFils && (
                <div className="col-span-3 flex items-center gap-2 text-sm text-zinc-700" data-testid="customer-balance">
                  Account balance <b className="tabular">{formatAED(customerDetail.data.customer.balanceFils)}</b>
                  {customerDetail.data.customer.overLimit && <Badge tone="red">Over the credit limit</Badge>}
                  {!!customerDetail.data.customer.overdueFils && <span className="text-red-700">· {formatAED(customerDetail.data.customer.overdueFils)} overdue</span>}
                </div>
              )}
            </div>
          </Card>

          <Card
            title={type === "jobcard" ? "Work & parts" : "Items"}
            padded={false}
            actions={editable && LINE_KINDS.map((k) => (
              <Button key={k} size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => update({ lines: [...draft.lines, { ...blankLine(k, settings?.pricing.labourRateFils), discountPct: customerDetail.data?.customer.discountPct ?? 0 }] })}>{KIND_LABELS[k]}</Button>
            ))}
          >
            <LinesTable
              lines={draft.lines} editable={editable} vatRate={vatRate} includeVat={includeVat} onChange={updateLine}
              onRemove={(i) => update({ lines: draft.lines.filter((_, j) => j !== i) })}
              onRequest={type === "jobcard" && !isNew && editable && can("documents.edit") ? onRequest : undefined}
              showCost={can("costs.view")}
            />
          </Card>

          {(editable || draft.notes) && <Card title="Notes">
            <Textarea
              value={draft.notes}
              disabled={!editable}
              onChange={(e) => update({ notes: e.target.value })}
              placeholder={type === "jobcard" ? "Customer complaint, findings, technician notes…" : "Shown on the printed document"}
              rows={3}
            />
          </Card>}
        </div>

        {/* Beside the items on wide screens; below them, in two columns, on small garage screens. */}
        <div className="grid content-start gap-5 md:max-[1439px]:grid-cols-2">
          <Card title="Summary">
            <dl className="flex flex-col gap-2 text-sm">
              <Row label="Subtotal" value={formatAED(totals.netFils)} />
              <Row label={`VAT ${vatRate / 100}%`} value={formatAED(totals.vatFils)} />
              <div className="my-1 border-t border-dashed border-zinc-200" />
              <Row label={type === "credit_note" ? "Total credit" : "Total"} value={formatAED(totals.grossFils)} strong />
              {doc && doc.type !== "credit_note" && doc.partsCostFils !== undefined && !dirty && (
                <div className="mt-1 flex flex-col gap-1.5 border-t border-zinc-100 pt-2" data-testid="job-cost">
                  <Row label="Parts cost" value={formatAED(doc.partsCostFils)} />
                  <Row label="Margin (before VAT)" value={formatAED(doc.marginFils ?? 0)} />
                  {doc.costPending && <div className="text-xs text-amber-700">Some parts' cost isn't known yet (not received, or used before a delivery was entered), so it isn't counted.</div>}
                  {!!doc.uncostedLines && <div className="text-xs text-amber-700">{doc.uncostedLines} typed-in part {doc.uncostedLines === 1 ? "line has" : "lines have"} no cost — pick parts from the list so margin is right.</div>}
                </div>
              )}
              {isInvoice && doc && doc.status !== "draft" && (
                <>
                  {doc.dueDate && <Row label="Due" value={formatDate(`${doc.dueDate}T00:00:00.000Z`)} />}
                  {!!doc.creditedFils && <Row label="Credited" value={formatAED(doc.creditedFils)} />}
                  <Row label="Paid" value={formatAED(doc.paidFils)} />
                  <div className="mt-1 flex items-center justify-between rounded-md bg-zinc-50 px-3 py-2">
                    <dt className="font-medium">Balance due</dt>
                    <dd className={`tabular text-base font-semibold ${doc.balanceFils > 0 ? "text-red-700" : "text-emerald-700"}`}>{formatAED(doc.balanceFils)}</dd>
                  </div>
                </>
              )}
            </dl>
          </Card>
          {doc?.vehicle && (
            <Card title="Vehicle">
              <div className="font-mono text-lg font-semibold">{doc.vehicle.plate}</div>
              <div className="text-sm text-zinc-600">{[doc.vehicle.make, doc.vehicle.model, doc.vehicle.year].filter(Boolean).join(" ")}</div>
              <div className="mt-2 text-xs text-zinc-500">VIN {doc.vehicle.vin ?? "—"} · last {formatKm(doc.vehicle.odometer)}</div>
            </Card>
          )}
          {isInvoice && doc && doc.status !== "draft" && (
            <Card title="Payments" padded={false}>
              {doc.payments.length === 0 ? (
                <div className="px-4 py-3 text-sm text-zinc-500">No payments yet</div>
              ) : (
                <ul className="divide-y divide-zinc-100">
                  {doc.payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <div>
                        <div className="font-medium">{PAYMENT_LABELS[p.method] ?? p.method}{p.reference ? ` · ${p.reference}` : ""}</div>
                        <div className="text-xs text-zinc-500">{formatDate(p.paidAt)}{p.createdBy ? ` · ${p.createdBy}` : ""}</div>
                      </div>
                      <div className="tabular font-medium">{formatAED(p.amountFils)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {type === "credit_note" && doc && (
            <Card title="Reason">
              <div className="text-sm whitespace-pre-line text-zinc-800" data-testid="credit-reason">{doc.reason}</div>
              <div className="mt-2 text-xs text-zinc-600">A credit note can't be changed. It reduces what {doc.customer.name} owes.</div>
            </Card>
          )}
          {isInvoice && doc && !!doc.creditNotes?.length && (
            <Card title="Credit notes" padded={false}>
              <ul className="divide-y divide-zinc-100">
                {doc.creditNotes.map((c) => (
                  <li key={c.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <Link to={`/documents/${c.id}`} className="font-mono font-medium text-brand-700 hover:underline">{c.number}</Link>
                    <span className="tabular">{formatAED(c.grossFils)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {isInvoice && doc?.status === "draft" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              This invoice is a <b>draft</b>. Issue it to give it to the customer and take payments. Issued invoices can't be edited.
            </div>
          )}
        </div>
      </div>

      <CustomerFormModal
        open={newCustomer !== null}
        initialName={newCustomer ?? ""}
        onClose={() => setNewCustomer(null)}
        onSaved={(c) => update({ customer: c, vehicleId: null })}
      />
      <RequestPartDialog request={requesting} onClose={() => setRequesting(null)} onDone={(d) => docQuery.setData({ document: d })} />
      {doc && <PaymentModal open={paying} doc={doc} onClose={() => setPaying(false)} onPaid={(d) => docQuery.setData({ document: d })} />}
      {doc && isInvoice && <CreditNoteDialog invoice={doc} open={crediting} onClose={() => setCrediting(false)} onDone={(cn) => navigate(`/documents/${cn.id}`)} />}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className={strong ? "font-semibold" : "text-zinc-600"}>{label}</dt>
      <dd className={`tabular ${strong ? "text-lg font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}

function LinesTable({ lines, editable, vatRate, includeVat, onChange, onRemove, onRequest, showCost }: {
  lines: DocLine[]; editable: boolean; vatRate: number; includeVat: boolean; onChange: (i: number, l: Partial<DocLine>) => void; onRemove: (i: number) => void;
  onRequest?: (i: number) => void; showCost: boolean;
}) {
  if (lines.length === 0) return <Empty title="No items" />;
  return (
    <div className="overflow-x-auto">
    <table className="w-full min-w-[700px] table-fixed text-sm">
      <thead>
        <tr className="border-b border-zinc-200 bg-zinc-50/80 text-left text-xs font-medium tracking-wide text-zinc-500 uppercase">
          <th className="w-[124px] px-3 py-2 font-medium">Type</th>
          <th className="px-2 py-2 font-medium">Description</th>
          <th className="w-[64px] px-2 py-2 text-right font-medium">Qty</th>
          <th className="w-[96px] px-2 py-2 text-right font-medium">{includeVat ? "Price incl. VAT" : "Unit price"}</th>
          <th className="w-[64px] px-2 py-2 text-right font-medium">Disc %</th>
          <th className="w-[70px] px-2 py-2 text-right font-medium">VAT</th>
          <th className="w-[96px] px-3 py-2 text-right font-medium">Total</th>
          {editable && <th className="w-10" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {lines.map((line, i) => {
          const t = lineTotals(line, vatRate, includeVat);
          return (
            <tr key={i} className="align-top">
              <td className="px-3 py-1.5">
                {editable ? (
                  <Select value={line.kind} onChange={(e) => onChange(i, { kind: e.target.value as LineKind })} className="h-8" aria-label="Line type">
                    {LINE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </Select>
                ) : (
                  <span className="text-zinc-600">{KIND_LABELS[line.kind]}</span>
                )}
              </td>
              <td className="px-2 py-1.5 break-words">
                {editable && line.kind === "part" ? (
                  <PartPicker line={line} onChange={(p) => onChange(i, p)} priceOf={(p) => catalogueLinePrice(p.sellPriceFils, vatRate, includeVat)} />
                ) : editable ? (
                  <Input value={line.description} onChange={(e) => onChange(i, { description: e.target.value })} placeholder={line.kind === "labour" ? "e.g. Replace front brake pads" : "Description"} className="h-8" />
                ) : (
                  line.description
                )}
                {line.kind === "part" && <PartControls line={line} editable={editable} showCost={showCost} onChange={(p) => onChange(i, p)} onRequest={onRequest && (() => onRequest(i))} />}
              </td>
              <td className="px-2 py-1.5 text-right tabular">
                {editable ? <NumberInput value={line.qty} onChange={(qty) => onChange(i, { qty })} className="h-8" aria-label="Quantity" /> : line.qty}
              </td>
              <td className="px-2 py-1.5 text-right tabular">
                {editable && line.suppliedBy !== "fleetfix" ? <MoneyInput fils={line.unitPriceFils} onChange={(unitPriceFils) => onChange(i, { unitPriceFils })} className="h-8" aria-label="Unit price" /> : formatAED(line.unitPriceFils).replace("AED ", "")}
              </td>
              <td className="px-2 py-1.5 text-right tabular">
                {editable ? <NumberInput value={line.discountPct} onChange={(discountPct) => onChange(i, { discountPct: Math.min(100, discountPct) })} className="h-8" aria-label="Discount percent" /> : line.discountPct || "—"}
              </td>
              <td className="px-2 py-1.5 text-right text-zinc-500 tabular">{formatAED(t.vatFils).replace("AED ", "")}</td>
              <td className="px-3 py-1.5 text-right font-medium tabular">{formatAED(t.grossFils).replace("AED ", "")}</td>
              {editable && (
                <td className="pr-2">
                  <button type="button" onClick={() => onRemove(i)} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove line">
                    <Trash2 className="size-4" />
                  </button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

/** The row of part details under a part line: Fleet Fix supply, order status, shelf warning, request button. */
function PartControls({ line, editable, showCost, onChange, onRequest }: {
  line: DocLine; editable: boolean; showCost: boolean; onChange: (p: Partial<DocLine>) => void; onRequest?: () => void;
}) {
  const fleetfix = line.suppliedBy === "fleetfix";
  const short = line.partStocked && !fleetfix && line.pickedOnHand !== undefined && line.qty > line.pickedOnHand;
  const canRequest = onRequest && !fleetfix && !line.poLineId && line.description.trim() !== "";
  const hasAny = line.partId || fleetfix || line.orderStatus || editable || (showCost && line.costFils !== undefined);
  if (!hasAny) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <PartLink line={line} editable={editable} onUnlink={() => onChange({ partId: null, partNo: null, partStocked: null, partOnHand: null, pickedOnHand: undefined })} />
      {editable ? (
        <label className="inline-flex items-center gap-1 text-zinc-600">
          <input type="checkbox" checked={fleetfix} disabled={!!line.poLineId} onChange={(e) => onChange(e.target.checked ? { suppliedBy: "fleetfix", unitPriceFils: 0, discountPct: 0 } : { suppliedBy: "garage" })} />
          Supplied by Fleet Fix
        </label>
      ) : fleetfix ? <Badge tone="brand">Supplied by Fleet Fix</Badge> : null}
      {line.orderStatus === "on_order" && <Badge tone="zinc">On order · {line.purchaseOrderNumber}</Badge>}
      {line.orderStatus === "received" && <Badge tone="brand">Received · {line.purchaseOrderNumber}</Badge>}
      {short && (
        <span className="inline-flex items-center gap-1 text-red-700"><TriangleAlert className="size-3" />Only {line.pickedOnHand} on the shelf — stock will go below zero</span>
      )}
      {showCost && line.costFils !== undefined && !fleetfix && (line.partId || line.poLineId) && (
        <span className="text-zinc-500">Cost {line.costFils === null ? "pending" : formatAED(line.costFils)}</span>
      )}
      {canRequest && (
        <button type="button" onClick={onRequest} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
          <PackagePlus className="size-3.5" />Request part
        </button>
      )}
    </div>
  );
}

function PaymentModal({ open, doc, onClose, onPaid }: { open: boolean; doc: DocumentFull; onClose: () => void; onPaid: (d: DocumentFull) => void }) {
  const [amount, setAmount] = useState(doc.balanceFils);
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setAmount(doc.balanceFils);
      setMethod("cash");
      setReference("");
    }
  }, [open, doc.balanceFils]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await post<{ document: DocumentFull }>(`/api/documents/${doc.id}/payments`, { amountFils: amount, method, reference });
      toast.success(res.document.status === "paid" ? `${doc.number} fully paid` : "Payment recorded");
      onPaid(res.document);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record payment — ${doc.number}`}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={amount <= 0 || amount > doc.balanceFils} onClick={() => void submit()}>Record {formatAED(amount)}</Button>
        </>
      }
    >
      <div className="mb-4 flex items-center justify-between rounded-md bg-zinc-50 px-3 py-2 text-sm">
        <span className="text-zinc-600">Balance due</span>
        <span className="tabular font-semibold">{formatAED(doc.balanceFils)}</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount (AED)">
          <MoneyInput fils={amount} onChange={setAmount} autoFocus />
        </Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>)}
          </Select>
        </Field>
        <Field label="Reference" hint="Card slip, transfer or cheque number" className="col-span-2">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      {amount > doc.balanceFils && <div className="mt-3 text-sm text-red-700">That's more than the balance due.</div>}
    </Modal>
  );
}
