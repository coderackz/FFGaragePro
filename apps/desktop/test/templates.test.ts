import { DEFAULT_SETTINGS, type Settings } from "@ffgp/shared";
import { describe, expect, it } from "vitest";
import { SAMPLE_DOCUMENTS, SAMPLE_GARAGE } from "../src/renderer/print/sample";
import { renderDocumentHtml } from "../src/renderer/print/templates";

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
    expect(renderDocumentHtml(invoice("paid"), SAMPLE_GARAGE, settings())).toContain(">PAID<");
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
});
