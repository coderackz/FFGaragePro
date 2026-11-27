import { amountInWords, dubaiDate, formatAED, lineTotals, usedPartText, type Settings } from "@ffgp/shared";
import type { AgingBucket, DocumentFull, Garage, PurchaseOrder, Receipt, Statement } from "../lib/types";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (fils: number) => formatAED(fils).replace("AED ", "");
const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso)) : "");

const TITLES = {
  estimate: { en: "ESTIMATE" },
  jobcard: { en: "JOB CARD" },
  invoice: { en: "TAX INVOICE" },
  credit_note: { en: "TAX CREDIT NOTE" },
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
  .d { color: #52525b; font-size: 8.5pt; margin-top: 0.6mm; white-space: normal; }
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
  .brand { display: flex; gap: 5mm; align-items: flex-start; }
  img.logo { max-height: 22mm; max-width: 45mm; object-fit: contain; }
  header.lh { justify-content: flex-end; border-bottom: 0; padding-bottom: 2mm; }
  .terms { margin-top: 5mm; font-size: 8.5pt; color: #3f3f46; white-space: pre-line; }
  .terms .bank { font-weight: 600; color: #18181b; margin-bottom: 1mm; }
  .warranty { margin-top: 3mm; font-size: 9pt; color: #3f3f46; }
  .sigimg { height: 12mm; display: flex; align-items: flex-end; gap: 3mm; margin-bottom: -12mm; }
  .sigimg + span { border-bottom: 1px solid #a1a1aa; }
  img.stamp { max-height: 26mm; max-width: 30mm; object-fit: contain; opacity: 0.9; transform: translateY(-8mm); }
  img.signature { max-height: 13mm; max-width: 40mm; object-fit: contain; }
  .auth { margin-top: auto; padding-top: 10mm; font-size: 9.5pt; color: #18181b; }
  .auth + .sigs { margin-top: 0; padding-top: 8mm; }
  .wm { position: fixed; top: 42%; left: 0; right: 0; text-align: center; transform: rotate(-24deg); pointer-events: none; }
  .wm span { display: block; font-size: 72pt; font-weight: 800; letter-spacing: 0.1em; color: rgba(185, 28, 28, 0.13); line-height: 1.1; }
`;

/** Garage block for the top of a page: logo and details, or a blank space on letterhead paper. */
function garageHeader(garage: Garage, settings: Settings, title: string): string {
  const d = settings.documents;
  const g = settings.garage;
  if (d.paper === "letterhead") {
    return `<div class="letterhead" style="height:${d.letterheadTopMm}mm"></div><header class="lh">${title}</header>`;
  }
  return `<header>
    <div class="brand">
      ${d.logo ? `<img class="logo" src="${esc(d.logo)}" alt="">` : ""}
      <div class="garage">
        <h1>${esc(garage.name)}</h1>
        <div>${esc([garage.address, [garage.phone, garage.email].filter(Boolean).join("  ·  ")].filter(Boolean).join("\n"))}</div>
        ${garage.trn ? `<div><b>TRN:</b> ${esc(garage.trn)}</div>` : ""}
        ${g.tradeLicence ? `<div><b>Trade licence:</b> ${esc(g.tradeLicence)}</div>` : ""}
      </div>
    </div>
    ${title}
  </header>`;
}

/** "For {garage}" signature cell, with the stamp and signature images above the line when set. */
function garageSignature(garage: Garage, settings: Settings): string {
  const { stamp, signature } = settings.documents;
  const images = stamp || signature
    ? `<div class="sigimg">${signature ? `<img class="signature" src="${esc(signature)}" alt="">` : ""}${stamp ? `<img class="stamp" src="${esc(stamp)}" alt="">` : ""}</div>`
    : "";
  return `<div>${images}<span></span>For ${esc(garage.name)}</div>`;
}

/** The amount in words. */
function wordsBlock(fils: number): string {
  return `<div class="words"><b>Amount in words:</b> ${esc(amountInWords(fils))}</div>`;
}

/** The page head: shared styles. */
const headCss = (extra = "") => `<style>${PAGE_CSS}${extra}</style>`;

const KIND = { labour: "Labour", part: "Part", other: "Other" } as Record<string, string>;
/** How an estimate was approved, as printed. */
const APPROVED_VIA: Record<string, string> = { phone: "by phone", in_person: "in person", signed: "signed copy", reply: "by WhatsApp / email reply" };

/** Self-contained A4 HTML for one document. The garage is the seller, so its details lead the page. */
/**
 * A line's amounts as shown: a credit note's lines keep what they were credited at (a promo line's discounted
 * amounts, in proportion), so its stored figures are shown; other documents work them out (with any promo share).
 */
export function shownLineTotals(doc: Pick<DocumentFull, "type" | "pricesIncludeVat">, l: DocumentFull["lines"][number], vatRateBp: number) {
  // Declined by the client: counts nothing.
  if (l.declined) return { netFils: 0, vatFils: 0, grossFils: 0 };
  if (doc.type === "credit_note" && l.netFils !== undefined && l.vatFils !== undefined && l.grossFils !== undefined) {
    return { netFils: l.netFils, vatFils: l.vatFils, grossFils: l.grossFils };
  }
  return lineTotals(l, vatRateBp, doc.pricesIncludeVat);
}

export function renderDocumentHtml(doc: DocumentFull, garage: Garage, settings: Settings, opts: { copy?: boolean } = {}): string {
  const title = TITLES[doc.type];
  const ds = settings.documents;
  const gs = settings.garage;
  const isJob = doc.type === "jobcard";
  const isInvoice = doc.type === "invoice";
  const isCredit = doc.type === "credit_note";
  const draftInvoice = isInvoice && doc.status === "draft";
  const docDate = isInvoice || isCredit ? doc.issuedAt ?? doc.createdAt : doc.createdAt;
  const vatPct = garage.vatRateBp / 100;
  const c = doc.customer;
  const v = doc.vehicle;
  const t = (en: string) => en;
  const h = (en: string) => en;

  const partNo = (l: DocumentFull["lines"][number]) => (ds.showPartNumbers && l.partNo ? `Part no. ${esc(l.partNo)}` : "");
  // Tyres and batteries: each one's DOT, or serial and the warranty's end.
  const units = (l: DocumentFull["lines"][number]) =>
    (l.units ?? []).map((u) => (u.kind === "dot" ? `DOT ${esc(u.code)}` : `Serial ${esc(u.code)}${u.warrantyEnds ? ` · warranty to ${date(u.warrantyEnds)}` : ""}`)).join(", ");
  // A used part always says so; an invoice with its warranty, as it stood the day it was issued (a draft: today).
  const usedOn = dubaiDate(isInvoice && doc.issuedAt ? doc.issuedAt : new Date().toISOString());
  const used = (l: DocumentFull["lines"][number]) =>
    usedPartText({ condition: l.condition ?? "new", purchasedOn: l.purchasedOn ?? null, warrantyDays: l.warrantyDays ?? null }, doc.type, usedOn);
  // A line's unit beside its quantity ("2 Pc", "1.5 Hr"); without one, labour shows hours as before.
  const qty = (l: DocumentFull["lines"][number]) => (l.unit ? `${l.qty} ${esc(l.unit)}` : ds.showLabourHours && l.kind === "labour" ? `${l.qty} h` : `${l.qty}`);
  // Labour and other lines: the work in detail under the title, line breaks kept.
  const details = (l: DocumentFull["lines"][number]) => (l.details ? `<div class="d">${esc(l.details).replace(/\n/g, "<br>")}</div>` : "");
  // Each line's share of the overall discount, or of the promo code.
  const shareLabel = doc.discount?.applied ? "Discount" : "Promo";
  const rows = doc.lines
    .map((l, i) => {
      if (isJob) {
        const notes = [partNo(l), units(l), used(l) ?? "", l.suppliedBy === "fleetfix" ? "Supplied by Fleet Fix" : ""].filter(Boolean).join(" · ");
        return `<tr><td class="n">${i + 1}</td><td>${esc(l.description)}${details(l)}${notes ? `<div class="k">${notes}</div>` : ""}</td><td>${KIND[l.kind] ?? ""}</td><td class="r">${qty(l)}</td><td class="c"><span class="box"></span></td></tr>`;
      }
      const t = shownLineTotals(doc, l, garage.vatRateBp);
      const notes = [KIND[l.kind] ?? "", partNo(l), units(l), used(l) ?? "", l.suppliedBy === "fleetfix" ? "Supplied by Fleet Fix" : "", l.declined ? "<b>Declined</b>" : ""].filter(Boolean).join(" · ");
      // Declined by the client: listed with its price, struck through, counting nothing.
      if (l.declined) {
        return `<tr style="color:#a1a1aa"><td class="n">${i + 1}</td><td><s>${esc(l.description)}</s>${details(l)}<div class="k">${notes}</div></td><td class="r">${qty(l)}</td><td class="r"><s>${money(l.unitPriceFils)}</s></td><td class="r">—</td><td class="r">—</td><td class="r">—</td><td class="r">—</td></tr>`;
      }
      return `<tr><td class="n">${i + 1}</td><td>${esc(l.description)}${details(l)}<div class="k">${notes}</div></td><td class="r">${qty(l)}</td><td class="r">${money(l.unitPriceFils)}</td><td class="r">${l.discountPct ? `${l.discountPct}%` : l.promoFils ? "" : "—"}${l.promoFils ? `<div class="k">${shareLabel} −${money(l.promoFils)}</div>` : ""}</td><td class="r">${money(t.netFils)}</td><td class="r">${money(t.vatFils)}</td><td class="r b">${money(t.grossFils)}</td></tr>`;
    })
    .join("");

  const head = isJob
    ? `<tr><th class="n">#</th><th>${h("Work / part")}</th><th>${h("Type")}</th><th class="r">${h("Qty")}</th><th class="c">${h("Done")}</th></tr>`
    : `<tr><th class="n">#</th><th>${h("Description")}</th><th class="r">${h("Qty")}</th><th class="r">${h(doc.pricesIncludeVat ? "Unit price (incl. VAT)" : "Unit price")}</th><th class="r">${h("Disc.")}</th><th class="r">${h("Amount")}</th><th class="r">VAT ${vatPct}%</th><th class="r">${h("Total")}</th></tr>`;

  const totals = isJob
    ? ""
    : `<table class="totals">
        ${doc.discount?.applied && doc.discount.discountFils > 0 ? `<tr><td>${t("Discount")}${doc.discount.kind === "percent" ? ` ${doc.discount.value}%` : ""}</td><td class="r">−${money(doc.discount.discountFils)}</td></tr>` : ""}
        ${doc.promo && doc.promo.discountFils > 0 ? `<tr><td>${t("Promo discount")} ${esc(doc.promo.code)} (${doc.promo.kind === "percent" ? `${doc.promo.value}%` : money(doc.promo.value)}${doc.promo.appliesTo === "all" ? "" : ` ${doc.promo.appliesTo}`})</td><td class="r">−${money(doc.promo.discountFils)}</td></tr>` : ""}
        <tr><td>${t("Subtotal (excl. VAT)")}</td><td class="r">${money(doc.totals.netFils)}</td></tr>
        <tr><td>${`VAT ${vatPct}%`}</td><td class="r">${money(doc.totals.vatFils)}</td></tr>
        <tr class="grand"><td>${t(isCredit ? "Total credit (AED, incl. VAT)" : "Total (AED, incl. VAT)")}</td><td class="r">${money(doc.totals.grossFils)}</td></tr>
        ${isInvoice && !draftInvoice && (doc.creditedFils ?? 0) > 0 ? `<tr><td>${t("Credited")}</td><td class="r">${money(doc.creditedFils ?? 0)}</td></tr>` : ""}
        ${isInvoice && !draftInvoice && doc.paidFils > 0 ? `<tr><td>${t("Paid")}</td><td class="r">${money(doc.paidFils)}</td></tr>` : ""}
        ${isInvoice && !draftInvoice && (doc.paidFils > 0 || (doc.creditedFils ?? 0) > 0) ? `<tr class="due"><td>${t("Balance due")}</td><td class="r">${money(Math.max(doc.balanceFils, 0))}</td></tr>` : ""}
      </table>`;

  const signatures = isJob
    ? `${ds.jobCardSignature ? `<div class="auth"><b>I authorise the work above</b> and agree to pay for it on collection.</div>` : ""}<div class="sigs"><div><span></span>${t("Service advisor")}</div><div><span></span>${t("Technician")}</div><div><span></span>${t("Customer")}</div></div>`
    : isInvoice || isCredit
      ? `<div class="sigs two"><div><span></span>${t("Received by (customer)")}</div>${garageSignature(garage, settings)}</div>`
      : `<div class="sigs two"><div><span></span>${t("Customer approval")}</div>${garageSignature(garage, settings)}</div>`;
  const bank = [gs.bankName, gs.accountName, gs.iban ? `IBAN ${gs.iban}` : null].filter(Boolean).join("  ·  ");
  const terms = isInvoice && (bank || ds.terms)
    ? `<div class="terms">${bank ? `<div class="bank">${esc(bank)}</div>` : ""}${ds.terms ? esc(ds.terms) : ""}</div>`
    : "";
  const words = isInvoice || isCredit ? wordsBlock(doc.totals.grossFils) : "";
  const issued = isInvoice && !draftInvoice;
  const fullyCredited = issued && (doc.creditedFils ?? 0) >= doc.totals.grossFils && doc.totals.grossFils > 0;
  const marks = [
    fullyCredited ? "CREDITED" : doc.status === "paid" && issued && doc.paidFils > 0 ? "PAID" : null,
    opts.copy && (issued || isCredit) ? "COPY" : null,
  ].filter(Boolean);
  const watermark = marks.length ? `<div class="wm">${marks.map((m) => `<span>${m}</span>`).join("")}</div>` : "";
  const titleHtml = `<div class="title">
      <div class="en">${title.en}</div>
      <div class="num">${esc(doc.number)}</div>
      <div class="meta">${t("Date")}: ${date(docDate)}</div>
      ${isCredit && doc.source ? `<div class="meta">Credit for ${esc(doc.source.number)}${doc.source.issuedAt ? ` of ${date(doc.source.issuedAt)}` : ""}</div>` : doc.source ? `<div class="meta">Ref: ${esc(doc.source.number)}</div>` : ""}
      ${isInvoice && doc.dueDate ? `<div class="meta">${t("Due")}: ${date(`${doc.dueDate}T00:00:00.000Z`)}</div>` : ""}
      ${isInvoice && doc.lpoNumber ? `<div class="meta">${t("LPO")}: ${esc(doc.lpoNumber)}</div>` : ""}
      ${draftInvoice ? `<div class="draft">DRAFT — NOT A TAX INVOICE</div>` : ""}
    </div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(doc.number)}</title>${headCss()}</head><body><div class="page">
  ${watermark}
  ${garageHeader(garage, settings, titleHtml)}
  <div class="parties">
    <div class="party">
      <h3>${t(isInvoice ? "Bill to" : "Customer")}</h3>
      <div class="main">${esc(c.name)}</div>
      
      <div class="line">${esc([c.phone, c.email, c.address].filter(Boolean).join("\n"))}</div>
      
      ${c.trn ? `<div class="line"><b>${t("TRN")}:</b> ${esc(c.trn)}</div>` : ""}
    </div>
    <div class="party">
      <h3>${t("Vehicle")}</h3>
      ${v ? `<div class="plate">${esc(v.plate)}</div><div class="line">${esc([[v.make, v.model, v.year].filter(Boolean).join(" "), v.colour, v.vin ? `VIN ${v.vin}` : null].filter(Boolean).join("\n"))}</div>` : `<div class="line">—</div>`}
      ${doc.odometer != null ? `<div class="line"><b>${t("Odometer")}:</b> ${doc.odometer.toLocaleString("en-US")} km</div>` : ""}
    </div>
  </div>
  <table class="items"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="8" style="color:#a1a1aa">No items</td></tr>`}</tbody></table>
  <div class="bottom">
    <div class="notes">${isCredit && doc.reason ? `<h3>${t("Reason")}</h3>${esc(doc.reason)}` : ""}${doc.notes ? `<h3>${t("Notes")}</h3>${esc(doc.notes)}` : ""}${doc.type === "estimate" ? `<div style="margin-top:3mm;color:#71717a">Prices in AED. Estimate valid for ${ds.estimateValidDays} days. Additional work found during repair will be quoted separately.</div>` : ""}${doc.type === "estimate" && doc.approval ? `<div style="margin-top:2mm"><b>Approved</b> ${esc([doc.approval.byName, APPROVED_VIA[doc.approval.via] ?? null, date(doc.approval.at)].filter(Boolean).join(" · "))}</div>` : ""}${isInvoice && ds.warranty ? `<div class="warranty"><b>${t("Warranty")}:</b> ${esc(ds.warranty)}</div>` : ""}${words}</div>
    ${totals}
  </div>
  ${terms}
  ${signatures}
  <footer><span>${esc(doc.number)} · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>
</div></body></html>`;
}

/** A4 purchase order to a supplier. Amounts are shown only when the viewer may see costs. */
export function renderPurchaseOrderHtml(po: PurchaseOrder, garage: Garage, settings: Settings): string {
  const s = po.supplier;
  const showCost = po.netFils !== undefined;
  const vatPct = garage.vatRateBp / 100;
  const vat = showCost ? Math.round(((po.netFils ?? 0) * garage.vatRateBp) / 10000) : 0;
  const rows = po.lines
    .map((l, i) => {
      // Bought in packs: the quantity and cost read per pack ("2 × Drum 208 L" at the drum's price).
      const packs = l.packName && l.packSize ? Math.round(l.qty / l.packSize) : null;
      const qty = packs !== null ? `${packs} × ${esc(l.packName!)}` : `${l.qty}`;
      const unit = packs !== null ? l.packCostFils ?? Math.round((l.unitCostFils ?? 0) * l.packSize!) : l.unitCostFils ?? 0;
      return `<tr><td class="n">${i + 1}</td><td class="mono">${esc(l.partNo ?? "")}</td><td>${esc(l.description)}${l.jobDocumentNumber ? `<div class="k">For ${esc(l.jobDocumentNumber)}</div>` : ""}</td><td class="r">${qty}</td>${
        showCost ? `<td class="r">${money(unit)}</td><td class="r b">${money(l.netFils ?? 0)}</td>` : ""
      }</tr>`;
    })
    .join("");
  const head = `<tr><th class="n">#</th><th>Part no</th><th>Description</th><th class="r">Qty</th>${showCost ? `<th class="r">Unit cost</th><th class="r">Amount</th>` : ""}</tr>`;
  const totals = showCost
    ? `<table class="totals">
        <tr><td>Subtotal (excl. VAT)</td><td class="r">${money(po.netFils ?? 0)}</td></tr>
        <tr><td>VAT ${vatPct}% (estimated)</td><td class="r">${money(vat)}</td></tr>
        <tr class="grand"><td>Total (AED)</td><td class="r">${money((po.netFils ?? 0) + vat)}</td></tr>
      </table>`
    : "";
  const titleHtml = `<div class="title">
      <div class="en">PURCHASE ORDER</div>
      <div class="num">${esc(po.number)}</div>
      <div class="meta">Date: ${date(po.createdAt)}</div>
    </div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(po.number)}</title><style>${PAGE_CSS} .mono { font-family: Consolas, "SF Mono", monospace; font-size: 9pt; }</style></head><body><div class="page">
  ${garageHeader(garage, settings, titleHtml)}
  <div class="parties">
    <div class="party">
      <h3>Supplier</h3>
      <div class="main">${esc(s?.name ?? "Not chosen yet")}</div>
      ${s ? `<div class="line">${esc([s.phone, s.email, s.address].filter(Boolean).join("\n"))}</div>` : ""}
      ${s?.trn ? `<div class="line"><b>TRN:</b> ${esc(s.trn)}</div>` : ""}
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
  <div class="sigs two"><div><span></span>Ordered by</div>${garageSignature(garage, settings)}</div>
  <footer><span>${esc(po.number)} · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>
</div></body></html>`;
}


/** A vehicle as a vendor sees it: make, model, year and engine; never the customer or the plate. */
export const vendorVehicle = (v: NonNullable<NonNullable<PurchaseOrder["job"]>["vehicle"]>) =>
  [[v.make, v.model, v.year].filter(Boolean).join(" "), v.engine].filter(Boolean).join(" · ");

/**
 * "Request for prices" sent to vendors: the parts and quantities, the vehicle and its VIN, and the Mulkiya photos
 * when the buyer chose to attach them. No customer, no plate, no prices.
 */
export function renderPriceRequestHtml(po: PurchaseOrder, garage: Garage, settings: Settings, photos: { label: string; base64: string }[] = []): string {
  const v = po.job?.vehicle ?? null;
  const rows = po.lines
    .map((l, i) => `<tr><td class="n">${i + 1}</td><td class="mono">${esc(l.partNo ?? "")}</td><td>${esc(l.description)}</td><td class="r">${l.qty}</td><td class="r"></td><td class="r"></td></tr>`)
    .join("");
  const titleHtml = `<div class="title">
      <div class="en">REQUEST FOR PRICES</div>
      <div class="num">${esc(po.number)}</div>
      <div class="meta">Date: ${date(new Date().toISOString())}</div>
    </div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(po.number)}</title><style>${PAGE_CSS} .mono { font-family: Consolas, "SF Mono", monospace; font-size: 9pt; }
    .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; margin-top: 6mm; } .photos img { width: 100%; border: 1px solid #e4e4e7; border-radius: 2mm; } .photos div { font-size: 8.5pt; color: #52525b; }</style></head><body><div class="page">
  ${garageHeader(garage, settings, titleHtml)}
  <div class="parties">
    <div class="party">
      <h3>Vehicle</h3>
      <div class="main">${esc(v ? vendorVehicle(v) || "—" : "—")}</div>
      ${v?.vin ? `<div class="line"><b>VIN:</b> <span class="mono">${esc(v.vin)}</span></div>` : ""}
    </div>
    <div class="party">
      <h3>From</h3>
      <div class="main">${esc(garage.name)}</div>
      <div class="line">${esc([garage.address, garage.phone].filter(Boolean).join("\n"))}</div>
    </div>
  </div>
  <table class="items"><thead><tr><th class="n">#</th><th>Part no</th><th>Description</th><th class="r">Qty</th><th class="r">Your price</th><th class="r">Available</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="bottom"><div class="notes">Please send your price and availability for each part, quoting ${esc(po.number)}.</div></div>
  ${photos.length ? `<div class="photos">${photos.map((p) => `<div><img src="data:image/jpeg;base64,${p.base64}" alt="">${esc(p.label)}</div>`).join("")}</div>` : ""}
  <footer><span>${esc(po.number)} · ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>
</div></body></html>`;
}

const METHOD: Record<string, string> = { cash: "Cash", card: "Card", bank_transfer: "Bank transfer", cheque: "Cheque" };
const ymdDate = (ymd: string) => date(`${ymd}T00:00:00.000Z`);
const bankLine = (s: Settings) => [s.garage.bankName, s.garage.accountName, s.garage.iban ? `IBAN ${s.garage.iban}` : null].filter(Boolean).join("  ·  ");

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_CSS}
    table.ledger td.d { white-space: nowrap; color: #52525b; } .aging { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2mm; margin-top: 6mm; }
    .aging div { border: 1px solid #e4e4e7; border-radius: 2mm; padding: 2.5mm; font-size: 8.5pt; color: #52525b; } .aging b { display: block; font-size: 10.5pt; color: #18181b; margin-top: 1mm; }
    .aging { grid-template-columns: repeat(auto-fit, minmax(24mm, 1fr)); }
    .amount { font-size: 20pt; font-weight: 800; margin: 2mm 0 4mm; }</style></head><body><div class="page">${body}</div></body></html>`;
}

/** A printed receipt (RCT-…): the amount, how it was paid, which invoices it went against, and any credit kept. */
export function renderReceiptHtml(r: Receipt, garage: Garage, settings: Settings): string {
  const t = (en: string) => en;
  const refund = r.amountFils < 0;
  const title = `<div class="title"><div class="en">${refund ? "REFUND" : "RECEIPT"}</div>
    <div class="num">${esc(r.number)}</div><div class="meta">${t("Date")}: ${date(r.receivedAt)}</div></div>`;
  const rows = r.allocations.map((a, i) => `<tr><td class="n">${i + 1}</td><td>${esc(a.number)}</td><td class="r b">${money(a.amountFils)}</td></tr>`).join("");
  const how = [METHOD[r.method] ?? r.method, r.reference, r.chequeDate ? `cheque dated ${ymdDate(r.chequeDate)}` : null].filter(Boolean).join(" · ");
  return shell(r.number, `
  ${garageHeader(garage, settings, title)}
  <div class="parties"><div class="party"><h3>${t(refund ? "Paid to" : "Received from")}</h3><div class="main">${esc(r.customerName)}</div></div>
    <div class="party"><h3>${t("Amount")}</h3><div class="amount">AED ${money(Math.abs(r.amountFils))}</div><div class="line">${esc(how)}</div></div></div>
  ${wordsBlock(r.amountFils)}
  ${r.allocations.length ? `<h3 style="font-size:8pt;letter-spacing:.1em;color:#71717a;text-transform:uppercase;margin:4mm 0 2mm">${t("Allocated to")}</h3>
  <table class="items"><thead><tr><th class="n">#</th><th>${"Invoice"}</th><th class="r">${"Amount"}</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
  ${r.unallocatedFils > 0 ? `<div class="warranty"><b>On account: ${formatAED(r.unallocatedFils)}</b> — not against an invoice; it pays any earlier balance first, then is kept as credit.</div>` : ""}
  <div class="sigs two"><div><span></span>${t(refund ? "Received by (customer)" : "Paid by (customer)")}</div>${garageSignature(garage, settings)}</div>
  <footer><span>${esc(r.number)} · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>`);
}

const AGING_LABELS: Record<AgingBucket, string> = { current: "Current", "1-30": "1–30 days", "31-60": "31–60 days", "61-90": "61–90 days", "90+": "Over 90 days" };

/** Statement of account for a date range: brought forward, each entry with a running balance, carried forward, aging. */
export function renderStatementHtml(
  s: Statement,
  customer: {
    name: string; trn: string | null; address: string | null; phone: string | null; email: string | null;
  },
  garage: Garage,
  settings: Settings,
  range: { from: string; to: string },
): string {
  const t = (en: string) => en;
  const title = `<div class="title"><div class="en">STATEMENT OF ACCOUNT</div>
    <div class="meta">${ymdDate(range.from)} – ${ymdDate(range.to)}</div></div>`;
  const rows = s.rows.map((r) => `<tr><td class="d">${ymdDate(r.date)}</td><td>${esc(r.number)}</td><td>${esc(r.description)}</td>
    <td class="r">${r.debitFils ? money(r.debitFils) : ""}</td><td class="r">${r.creditFils ? money(r.creditFils) : ""}</td><td class="r b">${money(r.balanceFils)}</td></tr>`).join("");
  const bank = bankLine(settings);
  return shell(`Statement - ${customer.name}`, `
  ${garageHeader(garage, settings, title)}
  <div class="parties"><div class="party"><h3>${t("Customer")}</h3><div class="main">${esc(customer.name)}</div>
    <div class="line">${esc([customer.phone, customer.email, customer.address].filter(Boolean).join("\n"))}</div>${customer.trn ? `<div class="line"><b>${t("TRN")}:</b> ${esc(customer.trn)}</div>` : ""}</div>
    <div class="party"><h3>${t("Balance due")}</h3><div class="amount">AED ${money(s.closingFils)}</div><div class="line">as of ${ymdDate(range.to)}</div></div></div>
  <table class="items ledger"><thead><tr><th>${"Date"}</th><th>${"Number"}</th><th>${"Details"}</th><th class="r">${"Debit"}</th><th class="r">${"Credit"}</th><th class="r">${"Balance"}</th></tr></thead>
    <tbody><tr><td class="d">${ymdDate(range.from)}</td><td></td><td>${t("Balance brought forward")}</td><td></td><td></td><td class="r b">${money(s.openingFils)}</td></tr>${rows}
    <tr><td class="d">${ymdDate(range.to)}</td><td></td><td><b>${t("Balance carried forward")}</b></td><td></td><td></td><td class="r b">${money(s.closingFils)}</td></tr></tbody></table>
  <div class="aging">${(Object.keys(AGING_LABELS) as AgingBucket[]).map((b) => `<div>${t(AGING_LABELS[b])}<b>${money(s.aging[b])}</b></div>`).join("")}${s.creditFils ? `<div>${t("Less credit")}<b>−${money(s.creditFils)}</b></div>` : ""}<div>${t("Total due")}<b>${money(s.closingFils)}</b></div></div>
  ${bank ? `<div class="terms"><div class="bank">${esc(bank)}</div></div>` : ""}
  <footer><span>Statement · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>`);
}

// ── Payroll ────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Payslip {
  employee: { id: string; name: string; job: string; personId: string | null };
  month: string; workedDays: number; basicFils: number; allowances: { housing: number; transport: number; other: number };
  unpaidDays: number; unpaidDeductionFils: number; advanceRepaymentFils: number; extrasFils: number; extrasNote: string | null;
  bonusFils: number; bonusInWps: boolean; netWpsFils: number; paidBy: string;
}
export interface BonusVoucher { month: string; lines: { employeeId: string; name: string; job: string; bonusFils: number }[]; totalFils: number }

const monthLong = (month: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

function payslipBody(p: Payslip, garage: Garage, settings: Settings): string {
  const t = (en: string) => en;
  const title = `<div class="title"><div class="en">PAYSLIP</div><div class="meta">${esc(monthLong(p.month))}</div></div>`;
  const row = (label: string, fils: number, note = "") => (fils ? `<tr><td>${t(label)}${note ? ` <span style="color:#71717a">(${esc(note)})</span>` : ""}</td><td class="r">${money(fils)}</td></tr>` : "");
  const earnings = [
    row("Basic salary", p.basicFils), row("Housing allowance", p.allowances.housing), row("Transport allowance", p.allowances.transport),
    row("Other allowance", p.allowances.other), p.extrasFils > 0 ? row("Extras", p.extrasFils, p.extrasNote ?? "") : "",
    p.bonusInWps ? row("Bonus", p.bonusFils) : "",
  ].join("");
  const deductions = [
    row("Unpaid leave", p.unpaidDeductionFils, p.unpaidDays ? `${p.unpaidDays} day${p.unpaidDays === 1 ? "" : "s"}` : ""),
    row("Advance repayment", p.advanceRepaymentFils), p.extrasFils < 0 ? row("Extras", -p.extrasFils, p.extrasNote ?? "") : "",
  ].join("");
  return `
  ${garageHeader(garage, settings, title)}
  <div class="parties"><div class="party"><h3>${t("Employee")}</h3><div class="main">${esc(p.employee.name)}</div>
      <div class="line">${t("Job")}: ${esc(p.employee.job)}${p.employee.personId ? ` · MOHRE ${esc(p.employee.personId)}` : ""}</div></div>
    <div class="party"><h3>${t("Days worked")}</h3><div class="main">${p.workedDays}</div><div class="line">${t("Paid by")}: ${esc(p.paidBy)}</div></div></div>
  <table class="items"><thead><tr><th>${"Earnings"}</th><th class="r">AED</th></tr></thead><tbody>${earnings}</tbody></table>
  ${deductions ? `<table class="items" style="margin-top:4mm"><thead><tr><th>${"Deductions"}</th><th class="r">AED</th></tr></thead><tbody>${deductions}</tbody></table>` : ""}
  <table class="items" style="margin-top:4mm"><tbody><tr><td class="b">${t("Net salary (WPS)")}</td><td class="r b">${money(p.netWpsFils)}</td></tr>
    ${!p.bonusInWps && p.bonusFils ? `<tr><td>${t("Cash bonus")}</td><td class="r">${money(p.bonusFils)}</td></tr>` : ""}</tbody></table>
  <div class="sigs two"><div><span></span>${t("Received by (employee)")}</div>${garageSignature(garage, settings)}</div>
  <footer><span>${esc(monthLong(p.month))} · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>`;
}

/** Payslips for a run: one A4 page each. */
export function renderPayslipsHtml(slips: Payslip[], garage: Garage, settings: Settings): string {
  const pages = slips.map((s) => payslipBody(s, garage, settings));
  return shell(`Payslips ${slips[0] ? monthLong(slips[0].month) : ""}`, pages.join('</div><div class="page" style="page-break-before:always">'));
}

/** The cash bonus voucher: who gets what, with a column for each person's signature. */
export function renderBonusVoucherHtml(v: BonusVoucher, garage: Garage, settings: Settings): string {
  const title = `<div class="title"><div class="en">CASH BONUS</div><div class="meta">${esc(monthLong(v.month))}</div></div>`;
  const rows = v.lines.map((l, i) => `<tr><td class="n">${i + 1}</td><td>${esc(l.name)}</td><td>${esc(l.job)}</td><td class="r b">${money(l.bonusFils)}</td><td style="width:45mm"></td></tr>`).join("");
  return shell(`Cash bonus ${monthLong(v.month)}`, `
  ${garageHeader(garage, settings, title)}
  <table class="items"><thead><tr><th class="n">#</th><th>Employee</th><th>Job</th><th class="r">Bonus (AED)</th><th>Signature</th></tr></thead>
    <tbody>${rows}<tr><td></td><td class="b">Total</td><td></td><td class="r b">${money(v.totalFils)}</td><td></td></tr></tbody></table>
  <div class="sigs two"><div><span></span>Paid by</div>${garageSignature(garage, settings)}</div>
  <footer><span>Cash bonus · ${esc(monthLong(v.month))}</span><span>Powered by Fleetfix Garage Pro</span></footer>`);
}

export interface SettlementLetter {
  employeeId: string; name: string; job: string; joinDate: string; lastDay: string;
  items: { key: string; label: string; proposedFils: number; amountFils: number; how: string; reason: string | null }[];
  totalFils: number;
  /** Not approved yet: printed with DRAFT across it. */
  draft?: boolean;
}

/** A leaver's final settlement letter: each amount, how it was worked out, any change and why, the total, signatures. */
export function renderSettlementHtml(s: SettlementLetter, garage: Garage, settings: Settings): string {
  const t = (en: string) => en;
  const title = `<div class="title"><div class="en">FINAL SETTLEMENT</div><div class="meta">${t("Last day")}: ${ymdDate(s.lastDay)}</div></div>`;
  const rows = s.items.map((i) => `<tr><td><b>${t(i.label)}</b><div style="color:#52525b;font-size:8.5pt">${esc(i.how)}</div>
      ${i.reason ? `<div style="color:#b45309;font-size:8.5pt">${t("Changed from")} ${money(i.proposedFils)}: ${esc(i.reason)}</div>` : ""}</td><td class="r b">${money(i.amountFils)}</td></tr>`).join("");
  const owedBy = s.totalFils < 0;
  return shell(`Final settlement - ${s.name}`, `
  ${garageHeader(garage, settings, title)}
  <div class="parties"><div class="party"><h3>${t("Employee")}</h3><div class="main">${esc(s.name)}</div><div class="line">${esc(s.job)}</div></div>
    <div class="party"><h3>${t("Joined")}</h3><div class="main">${ymdDate(s.joinDate)}</div><div class="line">${t("Last day")}: ${ymdDate(s.lastDay)}</div></div></div>
  <table class="items"><thead><tr><th>${"How it was worked out"}</th><th class="r">AED</th></tr></thead><tbody>${rows}
    <tr><td class="b">${t(owedBy ? "Owed by the employee" : "Total due")}</td><td class="r b">${money(Math.abs(s.totalFils))}</td></tr></tbody></table>
  ${s.draft ? `<div style="position:fixed;top:40%;left:0;right:0;text-align:center;font-size:72pt;font-weight:800;color:rgba(220,38,38,.18);transform:rotate(-20deg)">DRAFT</div>` : ""}
  ${wordsBlock(Math.abs(s.totalFils))}
  <div class="sigs two"><div><span></span>${t(owedBy ? "Paid by (employee)" : "Received by (employee)")}</div>${garageSignature(garage, settings)}</div>
  <footer><span>Final settlement · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>`);
}

