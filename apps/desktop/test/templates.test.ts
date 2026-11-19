import { amountInWords, DEFAULT_SETTINGS, type Settings } from "@ffgp/shared";
import { describe, expect, it } from "vitest";
import { SAMPLE_DOCUMENTS, SAMPLE_GARAGE } from "../src/renderer/print/sample";
import { renderDocumentHtml, renderReceiptHtml, renderStatementHtml } from "../src/renderer/print/templates";
import * as T from "../src/renderer/print/templates";
import "../src/renderer/print/arabic-font";
const renderDoc = T.renderDocumentHtml;
const renderReceipt = T.renderReceiptHtml;
const renderStatement = T.renderStatementHtml;

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function settings(patch: { [S in keyof Settings]?: Partial<Settings[S]> } = {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(patch)) Object.assign((s as Record<string, object>)[k]!, v);
  return s;
}
const invoice = (status = "issued") => ({ ...SAMPLE_DOCUMENTS.invoice, status });

describe("printed documents follow Settings", () => {
  it("logo and bank details print on a plain-paper invoice", () => {
    const html = renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings({
      documents: { logo: PNG, terms: "Payment due within 30 days." },
      garage: { bankName: "Emirates NBD", accountName: "Al Quoz Auto Care LLC", iban: "AE070260001012345678901", tradeLicence: "CN-1234567" },
    }));
    expect(html).toContain('<img class="logo"');
    expect(html).toContain("AE070260001012345678901");
    expect(html).toContain("Payment due within 30 days.");
    expect(html).toContain("CN-1234567");
  });

  it("letterhead leaves the top blank", () => {
    const html = renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings({ documents: { paper: "letterhead", letterheadTopMm: 45, logo: PNG } }));
    expect(html).not.toContain(`<h1>${SAMPLE_GARAGE.name}</h1>`);
    expect(html).not.toContain('<img class="logo"');
    expect(html).toContain("height:45mm");
  });

  it("estimate validity follows the setting", () => {
    expect(renderDocumentHtml(SAMPLE_DOCUMENTS.estimate, SAMPLE_GARAGE, settings({ documents: { estimateValidDays: 30 } }))).toContain("valid for 30 days");
  });

  it("watermarks", () => {
    expect(renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings(), { copy: true })).toContain('class="wm"');
    expect(renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings(), { copy: true })).toContain(">COPY<");
    expect(renderDocumentHtml({ ...invoice("paid"), paidFils: SAMPLE_DOCUMENTS.invoice.totals.grossFils }, SAMPLE_GARAGE, settings())).toContain(">PAID<");
    const draft = renderDocumentHtml(invoice("draft"), SAMPLE_GARAGE, settings(), { copy: true });
    expect(draft).not.toContain(">COPY<");
    expect(draft).not.toContain(">PAID<");
  });

  it("part numbers and labour hours can be hidden", () => {
    const shown = renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings());
    expect(shown).toContain("Part no. 90915-YZZE1");
    expect(shown).toContain("1.5 h");
    const hidden = renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings({ documents: { showPartNumbers: false, showLabourHours: false } }));
    expect(hidden).not.toContain("Part no.");
    expect(hidden).not.toContain("1.5 h");
  });

  it("job card authorisation box", () => {
    expect(renderDocumentHtml(SAMPLE_DOCUMENTS.jobcard, SAMPLE_GARAGE, settings())).toContain("I authorise the work above");
    expect(renderDocumentHtml(SAMPLE_DOCUMENTS.jobcard, SAMPLE_GARAGE, settings({ documents: { jobCardSignature: false } })))
      .not.toContain("I authorise the work above");
  });

  it("warranty and stamp print on invoices", () => {
    const html = renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings({ documents: { warranty: "Labour: 3 months / 5,000 km", stamp: PNG, signature: PNG } }));
    expect(html).toContain("Labour: 3 months / 5,000 km");
    expect(html).toContain('<img class="stamp"');
    expect(html).toContain('<img class="signature"');
  });

  it("prices typed including VAT are labelled", () => {
    expect(renderDocumentHtml({ ...invoice(), pricesIncludeVat: true }, SAMPLE_GARAGE, settings())).toContain("Unit price (incl. VAT)");
  });

  it("a credit note says what it corrects and why", () => {
    const cn = { ...SAMPLE_DOCUMENTS.credit_note, reason: "Wrong part fitted", source: { id: "i1", number: "INV-00143", type: "invoice" as const, issuedAt: "2026-11-10T08:00:00.000Z" } };
    const html = renderDocumentHtml(cn, SAMPLE_GARAGE, settings());
    expect(html).toContain("TAX CREDIT NOTE");
    expect(html).toContain("Credit for INV-00143 of 10 Nov 2026");
    expect(html).toContain("Wrong part fitted");
    expect(html).toContain("Total credit");
  });

  it("an invoice shows its due date, LPO and credit notes", () => {
    const html = renderDocumentHtml({ ...invoice(), dueDate: "2026-12-19", lpoNumber: "LPO-7781", creditedFils: 5250, owedFils: 52500 }, SAMPLE_GARAGE, settings());
    expect(html).toContain("Due: 19 Dec 2026");
    expect(html).toContain("LPO: LPO-7781");
    expect(html).toContain("Credited");
  });
});

