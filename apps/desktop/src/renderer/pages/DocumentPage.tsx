import { ArrowLeft, ArrowRight, Banknote, CircleCheck, FileDown, Plus, Printer, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  CONVERTS_TO, DOC_LABELS, DOC_STATUSES, LINE_KINDS, PAYMENT_METHODS, STATUS_LABELS, docTotals, lineTotals, type DocType, type LineKind,
} from "@ffgp/shared";
import { CustomerPicker } from "../components/CustomerPicker";
import { CustomerFormModal } from "../components/forms";
import { Button, Card, Empty, Field, Input, Modal, MoneyInput, NumberInput, PageHeader, Select, Spinner, StatusBadge, Textarea } from "../components/ui";
import { get, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PAYMENT_LABELS, formatAED, formatDate, formatDateTime, formatKm } from "../lib/format";
import type { Customer, DocLine, DocumentFull, Vehicle } from "../lib/types";
import { useApi } from "../lib/useApi";
import { printDocument } from "../print/print";

const LIST_PATH: Record<DocType, string> = { estimate: "/estimates", jobcard: "/jobcards", invoice: "/invoices" };
const KIND_LABELS: Record<LineKind, string> = { labour: "Labour", part: "Part", other: "Other" };
const MANUAL: Record<DocType, readonly string[]> = { estimate: ["draft", "sent", "approved"], jobcard: ["open", "in_progress", "completed"], invoice: [] };

interface Draft {
  customer: { id: string; name: string } | null;
  vehicleId: string | null;
  odometer: number | null;
  notes: string;
  lines: DocLine[];
}

const blankLine = (kind: LineKind): DocLine => ({ kind, description: "", qty: 1, unitPriceFils: 0, discountPct: 0 });

