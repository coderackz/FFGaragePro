import { amountInWords, DEFAULT_SETTINGS, type Settings } from "@ffgp/shared";
import { describe, expect, it } from "vitest";
import { SAMPLE_DOCUMENTS, SAMPLE_GARAGE } from "../src/renderer/print/sample";
import { renderDocumentHtml, renderReceiptHtml, renderStatementHtml } from "../src/renderer/print/templates";
import * as T from "../src/renderer/print/templates";
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

  it("a line's unit prints beside its quantity and its description under its title", () => {
    const lines = SAMPLE_DOCUMENTS.invoice.lines.map((l) => (l.kind === "labour" ? { ...l, unit: "Hr", details: "Pads and discs\nBleed <brakes>" } : l));
    for (const doc of [{ ...invoice(), lines }, { ...SAMPLE_DOCUMENTS.jobcard, lines }]) {
      const html = renderDocumentHtml(doc, SAMPLE_GARAGE, settings());
      expect(html).toContain("1.5 Hr");
      expect(html).toContain("Pads and discs<br>Bleed &lt;brakes&gt;");
    }
  });

  it("a manual discount prints above VAT, and its share on each line says Discount", () => {
    const lines = SAMPLE_DOCUMENTS.invoice.lines.map((l, i) => (i === 0 ? { ...l, promoFils: 2700 } : l));
    const pct = renderDocumentHtml({ ...invoice(), lines, discount: { kind: "percent", value: 10, discountFils: 5000, pct: 10, applied: true, confirmedBy: null, confirmedAt: null, remark: null, needsConfirmation: false } }, SAMPLE_GARAGE, settings());
    expect(pct).toContain("Discount 10%");
    expect(pct).toContain("−50.00");
    expect(pct).toContain("Discount −27.00");
    expect(pct).not.toContain("Promo −");
    const amount = renderDocumentHtml({ ...invoice(), discount: { kind: "amount", value: 5000, discountFils: 5000, pct: 4, applied: true, confirmedBy: null, confirmedAt: null, remark: null, needsConfirmation: false } }, SAMPLE_GARAGE, settings());
    expect(amount).toMatch(/<td>Discount<\/td>/);
  });

  it("part numbers and labour hours can be hidden", () => {
    const shown = renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings());
    expect(shown).toContain("Part no. 90915-YZZE1");
    expect(shown).toContain("1.5 h");
    const hidden = renderDocumentHtml(invoice(), SAMPLE_GARAGE, settings({ documents: { showPartNumbers: false, showLabourHours: false } }));
    expect(hidden).not.toContain("Part no.");
    expect(hidden).not.toContain("1.5 h");
  });

  it("tyres print their DOT, batteries their serial and warranty end", () => {
    const doc = invoice();
    const lines = [
      { ...doc.lines[0]!, units: [{ id: "u1", code: "2524", kind: "dot" as const, warrantyEnds: null }, { id: "u2", code: "2624", kind: "dot" as const, warrantyEnds: null }] },
      { ...doc.lines[0]!, units: [{ id: "u3", code: "SN-70-0001", kind: "serial" as const, warrantyEnds: "2028-11-21" }] },
    ];
    const html = renderDocumentHtml({ ...doc, lines }, SAMPLE_GARAGE, settings());
    expect(html).toContain("DOT 2524, DOT 2624");
    expect(html).toContain("Serial SN-70-0001 · warranty to 21 Nov 2028");
    expect(renderDocumentHtml({ ...SAMPLE_DOCUMENTS.jobcard, lines }, SAMPLE_GARAGE, settings())).toContain("DOT 2524");
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


describe("English only", () => {
  const ARABIC = /[\u0600-\u06FF]/;
  it("no printout has Arabic, whatever an older record says", () => {
    for (const type of ["estimate", "jobcard", "invoice", "credit_note"] as const) {
      const html = renderDoc({ ...SAMPLE_DOCUMENTS[type], language: "en_ar" } as typeof SAMPLE_DOCUMENTS.invoice, SAMPLE_GARAGE, settings());
      expect(html, type).not.toMatch(ARABIC);
      expect(html, type).not.toContain('lang="ar"');
    }
    const receipt = renderReceipt({
      id: "r1", number: "RCT-00004", customerId: "c1", customerName: "Emirates Logistics", amountFils: 30000, method: "cash", reference: null, chequeDate: null,
      receivedAt: "2026-11-19T08:00:00.000Z", createdBy: null, allocatedFils: 30000, unallocatedFils: 0,
      allocations: [{ id: "a1", documentId: "d1", number: "INV-00007", amountFils: 30000, createdAt: "" }],
    }, SAMPLE_GARAGE, settings());
    expect(receipt).not.toMatch(ARABIC);
    expect(receipt).toContain(amountInWords(30000));
    const statement = renderStatement({ openingFils: 0, rows: [], closingFils: 0, aging: { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 }, creditFils: 0 },
      { name: "Emirates Logistics", trn: null, address: null, phone: null, email: null }, SAMPLE_GARAGE, settings(), { from: "2026-11-01", to: "2026-11-30" });
    expect(statement).not.toMatch(ARABIC);
    expect(statement).toContain("Balance brought forward");
  });

  it("TRN and VAT in English", () => {
    const html = renderDoc({ ...SAMPLE_DOCUMENTS.invoice, customer: { ...SAMPLE_DOCUMENTS.invoice.customer, trn: "100000000000003" } }, SAMPLE_GARAGE, settings());
    expect(html).toContain("TRN");
    expect(html).toContain("VAT 5%");
    expect(html).toContain(amountInWords(SAMPLE_DOCUMENTS.invoice.totals.grossFils));
  });
});

describe("credit notes print the amounts they were credited at", () => {
  it("a promo line's credit shows its discounted amounts, not the list price", () => {
    const base = SAMPLE_DOCUMENTS.credit_note;
    const line = { ...base.lines[0]!, description: "Brake pads", qty: 1, unitPriceFils: 10000, discountPct: 0, netFils: 9000, vatFils: 450, grossFils: 9450 };
    const html = renderDocumentHtml({ ...base, lines: [line], totals: { netFils: 9000, vatFils: 450, grossFils: 9450 } }, SAMPLE_GARAGE, settings());
    expect(html).toContain("94.50");
    expect(html).not.toContain("105.00");
  });
});

describe("promo on the printed invoice", () => {
  it("each line shows its promo share in the discount column, so unit × qty less discounts is the amount", () => {
    const base = invoice();
    const line = { ...base.lines[0]!, description: "Service", kind: "labour" as const, qty: 1, unitPriceFils: 10000, discountPct: 0, promoFils: 1000 };
    const html = renderDocumentHtml({ ...base, lines: [line], promo: { code: "SERVICE10", kind: "percent", value: 10, appliesTo: "labour", discountFils: 1000 }, totals: { netFils: 9000, vatFils: 450, grossFils: 9450 } }, SAMPLE_GARAGE, settings());
    expect(html).toMatch(/Promo −10\.00/);
    expect(html).toContain("90.00");
  });
});

describe("purchase order in packs", () => {
  it("prints the packs and the price per pack", () => {
    const po = {
      id: "p1", number: "PO-00001", status: "sent", version: 1, notes: null, createdAt: "2026-11-21T08:00:00.000Z", updatedAt: "2026-11-21T08:00:00.000Z", createdBy: null,
      supplier: { id: "s1", name: "Lube Co", trn: null, phone: null, email: null, address: null, notes: null, isFleetfix: false, termsDays: 30, openingBalanceFils: 0, openingBalanceDate: null },
      editable: false, netFils: 332800,
      lines: [{ id: "l1", partId: "x", partNo: "5W30", description: "Engine oil 5W-30", qty: 416, jobDocumentId: null, unitCostFils: 800, netFils: 332800, packName: "Drum 208 L", packSize: 208 }],
    };
    const html = T.renderPurchaseOrderHtml(po as never, SAMPLE_GARAGE, settings());
    expect(html).toContain("2 × Drum 208 L");
    expect(html).toContain("1,664.00");
  });
});


describe("used parts on prints", () => {
  const used = (patch: object = {}) => ({
    kind: "part" as const, description: "Alternator", qty: 1, unitPriceFils: 30000, discountPct: 0, netFils: 30000, vatFils: 1500, grossFils: 31500,
    condition: "used" as const, poLineId: "po-line-1", purchaseOrderId: "po-1", purchaseOrderNumber: "PO-00077", costFils: 15000,
    purchasedOn: "2026-11-26", warrantyDays: 7, warrantyUntil: "2026-12-03", ...patch,
  });
  const html = (type: "estimate" | "jobcard" | "invoice", patch: object = {}, line: object = {}) =>
    renderDocumentHtml({ ...SAMPLE_DOCUMENTS[type], lines: [used(line)], ...patch }, SAMPLE_GARAGE, settings());

  it("estimates, job cards and credit notes say Used part; new parts say nothing", () => {
    for (const type of ["estimate", "jobcard"] as const) {
      expect(html(type)).toContain("Used part");
      expect(html(type)).not.toContain("warranty until");
      expect(html(type, {}, { condition: "new" })).not.toContain("Used part");
    }
    const cn = html("invoice", { type: "credit_note" });
    expect(cn).toContain("Used part");
    expect(cn).not.toContain("warranty until");
  });

  it("an invoice prints the warranty, judged on the day it was issued in Dubai", () => {
    const on = (issuedAt: string | null, line: object = {}) => html("invoice", { issuedAt, status: issuedAt ? "issued" : "draft" }, line);
    expect(on("2026-11-27T08:00:00.000Z")).toContain("Used part, warranty until 3 Dec 2026");
    expect(on("2026-12-03T19:59:00.000Z")).toContain("Used part, warranty until 3 Dec 2026");
    expect(on("2026-12-03T20:01:00.000Z")).toContain("Used part, no warranty remaining");
    expect(on("2026-11-27T08:00:00.000Z", { warrantyDays: null, warrantyUntil: null })).toMatch(/Used part, no warranty\s*[<·]/);
    const notBought = on("2026-11-27T08:00:00.000Z", { purchasedOn: null, warrantyDays: null, warrantyUntil: null });
    expect(notBought).toContain("Used part");
    expect(notBought).not.toContain("warranty until");
    expect(on(null, { purchasedOn: "2020-01-01", warrantyUntil: "2020-01-08" })).toContain("no warranty remaining");
  });

  it("never the purchase order or what it cost", () => {
    for (const h of [html("invoice", { issuedAt: "2026-11-27T08:00:00.000Z" }), html("jobcard"), html("estimate")]) {
      expect(h).not.toContain("PO-00077");
      expect(h).not.toContain("150.00");
    }
  });
});
