import { amountInWords, formatAED, lineTotals, type DocLanguage, type Settings } from "@ffgp/shared";
import type { AgingBucket, DocumentFull, Garage, PurchaseOrder, Receipt, Statement } from "../lib/types";
import { arabicCss, H, L, vatLabel } from "./arabic";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (fils: number) => formatAED(fils).replace("AED ", "");
const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso)) : "");

const TITLES = {
  estimate: { en: "ESTIMATE", ar: "عرض سعر" },
  jobcard: { en: "JOB CARD", ar: "بطاقة عمل" },
  invoice: { en: "TAX INVOICE", ar: "فاتورة ضريبية" },
  credit_note: { en: "TAX CREDIT NOTE", ar: "إشعار دائن ضريبي" },
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
function garageHeader(garage: Garage, settings: Settings, title: string, lang: DocLanguage = "en"): string {
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
        ${lang === "en_ar" && (g.nameAr || g.addressAr) ? `<div class="ar-block" dir="rtl" lang="ar">${g.nameAr ? `<div class="name">${esc(g.nameAr)}</div>` : ""}${g.addressAr ? `<div>${esc(g.addressAr)}</div>` : ""}</div>` : ""}
      </div>
    </div>
    ${title}
  </header>`;
}

/** "For {garage}" signature cell, with the stamp and signature images above the line when set. */
function garageSignature(garage: Garage, settings: Settings, lang: DocLanguage = "en"): string {
  const { stamp, signature } = settings.documents;
  const images = stamp || signature
    ? `<div class="sigimg">${signature ? `<img class="signature" src="${esc(signature)}" alt="">` : ""}${stamp ? `<img class="stamp" src="${esc(stamp)}" alt="">` : ""}</div>`
    : "";
  const ar = lang === "en_ar" && settings.garage.nameAr ? ` / <bdi lang="ar">عن ${esc(settings.garage.nameAr)}</bdi>` : "";
  return `<div>${images}<span></span>For ${esc(garage.name)}${ar}</div>`;
}

/** "يوم", "يومان", "أيام" (3–10) or "يوماً" (11+) after a number of days. */
const arDays = (n: number) => (n === 1 ? "يوم" : n === 2 ? "يومان" : n % 100 >= 3 && n % 100 <= 10 ? "أيام" : "يوماً");

/** Arabic text on its own right-to-left line, or nothing when it's blank. */
const arLine = (text: string | null | undefined, cls = "arl") => (text ? `<div class="${cls}" dir="rtl" lang="ar">${esc(text)}</div>` : "");

/** The amount in words: English always, Arabic too on English + Arabic documents. */
function wordsBlock(fils: number, lang: DocLanguage): string {
  return `<div class="words"><b>${L("Amount in words", lang)}:</b> ${esc(amountInWords(fils, "en"))}</div>${lang === "en_ar" ? `<div class="words" dir="rtl" lang="ar">${esc(amountInWords(fils, "ar"))}</div>` : ""}`;
}

/** The page head: shared styles, plus the Arabic font on English + Arabic pages. */
const headCss = (lang: DocLanguage, extra = "") => `<style>${PAGE_CSS}${lang === "en_ar" ? arabicCss() : ""}${extra}</style>`;

const KIND = { labour: "Labour", part: "Part", other: "Other" } as Record<string, string>;

/** Self-contained A4 HTML for one document. The garage is the seller, so its details lead the page. */
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
  const lang: DocLanguage = doc.language ?? "en";
  const t = (en: string) => L(en, lang);
  const h = (en: string) => H(en, lang);
  const bi = lang === "en_ar";

  const partNo = (l: DocumentFull["lines"][number]) => (ds.showPartNumbers && l.partNo ? `Part no. ${esc(l.partNo)}` : "");
  const qty = (l: DocumentFull["lines"][number]) => (ds.showLabourHours && l.kind === "labour" ? `${l.qty} h` : `${l.qty}`);
  const rows = doc.lines
    .map((l, i) => {
      if (isJob) {
        const notes = [partNo(l), l.suppliedBy === "fleetfix" ? "Supplied by Fleet Fix" : ""].filter(Boolean).join(" · ");
        return `<tr><td class="n">${i + 1}</td><td>${esc(l.description)}${bi ? arLine(l.partNameAr) : ""}${notes ? `<div class="k">${notes}</div>` : ""}</td><td>${KIND[l.kind] ?? ""}</td><td class="r">${qty(l)}</td><td class="c"><span class="box"></span></td></tr>`;
      }
      const t = lineTotals(l, garage.vatRateBp, doc.pricesIncludeVat);
      const notes = [KIND[l.kind] ?? "", partNo(l), l.suppliedBy === "fleetfix" ? "Supplied by Fleet Fix" : ""].filter(Boolean).join(" · ");
      return `<tr><td class="n">${i + 1}</td><td>${esc(l.description)}${bi ? arLine(l.partNameAr) : ""}<div class="k">${notes}</div></td><td class="r">${qty(l)}</td><td class="r">${money(l.unitPriceFils)}</td><td class="r">${l.discountPct ? `${l.discountPct}%` : "—"}</td><td class="r">${money(t.netFils)}</td><td class="r">${money(t.vatFils)}</td><td class="r b">${money(t.grossFils)}</td></tr>`;
    })
    .join("");

  const head = isJob
    ? `<tr><th class="n">#</th><th>${h("Work / part")}</th><th>${h("Type")}</th><th class="r">${h("Qty")}</th><th class="c">${h("Done")}</th></tr>`
    : `<tr><th class="n">#</th><th>${h("Description")}</th><th class="r">${h("Qty")}</th><th class="r">${h(doc.pricesIncludeVat ? "Unit price (incl. VAT)" : "Unit price")}</th><th class="r">${h("Disc.")}</th><th class="r">${h("Amount")}</th><th class="r">${bi ? `VAT ${vatPct}%<br><span lang="ar">الضريبة ${vatPct}%</span>` : `VAT ${vatPct}%`}</th><th class="r">${h("Total")}</th></tr>`;

  const totals = isJob
    ? ""
    : `<table class="totals">
        <tr><td>${t("Subtotal (excl. VAT)")}</td><td class="r">${money(doc.totals.netFils)}</td></tr>
        <tr><td>${vatLabel(vatPct, lang)}</td><td class="r">${money(doc.totals.vatFils)}</td></tr>
        <tr class="grand"><td>${t(isCredit ? "Total credit (AED, incl. VAT)" : "Total (AED, incl. VAT)")}</td><td class="r">${money(doc.totals.grossFils)}</td></tr>
        ${isInvoice && !draftInvoice && (doc.creditedFils ?? 0) > 0 ? `<tr><td>${t("Credited")}</td><td class="r">${money(doc.creditedFils ?? 0)}</td></tr>` : ""}
        ${isInvoice && !draftInvoice && doc.paidFils > 0 ? `<tr><td>${t("Paid")}</td><td class="r">${money(doc.paidFils)}</td></tr>` : ""}
        ${isInvoice && !draftInvoice && (doc.paidFils > 0 || (doc.creditedFils ?? 0) > 0) ? `<tr class="due"><td>${t("Balance due")}</td><td class="r">${money(Math.max(doc.balanceFils, 0))}</td></tr>` : ""}
      </table>`;

  const signatures = isJob
    ? `${ds.jobCardSignature ? `<div class="auth"><b>I authorise the work above</b> and agree to pay for it on collection.${bi ? arLine("أوافق على الأعمال المذكورة أعلاه وأتعهد بدفع قيمتها عند الاستلام") : ""}</div>` : ""}<div class="sigs"><div><span></span>${t("Service advisor")}</div><div><span></span>${t("Technician")}</div><div><span></span>${t("Customer")}</div></div>`
    : isInvoice || isCredit
      ? `<div class="sigs two"><div><span></span>${t("Received by (customer)")}</div>${garageSignature(garage, settings, lang)}</div>`
      : `<div class="sigs two"><div><span></span>${t("Customer approval")}</div>${garageSignature(garage, settings, lang)}</div>`;
  const bank = [gs.bankName, gs.accountName, gs.iban ? `IBAN ${gs.iban}` : null].filter(Boolean).join("  ·  ");
  const termsAr = bi ? ds.termsAr : null;
  const terms = isInvoice && (bank || ds.terms || termsAr)
    ? `<div class="terms">${bank ? `<div class="bank">${esc(bank)}</div>` : ""}${ds.terms ? esc(ds.terms) : ""}${arLine(termsAr)}</div>`
    : "";
  const words = isInvoice || isCredit ? wordsBlock(doc.totals.grossFils, lang) : "";
  const issued = isInvoice && !draftInvoice;
  const fullyCredited = issued && (doc.creditedFils ?? 0) >= doc.totals.grossFils && doc.totals.grossFils > 0;
  const marks = [
    fullyCredited ? "CREDITED" : doc.status === "paid" && issued && doc.paidFils > 0 ? "PAID" : null,
    opts.copy && (issued || isCredit) ? "COPY" : null,
  ].filter(Boolean);
  const watermark = marks.length ? `<div class="wm">${marks.map((m) => `<span>${m}</span>`).join("")}</div>` : "";
  const titleHtml = `<div class="title">
      <div class="en">${title.en}</div>
      <div class="ar">${title.ar}</div>
      <div class="num">${esc(doc.number)}</div>
      <div class="meta">${t("Date")}: ${date(docDate)}</div>
      ${isCredit && doc.source ? `<div class="meta">Credit for ${esc(doc.source.number)}${doc.source.issuedAt ? ` of ${date(doc.source.issuedAt)}` : ""}</div>` : doc.source ? `<div class="meta">Ref: ${esc(doc.source.number)}</div>` : ""}
      ${isInvoice && doc.dueDate ? `<div class="meta">${t("Due")}: ${date(`${doc.dueDate}T00:00:00.000Z`)}</div>` : ""}
      ${isInvoice && doc.lpoNumber ? `<div class="meta">${t("LPO")}: ${esc(doc.lpoNumber)}</div>` : ""}
      ${draftInvoice ? `<div class="draft">DRAFT — NOT A TAX INVOICE</div>` : ""}
    </div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(doc.number)}</title>${headCss(lang)}</head><body><div class="page">
  ${watermark}
  ${garageHeader(garage, settings, titleHtml, lang)}
  <div class="parties">
    <div class="party">
      <h3>${t(isInvoice ? "Bill to" : "Customer")}</h3>
      <div class="main">${esc(c.name)}</div>
      ${bi ? arLine(c.nameAr, "arl main") : ""}
      <div class="line">${esc([c.phone, c.email, c.address].filter(Boolean).join("\n"))}</div>
      ${bi ? arLine(c.addressAr) : ""}
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
    <div class="notes">${isCredit && doc.reason ? `<h3>${t("Reason")}</h3>${esc(doc.reason)}` : ""}${doc.notes ? `<h3>${t("Notes")}</h3>${esc(doc.notes)}` : ""}${doc.type === "estimate" ? `<div style="margin-top:3mm;color:#71717a">Prices in AED. Estimate valid for ${ds.estimateValidDays} days. Additional work found during repair will be quoted separately.</div>${bi ? arLine(`الأسعار بالدرهم. عرض السعر صالح لمدة ${ds.estimateValidDays} ${arDays(ds.estimateValidDays)}. أي أعمال إضافية تظهر أثناء الإصلاح يتم تسعيرها بشكل منفصل.`) : ""}` : ""}${isInvoice && ds.warranty ? `<div class="warranty"><b>${t("Warranty")}:</b> ${esc(ds.warranty)}</div>` : ""}${isInvoice && bi ? arLine(ds.warrantyAr, "warranty arl") : ""}${words}</div>
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
  const titleHtml = `<div class="title">
      <div class="en">PURCHASE ORDER</div>
      <div class="ar">أمر شراء</div>
      <div class="num">${esc(po.number)}</div>
      <div class="meta">Date: ${date(po.createdAt)}</div>
    </div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(po.number)}</title><style>${PAGE_CSS} .mono { font-family: Consolas, "SF Mono", monospace; font-size: 9pt; }</style></head><body><div class="page">
  ${garageHeader(garage, settings, titleHtml)}
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
  <div class="sigs two"><div><span></span>Ordered by</div>${garageSignature(garage, settings)}</div>
  <footer><span>${esc(po.number)} · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>
</div></body></html>`;
}


const METHOD: Record<string, string> = { cash: "Cash", card: "Card", bank_transfer: "Bank transfer", cheque: "Cheque" };
const ymdDate = (ymd: string) => date(`${ymd}T00:00:00.000Z`);
const bankLine = (s: Settings) => [s.garage.bankName, s.garage.accountName, s.garage.iban ? `IBAN ${s.garage.iban}` : null].filter(Boolean).join("  ·  ");

function shell(title: string, body: string, lang: DocLanguage = "en"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_CSS}${lang === "en_ar" ? arabicCss() : ""}
    table.ledger td.d { white-space: nowrap; color: #52525b; } .aging { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2mm; margin-top: 6mm; }
    .aging div { border: 1px solid #e4e4e7; border-radius: 2mm; padding: 2.5mm; font-size: 8.5pt; color: #52525b; } .aging b { display: block; font-size: 10.5pt; color: #18181b; margin-top: 1mm; }
    .aging { grid-template-columns: repeat(auto-fit, minmax(24mm, 1fr)); }
    .amount { font-size: 20pt; font-weight: 800; margin: 2mm 0 4mm; }</style></head><body><div class="page">${body}</div></body></html>`;
}

