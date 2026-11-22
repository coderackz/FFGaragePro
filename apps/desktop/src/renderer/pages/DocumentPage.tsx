import { ArrowLeft, ArrowRight, Banknote, CircleCheck, FileDown, FileMinus, Plus, Printer, Save, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  CONVERTS_TO, DEFAULT_SETTINGS, DOC_LABELS, DOC_STATUSES, LINE_KINDS, PAYMENT_METHODS, STATUS_LABELS, docTotals, promoShares, type DocType, type LineKind,
} from "@ffgp/shared";
import { CustomerPicker } from "../components/CustomerPicker";
import { CustomerFormModal } from "../components/forms";
import { RequestPartDialog } from "../components/RequestPartDialog";
import { Badge, Button, Card, Empty, Field, Input, Modal, MoneyInput, PageHeader, Select, Spinner, StatusBadge, Textarea } from "../components/ui";
import { del, get, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PAYMENT_LABELS, formatAED, formatDate, formatDateTime, formatKm } from "../lib/format";
import type { Customer, DocLine, DocumentFull, Vehicle } from "../lib/types";
import { useApi } from "../lib/useApi";
import { CreditNoteDialog } from "../components/CreditNoteDialog";
import { KIND_LABELS, LinesTable } from "../components/document/LinesTable";
import { useOwnerApproval } from "../components/OwnerApproval";
import { printDocument } from "../print/print";
import { MessageLog } from "../components/MessageLog";
import { afterAction, askToSend, documentRequest, receiptRequest } from "../messages/triggers";
import type { MessageEvent } from "@ffgp/shared";
import type { Message, Receipt } from "../lib/types";

const LIST_PATH: Record<DocType, string> = { estimate: "/estimates", jobcard: "/jobcards", invoice: "/invoices", credit_note: "/credit-notes" };
const MANUAL: Record<DocType, readonly string[]> = { estimate: ["draft", "sent", "approved"], jobcard: ["open", "in_progress", "completed"], invoice: [], credit_note: [] };

interface Draft {
  customer: { id: string; name: string } | null;
  vehicleId: string | null;
  odometer: number | null;
  notes: string;
  lines: DocLine[];
  /** Invoices: the customer's LPO number. */
  lpoNumber: string;
  /** What it prints in (from the customer when it was created; can change while editable). */
  language: "en" | "en_ar";
  /** Job cards: the driver who gets "vehicle received/ready" messages. */
  driverName: string;
  driverPhone: string;
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