export function DocumentPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { garage, can } = useAuth();
  const isNew = !params.id;
  const docQuery = useApi<{ document: DocumentFull }>(isNew ? null : `/api/documents/${params.id}`);
  const doc = docQuery.data?.document ?? null;
  const type = (doc?.type ?? params.type) as DocType;
  const label = DOC_LABELS[type] ?? "Document";

  const [draft, setDraft] = useState<Draft>({ customer: null, vehicleId: null, odometer: null, notes: "", lines: [blankLine("labour")] });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newCustomer, setNewCustomer] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  // Initialise from the loaded document, or from ?customerId= for a new one.
  useEffect(() => {
    if (doc) {
      setDraft({
        customer: { id: doc.customer.id, name: doc.customer.name },
        vehicleId: doc.vehicle?.id ?? null,
        odometer: doc.odometer,
        notes: doc.notes ?? "",
        lines: doc.lines.length ? doc.lines : doc.editable ? [blankLine("labour")] : [],
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

  const customerDetail = useApi<{ customer: Customer; vehicles: Vehicle[] }>(draft.customer ? `/api/customers/${draft.customer.id}` : null);
  const vehicles = customerDetail.data?.vehicles ?? [];

  const editable = isNew || (doc?.editable ?? false);
  const vatRate = garage?.vatRateBp ?? 500;
  const totals = useMemo(() => docTotals(draft.lines, vatRate), [draft.lines, vatRate]);

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
    const lines = cleanLines().map(({ kind, description, qty, unitPriceFils, discountPct }) => ({ kind, description: description.trim(), qty, unitPriceFils, discountPct }));
    const body = { vehicleId: draft.vehicleId, odometer: draft.odometer, notes: draft.notes, lines };
    if (isNew) {
      const res = await post<{ document: DocumentFull }>("/api/documents", { type, customerId: draft.customer!.id, ...body });
      setDirty(false);
      navigate(`/documents/${res.document.id}`, { replace: true });
      return res.document.id;
    }
    if (dirty && editable) {
      const res = await patch<{ document: DocumentFull }>(`/api/documents/${doc!.id}`, body);
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
    const res = await post<{ document: DocumentFull }>(`/api/documents/${id}/issue`);
    docQuery.setData(res);
    toast.success(`${res.document.number} issued`);
  });

  const onPrint = (mode: "pdf" | "print") => run(mode, async () => {
    const id = dirty ? await save() : doc?.id;
    if (!id || !garage) return;
    const { document } = await get<{ document: DocumentFull }>(`/api/documents/${id}`);
    docQuery.setData({ document });
    await printDocument(document, garage, mode);
  });

  if (!isNew && docQuery.error) return <Empty title="Document not found">{docQuery.error}</Empty>;
  if (!isNew && !doc) return <Spinner />;
  if (!DOC_LABELS[type]) return <Empty title="Unknown document type" />;

  const next = CONVERTS_TO[type];
  const isInvoice = type === "invoice";

  return (
    <>
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
              {doc.source && <Link className="text-brand-700 hover:underline" to={`/documents/${doc.source.id}`}>from {doc.source.number}</Link>}
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
            {doc && isInvoice && ["issued", "part_paid"].includes(doc.status) && can("payments.record") && (
              <Button variant="primary" icon={<Banknote className="size-4" />} onClick={() => setPaying(true)}>Record payment</Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-[1fr_300px] gap-5">
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
            </div>
          </Card>

          <Card
            title={type === "jobcard" ? "Work & parts" : "Items"}
            padded={false}
            actions={editable && LINE_KINDS.map((k) => (
              <Button key={k} size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => update({ lines: [...draft.lines, blankLine(k)] })}>{KIND_LABELS[k]}</Button>
            ))}
          >
            <LinesTable lines={draft.lines} editable={editable} vatRate={vatRate} onChange={updateLine} onRemove={(i) => update({ lines: draft.lines.filter((_, j) => j !== i) })} />
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

        <div className="flex flex-col gap-5">
          <Card title="Summary">
            <dl className="flex flex-col gap-2 text-sm">
              <Row label="Subtotal" value={formatAED(totals.netFils)} />
              <Row label={`VAT ${vatRate / 100}%`} value={formatAED(totals.vatFils)} />
              <div className="my-1 border-t border-dashed border-zinc-200" />
              <Row label="Total" value={formatAED(totals.grossFils)} strong />
              {isInvoice && doc && doc.status !== "draft" && (
                <>
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
      {doc && <PaymentModal open={paying} doc={doc} onClose={() => setPaying(false)} onPaid={(d) => docQuery.setData({ document: d })} />}
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

function LinesTable({ lines, editable, vatRate, onChange, onRemove }: { lines: DocLine[]; editable: boolean; vatRate: number; onChange: (i: number, l: Partial<DocLine>) => void; onRemove: (i: number) => void }) {
  if (lines.length === 0) return <Empty title="No items" />;
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="border-b border-zinc-200 bg-zinc-50/80 text-left text-xs font-medium tracking-wide text-zinc-500 uppercase">
          <th className="w-[124px] px-3 py-2 font-medium">Type</th>
          <th className="px-2 py-2 font-medium">Description</th>
          <th className="w-[64px] px-2 py-2 text-right font-medium">Qty</th>
          <th className="w-[104px] px-2 py-2 text-right font-medium">Unit price</th>
          <th className="w-[64px] px-2 py-2 text-right font-medium">Disc %</th>
          <th className="w-[70px] px-2 py-2 text-right font-medium">VAT</th>
          <th className="w-[96px] px-3 py-2 text-right font-medium">Total</th>
          {editable && <th className="w-10" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {lines.map((line, i) => {
          const t = lineTotals(line, vatRate);
          return (
            <tr key={i} className="align-middle">
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
                {editable ? (
                  <Input value={line.description} onChange={(e) => onChange(i, { description: e.target.value })} placeholder={line.kind === "labour" ? "e.g. Replace front brake pads" : line.kind === "part" ? "e.g. Brake pad set (front)" : "Description"} className="h-8" />
                ) : (
                  line.description
                )}
              </td>
              <td className="px-2 py-1.5 text-right tabular">
                {editable ? <NumberInput value={line.qty} onChange={(qty) => onChange(i, { qty })} className="h-8" aria-label="Quantity" /> : line.qty}
              </td>
              <td className="px-2 py-1.5 text-right tabular">
                {editable ? <MoneyInput fils={line.unitPriceFils} onChange={(unitPriceFils) => onChange(i, { unitPriceFils })} className="h-8" aria-label="Unit price" /> : formatAED(line.unitPriceFils).replace("AED ", "")}
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
