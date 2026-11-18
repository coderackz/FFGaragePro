import { formatAED, lineTotals } from "@ffgp/shared";
import type { DocumentFull, Garage, PurchaseOrder } from "../lib/types";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (fils: number) => formatAED(fils).replace("AED ", "");
const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso)) : "");

const TITLES = {
  estimate: { en: "ESTIMATE", ar: "عرض سعر" },
  jobcard: { en: "JOB CARD", ar: "بطاقة عمل" },
  invoice: { en: "TAX INVOICE", ar: "فاتورة ضريبية" },
} as const;

/** A4 page styles shared by every printed document. */
const PAGE_CSS = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", -apple-system, Arial, sans-serif; color: #18181b; font-size: 10.5pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { padding: 16mm 15mm 14mm; min-height: 297mm; display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12mm; padding-bottom: 6mm; border-bottom: 2.5px solid #18181b; }
  .garage h1 { margin: 0 0 2mm; font-size: 19pt; letter-spacing: -0.01em; }
  .garage div { color: #52525b; font-size: 9.5pt; line-height: 1.45; white-space: pre-line; }
  .title { text-align: right; }
  .title .en { font-size: 20pt; font-weight: 800; letter-spacing: 0.04em; }
  .title .ar { font-size: 13pt; color: #52525b; direction: rtl; margin-top: 1mm; }
  .title .num { margin-top: 3mm; font-family: Consolas, "SF Mono", monospace; font-size: 12pt; font-weight: 700; }
  .title .meta { color: #52525b; font-size: 9.5pt; margin-top: 1mm; }
  .draft { display: inline-block; margin-top: 2mm; padding: 1mm 3mm; border: 1.5px solid #b91c1c; color: #b91c1c; font-weight: 700; font-size: 9pt; letter-spacing: 0.08em; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin: 6mm 0; }
  .party { border: 1px solid #e4e4e7; border-radius: 2mm; padding: 3.5mm 4mm; }
  .party h3 { margin: 0 0 1.5mm; font-size: 8pt; letter-spacing: 0.1em; color: #71717a; text-transform: uppercase; }
  .party .main { font-weight: 700; font-size: 11pt; }
  .party .line { color: #3f3f46; font-size: 9.5pt; line-height: 1.5; white-space: pre-line; }
  .plate { font-family: Consolas, "SF Mono", monospace; font-weight: 700; font-size: 12pt; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th { background: #18181b; color: #fff; font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 2.2mm 2.5mm; text-align: left; }
  table.items td { padding: 2.4mm 2.5mm; border-bottom: 1px solid #e4e4e7; vertical-align: top; }
  table.items tr:nth-child(even) td { background: #fafafa; }
  .n { width: 8mm; color: #71717a; }
  .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .c { text-align: center; width: 16mm; }
  .b { font-weight: 700; }
  .k { color: #a1a1aa; font-size: 8pt; margin-top: 0.5mm; }
  .box { display: inline-block; width: 4mm; height: 4mm; border: 1.2px solid #52525b; border-radius: 0.6mm; }
  .bottom { display: flex; justify-content: space-between; gap: 10mm; margin-top: 5mm; }
  .notes { flex: 1; font-size: 9.5pt; color: #3f3f46; white-space: pre-line; }
  .notes h3 { margin: 0 0 1.5mm; font-size: 8pt; letter-spacing: 0.1em; color: #71717a; text-transform: uppercase; }
  table.totals { width: 78mm; border-collapse: collapse; }
  table.totals td { padding: 1.6mm 2.5mm; }
  table.totals tr.grand td { border-top: 2px solid #18181b; font-weight: 800; font-size: 12pt; padding-top: 2.4mm; }
  table.totals tr.due td { font-weight: 700; color: #b91c1c; }
  .sigs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10mm; margin-top: auto; padding-top: 18mm; font-size: 9pt; color: #52525b; }
  .sigs.two { grid-template-columns: 1fr 1fr; }
  .sigs span { display: block; border-bottom: 1px solid #a1a1aa; height: 12mm; margin-bottom: 1.5mm; }
  footer { margin-top: 6mm; padding-top: 3mm; border-top: 1px solid #e4e4e7; display: flex; justify-content: space-between; font-size: 8pt; color: #a1a1aa; }
`;

const KIND = { labour: "Labour", part: "Part", other: "Other" } as Record<string, string>;

/** Self-contained A4 HTML for one document. The garage is the seller, so its details lead the page. */
export function renderDocumentHtml(doc: DocumentFull, garage: Garage): string {
  const title = TITLES[doc.type];
  const isJob = doc.type === "jobcard";
  const isInvoice = doc.type === "invoice";
  const draftInvoice = isInvoice && doc.status === "draft";
  const docDate = isInvoice ? doc.issuedAt ?? doc.createdAt : doc.createdAt;
  const vatPct = garage.vatRateBp / 100;
  const c = doc.customer;
  const v = doc.vehicle;

  const rows = doc.lines
    .map((l, i) => {
      if (isJob) {
        return `<tr><td class="n">${i + 1}</td><td>${esc(l.description)}${l.suppliedBy === "fleetfix" ? `<div class="k">Supplied by Fleet Fix</div>` : ""}</td><td>${KIND[l.kind] ?? ""}</td><td class="r">${l.qty}</td><td class="c"><span class="box"></span></td></tr>`;
      }
      const t = lineTotals(l, garage.vatRateBp);
      return `<tr><td class="n">${i + 1}</td><td>${esc(l.description)}<div class="k">${KIND[l.kind] ?? ""}${l.suppliedBy === "fleetfix" ? " · Supplied by Fleet Fix" : ""}</div></td><td class="r">${l.qty}</td><td class="r">${money(l.unitPriceFils)}</td><td class="r">${l.discountPct ? `${l.discountPct}%` : "—"}</td><td class="r">${money(t.netFils)}</td><td class="r">${money(t.vatFils)}</td><td class="r b">${money(t.grossFils)}</td></tr>`;
    })
    .join("");

  const head = isJob
    ? `<tr><th class="n">#</th><th>Work / part</th><th>Type</th><th class="r">Qty</th><th class="c">Done</th></tr>`
    : `<tr><th class="n">#</th><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Disc.</th><th class="r">Amount</th><th class="r">VAT ${vatPct}%</th><th class="r">Total</th></tr>`;

  const totals = isJob
    ? ""
    : `<table class="totals">
        <tr><td>Subtotal (excl. VAT)</td><td class="r">${money(doc.totals.netFils)}</td></tr>
        <tr><td>VAT ${vatPct}%</td><td class="r">${money(doc.totals.vatFils)}</td></tr>
        <tr class="grand"><td>Total (AED, incl. VAT)</td><td class="r">${money(doc.totals.grossFils)}</td></tr>
        ${isInvoice && !draftInvoice && doc.paidFils > 0 ? `<tr><td>Paid</td><td class="r">${money(doc.paidFils)}</td></tr><tr class="due"><td>Balance due</td><td class="r">${money(doc.balanceFils)}</td></tr>` : ""}
      </table>`;

  const signatures = isJob
    ? `<div class="sigs"><div><span></span>Service advisor</div><div><span></span>Technician</div><div><span></span>Customer</div></div>`
    : isInvoice
      ? `<div class="sigs two"><div><span></span>Received by (customer)</div><div><span></span>For ${esc(garage.name)}</div></div>`
      : `<div class="sigs two"><div><span></span>Customer approval</div><div><span></span>For ${esc(garage.name)}</div></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(doc.number)}</title><style>${PAGE_CSS}</style></head><body><div class="page">
  <header>
    <div class="garage">
      <h1>${esc(garage.name)}</h1>
      <div>${esc([garage.address, [garage.phone, garage.email].filter(Boolean).join("  ·  ")].filter(Boolean).join("\n"))}</div>
      ${garage.trn ? `<div><b>TRN:</b> ${esc(garage.trn)}</div>` : ""}
    </div>
    <div class="title">
      <div class="en">${title.en}</div>
      <div class="ar">${title.ar}</div>
      <div class="num">${esc(doc.number)}</div>
      <div class="meta">Date: ${date(docDate)}</div>
      ${doc.source ? `<div class="meta">Ref: ${esc(doc.source.number)}</div>` : ""}
      ${draftInvoice ? `<div class="draft">DRAFT — NOT A TAX INVOICE</div>` : ""}
    </div>
  </header>
  <div class="parties">
    <div class="party">
      <h3>${isInvoice ? "Bill to" : "Customer"}</h3>
      <div class="main">${esc(c.name)}</div>
      <div class="line">${esc([c.phone, c.email, c.address].filter(Boolean).join("\n"))}</div>
      ${c.trn ? `<div class="line"><b>TRN:</b> ${esc(c.trn)}</div>` : ""}
    </div>
    <div class="party">
      <h3>Vehicle</h3>
      ${v ? `<div class="plate">${esc(v.plate)}</div><div class="line">${esc([[v.make, v.model, v.year].filter(Boolean).join(" "), v.colour, v.vin ? `VIN ${v.vin}` : null].filter(Boolean).join("\n"))}</div>` : `<div class="line">—</div>`}
      ${doc.odometer != null ? `<div class="line"><b>Odometer:</b> ${doc.odometer.toLocaleString("en-US")} km</div>` : ""}
    </div>
  </div>
  <table class="items"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="8" style="color:#a1a1aa">No items</td></tr>`}</tbody></table>
  <div class="bottom">
    <div class="notes">${doc.notes ? `<h3>Notes</h3>${esc(doc.notes)}` : ""}${doc.type === "estimate" ? `<div style="margin-top:3mm;color:#71717a">Prices in AED. Estimate valid for 14 days. Additional work found during repair will be quoted separately.</div>` : ""}</div>
    ${totals}
  </div>
  ${signatures}
  <footer><span>${esc(doc.number)} · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>
</div></body></html>`;
}

/** A4 purchase order to a supplier. Amounts are shown only when the viewer may see costs. */
export function renderPurchaseOrderHtml(po: PurchaseOrder, garage: Garage): string {
  const s = po.supplier;
  const showCost = po.netFils !== undefined;
  const vatPct = garage.vatRateBp / 100;
  const vat = showCost ? Math.round(((po.netFils ?? 0) * garage.vatRateBp) / 10000) : 0;
  const rows = po.lines
    .map((l, i) => `<tr><td class="n">${i + 1}</td><td class="mono">${esc(l.partNo ?? "")}</td><td>${esc(l.description)}${l.jobDocumentNumber ? `<div class="k">For ${esc(l.jobDocumentNumber)}</div>` : ""}</td><td class="r">${l.qty}</td>${
      showCost ? `<td class="r">${money(l.unitCostFils ?? 0)}</td><td class="r b">${money(l.netFils ?? 0)}</td>` : ""
    }</tr>`)
    .join("");
  const head = `<tr><th class="n">#</th><th>Part no</th><th>Description</th><th class="r">Qty</th>${showCost ? `<th class="r">Unit cost</th><th class="r">Amount</th>` : ""}</tr>`;
  const totals = showCost
    ? `<table class="totals">
        <tr><td>Subtotal (excl. VAT)</td><td class="r">${money(po.netFils ?? 0)}</td></tr>
        <tr><td>VAT ${vatPct}% (estimated)</td><td class="r">${money(vat)}</td></tr>
        <tr class="grand"><td>Total (AED)</td><td class="r">${money((po.netFils ?? 0) + vat)}</td></tr>
      </table>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(po.number)}</title><style>${PAGE_CSS} .mono { font-family: Consolas, "SF Mono", monospace; font-size: 9pt; }</style></head><body><div class="page">
  <header>
    <div class="garage">
      <h1>${esc(garage.name)}</h1>
      <div>${esc([garage.address, [garage.phone, garage.email].filter(Boolean).join("  ·  ")].filter(Boolean).join("\n"))}</div>
      ${garage.trn ? `<div><b>TRN:</b> ${esc(garage.trn)}</div>` : ""}
    </div>
    <div class="title">
      <div class="en">PURCHASE ORDER</div>
      <div class="ar">أمر شراء</div>
      <div class="num">${esc(po.number)}</div>
      <div class="meta">Date: ${date(po.createdAt)}</div>
    </div>
  </header>
  <div class="parties">
    <div class="party">
      <h3>Supplier</h3>
      <div class="main">${esc(s.name)}</div>
      <div class="line">${esc([s.phone, s.email, s.address].filter(Boolean).join("\n"))}</div>
      ${s.trn ? `<div class="line"><b>TRN:</b> ${esc(s.trn)}</div>` : ""}
    </div>
    <div class="party">
      <h3>Deliver to</h3>
      <div class="main">${esc(garage.name)}</div>
      <div class="line">${esc([garage.address, garage.phone].filter(Boolean).join("\n"))}</div>
    </div>
  </div>
  <table class="items"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="6" style="color:#a1a1aa">No items</td></tr>`}</tbody></table>
  <div class="bottom">
    <div class="notes">${po.notes ? `<h3>Notes</h3>${esc(po.notes)}` : ""}<div style="margin-top:3mm;color:#71717a">Please quote ${esc(po.number)} on your delivery note and invoice.</div></div>
    ${totals}
  </div>
  <div class="sigs two"><div><span></span>Ordered by</div><div><span></span>For ${esc(garage.name)}</div></div>
  <footer><span>${esc(po.number)} · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>
</div></body></html>`;
}