  const [draft, setDraft] = useState<Draft>({ customer: null, vehicleId: null, odometer: null, notes: "", lines: [blankLine("labour", settings?.pricing.labourRateFils)], lpoNumber: "", language: "en", driverName: "", driverPhone: "" });
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
        language: doc.language ?? "en",
        driverName: doc.driverName ?? "",
        driverPhone: doc.driverPhone ?? "",
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
  // A promo code on the document: its discount spread over the lines it applies to, before VAT (as the server does).
  const promo = doc?.promo ?? null;
  const promoLines = useMemo(() => {
    if (!promo || type === "credit_note") return draft.lines;
    const charged = draft.lines.map((l) => (l.suppliedBy === "fleetfix" ? { ...l, unitPriceFils: 0, discountPct: 0 } : l));
    const { shares } = promoShares(charged, promo, includeVat);
    return charged.map((l, i) => ({ ...l, promoFils: shares[i] ?? 0 }));
  }, [draft.lines, promo, includeVat, type]);
  const promoFils = promo ? promoLines.reduce((s, l) => s + (l.promoFils ?? 0), 0) : 0;
  // A credit note's lines keep the amounts they were credited at (a promo line's discounted ones): the server's totals.
  const totals = useMemo(
    () => (doc && type === "credit_note" ? doc.totals : docTotals(promoLines, vatRate, includeVat)),
    [doc, type, promoLines, vatRate, includeVat],
  );
  const [promoCode, setPromoCode] = useState("");

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
    const lines = cleanLines().map(({ kind, description, qty, unitPriceFils, discountPct, partId, suppliedBy, poLineId, unitIds }) => ({
      kind, description: description.trim(), qty, unitPriceFils, discountPct,
      partId: kind === "part" ? partId ?? null : null, suppliedBy: kind === "part" ? suppliedBy ?? "garage" : "garage", poLineId: poLineId ?? null,
      // More tyres picked than the quantity (it was lowered): the first ones picked are kept.
      unitIds: kind === "part" && partId && (suppliedBy ?? "garage") === "garage" ? (unitIds ?? []).slice(0, Math.max(0, Math.floor(qty))) : [],
    }));
    const body = { vehicleId: draft.vehicleId, odometer: draft.odometer, notes: draft.notes, lines, ...(type === "invoice" && !isNew ? { lpoNumber: draft.lpoNumber } : {}),
      ...(!isNew && draft.language !== doc?.language ? { language: draft.language } : {}),
      ...(type === "jobcard" ? { driverName: draft.driverName, driverPhone: draft.driverPhone } : {}) };
    if (isNew) {
      const res = await approval.withApproval((a) => post<{ document: DocumentFull; warning?: string }>("/api/documents", { type, customerId: draft.customer!.id, ...body, approval: a }));
      if (res.warning) toast.warning(res.warning);
      setDirty(false);
      navigate(`/documents/${res.document.id}`, { replace: true });
      if (res.document.type === "jobcard") message("vehicle_received", res.document);
      return res.document.id;
    }
    if (dirty && editable) {
      const res = await approval.withApproval((a) => patch<{ document: DocumentFull }>(`/api/documents/${doc!.id}`, { ...body, approval: a }));
      docQuery.setData(res);
    }
    setDirty(false);
    return doc!.id;
  };

  /** The event's message, if it's on (Settings → Messages): sent automatically or the Send dialog opens. */
  const message = (event: MessageEvent, d: DocumentFull) => {
    if (garage) void afterAction(documentRequest(event, d, garage, settings ?? DEFAULT_SETTINGS), settings ?? DEFAULT_SETTINGS);
  };

  /** A payment was just recorded: its receipt's message. */
  const paymentMessage = async (d: DocumentFull) => {
    const receiptId = d.payments.at(-1)?.receiptId;
    if (!receiptId || !garage) return;
    const { receipt } = await get<{ receipt: Receipt }>(`/api/receipts/${receiptId}`);
    await afterAction(receiptRequest(receipt, garage, settings ?? DEFAULT_SETTINGS), settings ?? DEFAULT_SETTINGS);
  };

  /** Send on the page: the message that fits the document now (an estimate sent before becomes "extra work"). */
  const onSend = () => run("send", async () => {
    const id = dirty ? await save() : doc?.id;
    if (!id || !garage) return;
    const { document } = await get<{ document: DocumentFull }>(`/api/documents/${id}`);
    docQuery.setData({ document });
    let event: MessageEvent = "invoice_issued";
    if (document.type === "estimate") {
      const { messages } = await get<{ messages: Message[] }>(`/api/messages?documentId=${id}`);
      const before = messages.some((m) => (m.event === "estimate_ready" || m.event === "estimate_resent") && m.status !== "failed");
      event = before ? "estimate_resent" : "estimate_ready";
    } else if (document.type === "jobcard") {
      event = document.status === "completed" ? "vehicle_ready" : "vehicle_received";
    }
    askToSend(documentRequest(event, document, garage, settings ?? DEFAULT_SETTINGS, true));
  });

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
    if (res.document.type === "jobcard" && status === "completed" && doc!.status !== "completed") message("vehicle_ready", res.document);
  });

  const onConvert = () => run("convert", async () => {
    const id = await save();
    if (!id) return;
    const res = await approval.withApproval((a) => post<{ document: DocumentFull; warning?: string }>(`/api/documents/${id}/convert`, { approval: a }));
    toast.success(`${res.document.number} created`);
    if (res.warning) toast.warning(res.warning);
    navigate(`/documents/${res.document.id}`);
    if (res.document.type === "jobcard") message("vehicle_received", res.document);
  });

  const onIssue = () => run("issue", async () => {
    const id = await save();
    if (!id) return;
    if (!window.confirm("Issue this tax invoice? After issuing, it can no longer be edited.")) return;
    // Over the customer's credit limit: a warning, a refusal, or the Owner's approval (Settings → Customers & credit).
    const issue = (a: unknown, promoOverride?: boolean) => post<{ document: DocumentFull; warning?: string }>(`/api/documents/${id}/issue`, { approval: a, promoOverride });
    // Asked once: the credit-limit approval may run this again, with the answer kept.
    let promoOverride = false;
    const res = await approval.withApproval(async (a) => {
      if (promoOverride) return issue(a, true);
      try {
        return await issue(a);
      } catch (err) {
        // The promo code expired or was used up since it was applied: the Owner can issue it anyway (it's logged).
        const msg = (err as Error).message;
        if (!msg.startsWith("Promo ") || !can("credit.override") || !window.confirm(`${msg}. Issue it with the discount anyway? This is recorded in the activity log.`)) throw err;
        promoOverride = true;
        return issue(a, true);
      }
    });
    docQuery.setData({ document: res.document });
    toast.success(`${res.document.number} issued`);
    if (res.warning) toast.warning(res.warning);
    message("invoice_issued", res.document);
  });

  const onApplyPromo = () => run("promo", async () => {
    const id = await save();
    if (!id || !promoCode.trim()) return;
    const { document } = await post<{ document: DocumentFull }>(`/api/documents/${id}/promo`, { code: promoCode.trim() });
    docQuery.setData({ document });
    setPromoCode("");
    toast.success(`Promo ${document.promo?.code} applied`);
  });
  const onRemovePromo = () => run("promo", async () => {
    const id = await save();
    if (!id) return;
    const { document } = await del<{ document: DocumentFull }>(`/api/documents/${id}/promo`);
    docQuery.setData({ document });
  });

  /** A payment put against this invoice by mistake: taken back off, so it becomes the customer's credit again. */
  const onUndo = (receiptId: string, amountFils: number, key: string) => run(`undo-${key}`, async () => {
    if (!window.confirm(`Take ${formatAED(amountFils)} back off ${doc!.number}? It becomes the customer's credit, to use on another invoice or refund.`)) return;
    await post(`/api/receipts/${receiptId}/allocations`, { allocations: [{ documentId: doc!.id, amountFils: -amountFils }] });
    const { document } = await get<{ document: DocumentFull }>(`/api/documents/${doc!.id}`);
    docQuery.setData({ document });
    toast.success("Payment taken back off — it's now the customer's credit");
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
  if (isNew && type === "credit_note") return <Empty title="Credit notes are made from an invoice">Open the issued invoice and choose “Credit note”.</Empty>;

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
                {type !== "credit_note" && !(isInvoice && doc.status === "draft") && (
                  <Button icon={<Send className="size-4" />} busy={busy === "send"} onClick={onSend}>Send</Button>
                )}
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
              {type === "jobcard" && (
                <>
                  <Field label="Driver name" hint="Gets the vehicle received / ready messages">
                    <Input value={draft.driverName} disabled={!editable} onChange={(e) => update({ driverName: e.target.value })} aria-label="Driver name" />
                  </Field>
                  <Field label="Driver phone">
                    <Input value={draft.driverPhone} disabled={!editable} onChange={(e) => update({ driverPhone: e.target.value })} aria-label="Driver phone" placeholder="050 123 4567" />
                  </Field>
                </>
              )}
              {isInvoice && (doc || isNew) && (
                <Field label="LPO number" hint={customerDetail.data?.customer.lpoRequired ? "This customer needs one before the invoice is issued" : "The customer's purchase order, if any"}>
                  <Input value={draft.lpoNumber} disabled={!editable || isNew} onChange={(e) => update({ lpoNumber: e.target.value })} placeholder={isNew ? "Save first" : ""} aria-label="LPO number" />
                </Field>
              )}
              {doc && editable && (
                <Field label="Document language" hint="Copied from the customer when it was made">
                  <Select value={draft.language} onChange={(e) => update({ language: e.target.value as Draft["language"] })} aria-label="Document language">
                    <option value="en">English</option>
                    <option value="en_ar">English + Arabic</option>
                  </Select>
                </Field>
              )}
              {doc && !editable && doc.language === "en_ar" && (
                <div className="flex items-end pb-2"><span data-testid="doc-language"><Badge tone="zinc">English + Arabic</Badge></span></div>
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
              type={type} vehicleId={draft.vehicleId} lines={draft.lines} promoFils={promo && type !== "credit_note" ? promoLines.map((l) => l.promoFils ?? 0) : undefined} editable={editable} vatRate={vatRate} includeVat={includeVat} onChange={updateLine}
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
            <dl className="flex flex-col gap-2 text-sm" data-testid="doc-summary">
              {promo && promoFils > 0 && (
                <div className="flex items-baseline justify-between gap-3 text-emerald-700">
                  <dt className="min-w-0">
                    Promo <span className="font-mono">{promo.code}</span>
                    {editable && <button type="button" className="ml-2 text-xs text-zinc-500 underline hover:text-zinc-800 disabled:opacity-50" disabled={busy === "promo"} onClick={onRemovePromo}>Remove</button>}
                  </dt>
                  <dd className="whitespace-nowrap tabular">−{formatAED(promoFils)}</dd>
                </div>
              )}
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
            {editable && !isNew && type !== "credit_note" && !promo && (
              <div className="mt-3 flex items-center gap-2 border-t border-zinc-100 pt-3">
                <Input className="font-mono uppercase" value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === "Enter") onApplyPromo(); }} placeholder="Promo code" aria-label="Promo code" />
                <Button size="sm" busy={busy === "promo"} disabled={!promoCode.trim()} onClick={onApplyPromo}>Apply</Button>
              </div>
            )}
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
                  {doc.payments.map((p) => {
                    // What this receipt still has on this invoice (after any earlier undo).
                    const onIt = doc.payments.filter((x) => x.receiptId === p.receiptId).reduce((s, x) => s + x.amountFils, 0);
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                        <div className="min-w-0">
                          <div className="font-medium">{p.receiptNumber ? `${p.receiptNumber} · ` : ""}{PAYMENT_LABELS[p.method] ?? p.method}{p.reference ? ` · ${p.reference}` : ""}</div>
                          <div className="text-xs text-zinc-500">{formatDate(p.paidAt)}{p.createdBy ? ` · ${p.createdBy}` : ""}{p.amountFils < 0 ? " · taken back off" : ""}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="tabular font-medium">{formatAED(p.amountFils)}</span>
                          {p.amountFils > 0 && onIt > 0 && p.receiptId && can("payments.record") && (
                            <Button size="sm" variant="ghost" busy={busy === `undo-${p.id}`} onClick={() => onUndo(p.receiptId!, Math.min(p.amountFils, onIt), p.id)} aria-label={`Undo ${p.receiptNumber ?? "payment"}`}>Undo</Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
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
      {doc && (
        <Card title="Messages" className="mt-5" padded={false}>
          <MessageLog documentId={doc.id} />
        </Card>
      )}
      {doc && <PaymentModal open={paying} doc={doc} onClose={() => setPaying(false)} onPaid={(d) => { docQuery.setData({ document: d }); void paymentMessage(d); }} />}
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