describe("receipts and statements", () => {
  it("a receipt lists where the money went and what's kept as credit", () => {
    const html = renderReceiptHtml({
      id: "r1", number: "RCT-00004", customerId: "c1", customerName: "Emirates Logistics", amountFils: 30000, method: "bank_transfer", reference: "TT 4471",
      chequeDate: null, receivedAt: "2026-11-19T08:00:00.000Z", createdBy: "Rashid", allocatedFils: 26750, unallocatedFils: 3250,
      allocations: [{ id: "a1", documentId: "d1", number: "INV-00007", amountFils: 21000, createdAt: "" }, { id: "a2", documentId: "d2", number: "INV-00009", amountFils: 5750, createdAt: "" }],
    }, SAMPLE_GARAGE, settings());
    expect(html).toContain("RCT-00004");
    expect(html).toContain("Allocated to");
    expect(html).toContain("INV-00009");
    expect(html).toContain("On account: AED 32.50");
    expect(html).toContain("TT 4471");
  });

  it("a statement shows balances brought and carried forward, and aging", () => {
    const html = renderStatementHtml({
      openingFils: 7500,
      rows: [{ date: "2026-11-05", kind: "invoice", number: "INV-00010", description: "Tax invoice, due 2026-12-05", debitFils: 21000, creditFils: 0, balanceFils: 28500 }],
      closingFils: 28500,
      aging: { current: 21000, "1-30": 7500, "31-60": 0, "61-90": 0, "90+": 0 },
      creditFils: 0,
    }, { name: "Emirates Logistics", trn: null, address: "Dubai", phone: null, email: null }, SAMPLE_GARAGE, settings(), { from: "2026-11-01", to: "2026-11-30" });
    expect(html).toContain("STATEMENT OF ACCOUNT");
    expect(html).toContain("Balance brought forward");
    expect(html).toContain("285.00");
    for (const label of ["Current", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"]) expect(html).toContain(label);
  });

  it("watermarks: CREDITED for a fully credited invoice, COPY on a credit note", () => {
    const credited = renderDocumentHtml({ ...invoice("paid"), paidFils: 0, creditedFils: SAMPLE_DOCUMENTS.invoice.totals.grossFils }, SAMPLE_GARAGE, settings());
    expect(credited).toContain(">CREDITED<");
    expect(credited).not.toContain(">PAID<");
    expect(renderDocumentHtml(SAMPLE_DOCUMENTS.credit_note, SAMPLE_GARAGE, settings(), { copy: true })).toContain(">COPY<");
  });
});


describe("English + Arabic documents", () => {
  // Arabic labels are wrapped in <bdi> (so numbers after them stay in order); compare the text without it.
  const plain = (html: string) => html.replace(/<\/?bdi[^>]*>/g, "");
  const renderDocumentHtml = (...a: Parameters<typeof renderDoc>) => plain(renderDoc(...a));
  const renderReceiptHtml = (...a: Parameters<typeof renderReceipt>) => plain(renderReceipt(...a));
  const renderStatementHtml = (...a: Parameters<typeof renderStatement>) => plain(renderStatement(...a));
  const bi = (patch: Partial<typeof SAMPLE_DOCUMENTS.invoice> = {}) => ({ ...SAMPLE_DOCUMENTS.invoice, language: "en_ar" as const, ...patch });
  const gross = SAMPLE_DOCUMENTS.invoice.totals.grossFils;

  it("bilingual invoice shows both labels and the Arabic garage name", () => {
    const html = renderDocumentHtml(bi(), SAMPLE_GARAGE, settings({ garage: { nameAr: "العناية بالسيارات", addressAr: "القوز الصناعية 3، دبي" } }));
    expect(html).toContain("Total (AED, incl. VAT) / الإجمالي شامل الضريبة");
    expect(html).toContain("Bill to / فاتورة إلى");
    expect(html).toContain("العناية بالسيارات");
    expect(html).toContain("القوز الصناعية 3، دبي");
    expect(html).toContain("Noto Naskh Arabic");
    expect(html).toContain("@font-face");
    expect(html).toContain(amountInWords(gross, "ar"));
    expect(html).toContain(amountInWords(gross, "en"));
    expect(html).toContain("محمد المري");
  });

  it("English invoice has no Arabic font and shows English words", () => {
    const html = renderDocumentHtml({ ...SAMPLE_DOCUMENTS.invoice, language: "en" }, SAMPLE_GARAGE, settings({ garage: { nameAr: "العناية بالسيارات" } }));
    expect(html).toContain(amountInWords(gross, "en"));
    expect(html).not.toContain("@font-face");
    expect(html).not.toContain("المبلغ كتابةً");
    expect(html).not.toContain("العناية بالسيارات");
    expect(html).not.toContain("فلتر زيت");
  });

  it("bilingual with no Arabic garage name prints the English name only", () => {
    const html = renderDocumentHtml(bi({ customer: { ...SAMPLE_DOCUMENTS.invoice.customer, nameAr: null, addressAr: null } }), SAMPLE_GARAGE, settings());
    expect(html).not.toMatch(/undefined|>null</);
    expect(html).not.toMatch(/<div[^>]*dir="rtl"[^>]*>\s*<\/div>/);
    expect(html).toContain(`<h1>${SAMPLE_GARAGE.name}</h1>`);
  });

  it("escapes Arabic fields", () => {
    const html = renderDocumentHtml(bi({ customer: { ...SAMPLE_DOCUMENTS.invoice.customer, nameAr: "<b>&" } }), SAMPLE_GARAGE, settings());
    expect(html).toContain("&lt;b&gt;&amp;");
    expect(html).not.toContain("<b>&<");
  });

  it("part line shows the Arabic part name; a typed line prints as typed", () => {
    const html = renderDocumentHtml(bi(), SAMPLE_GARAGE, settings());
    expect(html).toContain("فلتر زيت");
    expect(html).toContain("Minor service");
  });

  it("job cards and estimates are bilingual too", () => {
    const job = renderDocumentHtml({ ...SAMPLE_DOCUMENTS.jobcard, language: "en_ar" }, SAMPLE_GARAGE, settings());
    expect(job).toContain("I authorise the work above / أوافق على الأعمال المذكورة أعلاه");
    expect(job).toContain("Technician / الفني");
    expect(renderDocumentHtml({ ...SAMPLE_DOCUMENTS.estimate, language: "en_ar" }, SAMPLE_GARAGE, settings())).toContain("Customer approval / موافقة العميل");
  });

  it("bilingual receipt and statement", () => {
    const receipt = renderReceiptHtml({
      id: "r1", number: "RCT-00004", customerId: "c1", customerName: "Emirates Logistics", customerNameAr: "الإمارات للخدمات اللوجستية", customerLanguage: "en_ar",
      amountFils: 30000, method: "cash", reference: null, chequeDate: null, receivedAt: "2026-11-19T08:00:00.000Z", createdBy: null,
      allocatedFils: 30000, unallocatedFils: 0, allocations: [{ id: "a1", documentId: "d1", number: "INV-00007", amountFils: 30000, createdAt: "" }],
    }, SAMPLE_GARAGE, settings());
    expect(receipt).toContain("Received from / استلمنا من");
    expect(receipt).toContain("الإمارات للخدمات اللوجستية");
    expect(receipt).toContain(amountInWords(30000, "ar"));
    const statement = renderStatementHtml({ openingFils: 0, rows: [], closingFils: 0, aging: { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 }, creditFils: 0 },
      { name: "Emirates Logistics", trn: null, address: null, phone: null, email: null, nameAr: null, addressAr: null, docLanguage: "en_ar" },
      SAMPLE_GARAGE, settings(), { from: "2026-11-01", to: "2026-11-30" });
    expect(statement).toContain("Balance brought forward / رصيد سابق");
    expect(statement).toContain("Over 90 days / أكثر من 90 يوماً");
  });

  it("English receipt shows the amount in English words only", () => {
    const receipt = renderReceiptHtml({
      id: "r1", number: "RCT-00004", customerId: "c1", customerName: "A", amountFils: 30000, method: "cash", reference: null, chequeDate: null,
      receivedAt: "2026-11-19T08:00:00.000Z", createdBy: null, allocatedFils: 0, unallocatedFils: 30000, allocations: [],
    }, SAMPLE_GARAGE, settings());
    expect(receipt).toContain("Three hundred dirhams only");
    expect(receipt).not.toContain("@font-face");
  });

  it("Arabic terms and warranty print under the English ones", () => {
    const html = renderDocumentHtml(bi(), SAMPLE_GARAGE, settings({
      documents: { terms: "Payment within 30 days.", termsAr: "الدفع خلال 30 يوماً.", warranty: "3 months", warrantyAr: "3 أشهر" },
    }));
    expect(html.indexOf("الدفع خلال 30 يوماً.")).toBeGreaterThan(html.indexOf("Payment within 30 days."));
    expect(html.indexOf("3 أشهر")).toBeGreaterThan(html.indexOf("3 months"));
    expect(renderDocumentHtml({ ...SAMPLE_DOCUMENTS.invoice, language: "en" }, SAMPLE_GARAGE, settings({ documents: { termsAr: "الدفع خلال 30 يوماً." } }))).not.toContain("الدفع خلال");
  });
});

it("a date after an Arabic label stays in English order", () => {
  const html = renderDoc({ ...SAMPLE_DOCUMENTS.invoice, language: "en_ar" }, SAMPLE_GARAGE, settings());
  expect(html).toContain('Date / <bdi lang="ar">التاريخ</bdi>: ');
});