/** A printed receipt (RCT-…): the amount, how it was paid, which invoices it went against, and any credit kept. */
export function renderReceiptHtml(r: Receipt, garage: Garage, settings: Settings): string {
  const lang: DocLanguage = r.customerLanguage ?? "en";
  const t = (en: string) => L(en, lang);
  const refund = r.amountFils < 0;
  const title = `<div class="title"><div class="en">${refund ? "REFUND" : "RECEIPT"}</div><div class="ar">${refund ? "استرداد" : "إيصال استلام"}</div>
    <div class="num">${esc(r.number)}</div><div class="meta">${t("Date")}: ${date(r.receivedAt)}</div></div>`;
  const rows = r.allocations.map((a, i) => `<tr><td class="n">${i + 1}</td><td>${esc(a.number)}</td><td class="r b">${money(a.amountFils)}</td></tr>`).join("");
  const how = [METHOD[r.method] ?? r.method, r.reference, r.chequeDate ? `cheque dated ${ymdDate(r.chequeDate)}` : null].filter(Boolean).join(" · ");
  return shell(r.number, `
  ${garageHeader(garage, settings, title, lang)}
  <div class="parties"><div class="party"><h3>${t(refund ? "Paid to" : "Received from")}</h3><div class="main">${esc(r.customerName)}</div>${lang === "en_ar" ? arLine(r.customerNameAr, "arl main") : ""}</div>
    <div class="party"><h3>${t("Amount")}</h3><div class="amount">AED ${money(Math.abs(r.amountFils))}</div><div class="line">${esc(how)}</div></div></div>
  ${wordsBlock(r.amountFils, lang)}
  ${r.allocations.length ? `<h3 style="font-size:8pt;letter-spacing:.1em;color:#71717a;text-transform:uppercase;margin:4mm 0 2mm">${t("Allocated to")}</h3>
  <table class="items"><thead><tr><th class="n">#</th><th>${H("Invoice", lang)}</th><th class="r">${H("Amount", lang)}</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
  ${r.unallocatedFils > 0 ? `<div class="warranty"><b>On account: ${formatAED(r.unallocatedFils)}</b> — not against an invoice; it pays any earlier balance first, then is kept as credit.</div>` : ""}
  <div class="sigs two"><div><span></span>${t(refund ? "Received by (customer)" : "Paid by (customer)")}</div>${garageSignature(garage, settings, lang)}</div>
  <footer><span>${esc(r.number)} · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>`, lang);
}

const AGING_LABELS: Record<AgingBucket, string> = { current: "Current", "1-30": "1–30 days", "31-60": "31–60 days", "61-90": "61–90 days", "90+": "Over 90 days" };

/** Statement of account for a date range: brought forward, each entry with a running balance, carried forward, aging. */
export function renderStatementHtml(
  s: Statement,
  customer: {
    name: string; trn: string | null; address: string | null; phone: string | null; email: string | null;
    nameAr?: string | null; addressAr?: string | null; docLanguage?: DocLanguage;
  },
  garage: Garage,
  settings: Settings,
  range: { from: string; to: string },
): string {
  const lang: DocLanguage = customer.docLanguage ?? "en";
  const t = (en: string) => L(en, lang);
  const bi = lang === "en_ar";
  const title = `<div class="title"><div class="en">STATEMENT OF ACCOUNT</div><div class="ar">كشف حساب</div>
    <div class="meta">${ymdDate(range.from)} – ${ymdDate(range.to)}</div></div>`;
  const rows = s.rows.map((r) => `<tr><td class="d">${ymdDate(r.date)}</td><td>${esc(r.number)}</td><td>${esc(r.description)}</td>
    <td class="r">${r.debitFils ? money(r.debitFils) : ""}</td><td class="r">${r.creditFils ? money(r.creditFils) : ""}</td><td class="r b">${money(r.balanceFils)}</td></tr>`).join("");
  const bank = bankLine(settings);
  return shell(`Statement - ${customer.name}`, `
  ${garageHeader(garage, settings, title, lang)}
  <div class="parties"><div class="party"><h3>${t("Customer")}</h3><div class="main">${esc(customer.name)}</div>${bi ? arLine(customer.nameAr, "arl main") : ""}
    <div class="line">${esc([customer.phone, customer.email, customer.address].filter(Boolean).join("\n"))}</div>${bi ? arLine(customer.addressAr) : ""}${customer.trn ? `<div class="line"><b>${t("TRN")}:</b> ${esc(customer.trn)}</div>` : ""}</div>
    <div class="party"><h3>${t("Balance due")}</h3><div class="amount">AED ${money(s.closingFils)}</div><div class="line">as of ${ymdDate(range.to)}</div></div></div>
  <table class="items ledger"><thead><tr><th>${H("Date", lang)}</th><th>${H("Number", lang)}</th><th>${H("Details", lang)}</th><th class="r">${H("Debit", lang)}</th><th class="r">${H("Credit", lang)}</th><th class="r">${H("Balance", lang)}</th></tr></thead>
    <tbody><tr><td class="d">${ymdDate(range.from)}</td><td></td><td>${t("Balance brought forward")}</td><td></td><td></td><td class="r b">${money(s.openingFils)}</td></tr>${rows}
    <tr><td class="d">${ymdDate(range.to)}</td><td></td><td><b>${t("Balance carried forward")}</b></td><td></td><td></td><td class="r b">${money(s.closingFils)}</td></tr></tbody></table>
  <div class="aging">${(Object.keys(AGING_LABELS) as AgingBucket[]).map((b) => `<div>${t(AGING_LABELS[b])}<b>${money(s.aging[b])}</b></div>`).join("")}${s.creditFils ? `<div>${t("Less credit")}<b>−${money(s.creditFils)}</b></div>` : ""}<div>${t("Total due")}<b>${money(s.closingFils)}</b></div></div>
  ${bank ? `<div class="terms"><div class="bank">${esc(bank)}</div></div>` : ""}
  <footer><span>Statement · printed ${date(new Date().toISOString())}</span><span>Powered by Fleetfix Garage Pro</span></footer>`, lang);
}
