import { describe, expect, it } from "vitest";
import { defaultPurchaseVat, lineSchema, usedPartText, usedPurchaseSchema, warrantyState, warrantyUntil } from "../src/index";

const ID = "00000000-0000-4000-8000-000000000001";

describe("used part warranty", () => {
  it("runs from the purchase date, the last day included", () => {
    expect(warrantyUntil("2026-11-26", 7)).toBe("2026-12-03");
    expect(warrantyUntil("2026-11-26", null)).toBeNull();
    expect(["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"].map((d) => warrantyState("2026-12-03", d))).toEqual(["ok", "ending", "ending", "ended"]);
    expect(warrantyState(null, "2026-12-01")).toBe("none");
  });

  it("prints in words", () => {
    const used = { condition: "used" as const, purchasedOn: "2026-11-26", warrantyDays: 7 };
    expect(usedPartText(used, "estimate", "2026-12-01")).toEqual({ en: "Used part", ar: "قطعة مستعملة" });
    expect(usedPartText(used, "jobcard", "2026-12-01")).toEqual({ en: "Used part", ar: "قطعة مستعملة" });
    expect(usedPartText(used, "credit_note", "2026-12-01")!.en).toBe("Used part");
    expect(usedPartText(used, "invoice", "2026-12-03")).toEqual({ en: "Used part, warranty until 3 Dec 2026", ar: "قطعة مستعملة، الضمان حتى 3 Dec 2026" });
    expect(usedPartText(used, "invoice", "2026-12-04")).toEqual({ en: "Used part, no warranty remaining", ar: "قطعة مستعملة، انتهى الضمان" });
    expect(usedPartText({ ...used, warrantyDays: null }, "invoice", "2026-12-01")).toEqual({ en: "Used part, no warranty", ar: "قطعة مستعملة، بدون ضمان" });
    expect(usedPartText({ ...used, purchasedOn: null, warrantyDays: null }, "invoice", "2026-12-01")!.en).toBe("Used part");
    expect(usedPartText({ ...used, condition: "new" }, "invoice", "2026-12-01")).toBeNull();
  });
});

describe("VAT on a purchase", () => {
  it("starts at 0 without a TRN, except Fleet Fix", () => {
    expect(defaultPurchaseVat(15000, { trn: null, isFleetfix: false }, 500)).toBe(0);
    expect(defaultPurchaseVat(15000, { trn: "100123456700003", isFleetfix: false }, 500)).toBe(750);
    expect(defaultPurchaseVat(15000, { trn: null, isFleetfix: true }, 500)).toBe(750);
  });
});

describe("used lines and purchases as sent", () => {
  const line = { kind: "part", description: "Alternator", qty: 1, unitPriceFils: 30000, condition: "used" };
  it("a used line has no part, no units and isn't Fleet Fix's", () => {
    expect(lineSchema.safeParse(line).success).toBe(true);
    expect(lineSchema.parse({ ...line, condition: undefined }).condition).toBeUndefined();
    for (const bad of [{ partId: ID }, { suppliedBy: "fleetfix" }, { kind: "labour" }, { unitIds: [ID] }]) {
      expect(lineSchema.safeParse({ ...line, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a purchase needs its warranty chosen and a full bill", () => {
    const p = {
      documentId: ID, position: 0, description: "Alternator", qty: 1, seller: { name: "Al Sajaa", phone: "0501234567" },
      unitCostFils: 15000, purchasedOn: "2026-11-26", bill: null, warrantyDays: 7,
    };
    const ok = (x: object) => usedPurchaseSchema.safeParse({ ...p, ...x }).success;
    expect(ok({})).toBe(true);
    expect(ok({ warrantyDays: null })).toBe(true);
    expect(ok({ seller: { supplierId: ID } })).toBe(true);
    expect(ok({ bill: { trn: "100123456700003", invoiceNo: "A-1", vatFils: 750 } })).toBe(true);
    for (const bad of [
      { warrantyDays: undefined }, { warrantyDays: 0 }, { warrantyDays: 366 }, { bill: undefined }, { purchasedOn: "26/11/2026" },
      { bill: { trn: "10012345670000", invoiceNo: "A-1", vatFils: 750 } }, { bill: { trn: "100123456700003", invoiceNo: "", vatFils: 750 } },
      { seller: { name: "", phone: "0501234567" } }, { qty: 0 },
    ]) expect(ok(bad), JSON.stringify(bad)).toBe(false);
  });
});
