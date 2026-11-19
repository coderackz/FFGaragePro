import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings, sectionRows, settingsSchemas } from "../src/index";

const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMAGE_ERROR = "Use a PNG or JPG image under 500 KB";

describe("settings", () => {
  it("every section has defaults", () => {
    expect(readSettings([])).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.documents.estimateValidDays).toBe(14);
    expect(DEFAULT_SETTINGS.numbering.invoicePrefix).toBe("INV");
    expect(DEFAULT_SETTINGS.security.idleLockMinutes).toBe(15);
    expect(DEFAULT_SETTINGS.inventory.belowZero).toBe("warn");
    expect(DEFAULT_SETTINGS.pricing.maxDiscountAdvisorPct).toBe(100);
  });

  it("reads stored values and ignores what it doesn't know", () => {
    const s = readSettings([
      { key: "pricing.labourRateFils", value: "18000" },
      { key: "pricing.futureThing", value: "1" },
      { key: "marketing.x", value: "1" },
      { key: "tax.returnPeriod", value: '"weekly"' },
      { key: "documents.terms", value: "not json" },
    ]);
    expect(s.pricing.labourRateFils).toBe(18000);
    expect(s.tax.returnPeriod).toBe("quarterly");
    expect(s.documents.terms).toBeNull();
  });

  it("sectionRows writes one row per field", () => {
    expect(sectionRows("inventory", { belowZero: "block" })).toEqual([
      { key: "inventory.belowZero", value: '"block"' },
      { key: "inventory.defaultReorderLevel", value: "0" },
    ]);
  });

  it("images: PNG/JPG under 500 KB only", () => {
    const docs = settingsSchemas.documents;
    expect(docs.parse({ logo: PNG_1x1 }).logo).toBe(PNG_1x1);
    expect(() => docs.parse({ logo: "data:image/gif;base64,R0lG" })).toThrow(IMAGE_ERROR);
    const big = `data:image/png;base64,${"A".repeat(Math.ceil((600 * 1024 * 4) / 3))}`;
    expect(() => docs.parse({ logo: big })).toThrow(IMAGE_ERROR);
    expect(() => docs.parse({ logo: "data:image/png;base64,%%%" })).toThrow(IMAGE_ERROR);
  });

  it("IBAN is normalised and checked", () => {
    const g = settingsSchemas.garage;
    expect(g.parse({ iban: "ae07 0260 0010 1234 5678 901" }).iban).toBe("AE070260001012345678901");
    expect(() => g.parse({ iban: "GB00 1234" })).toThrow("A UAE IBAN is AE followed by 21 digits");
    expect(g.parse({ iban: "" }).iban).toBeNull();
  });

  it("prefixes must differ", () => {
    const n = settingsSchemas.numbering;
    expect(() => n.parse({ invoicePrefix: "JC" })).toThrow("Each document type needs its own prefix");
    expect(() => n.parse({ invoicePrefix: "inv" })).toThrow();
  });
});
