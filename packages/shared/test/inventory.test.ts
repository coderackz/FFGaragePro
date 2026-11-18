import { describe, expect, it } from "vitest";
import { averageCost, can, formatPoNumber, lineSchema, partSchema, receiveSchema, requestPartSchema } from "../src/index";

describe("averageCost", () => {
  it("averages what's on hand with what came in", () => {
    expect(averageCost(1, 4000, 1, 5000)).toBe(4500);
  });
  it("takes the new cost when nothing is on hand", () => {
    expect(averageCost(0, 4000, 2, 5000)).toBe(5000);
    expect(averageCost(-2, 4000, 3, 6000)).toBe(6000);
  });
  it("rounds to whole fils", () => {
    expect(averageCost(2, 1000, 1, 1001)).toBe(1000);
    expect(averageCost(1, 1000, 2, 1001)).toBe(1001);
  });
});

describe("inventory permissions", () => {
  it("owner and accountant manage stock and purchases; advisors don't", () => {
    expect(can("owner", "inventory.edit")).toBe(true);
    expect(can("accountant", "inventory.edit")).toBe(true);
    expect(can("accountant", "purchases.manage")).toBe(true);
    expect(can("advisor", "inventory.edit")).toBe(false);
    expect(can("advisor", "purchases.manage")).toBe(false);
  });
});

describe("inventory schemas", () => {
  const line = { kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 3500, discountPct: 0 };

  it("a line defaults to garage-supplied with no part", () => {
    const parsed = lineSchema.parse(line);
    expect(parsed.suppliedBy).toBe("garage");
    expect(parsed.partId ?? null).toBeNull();
  });
  it("only part lines can be supplied by Fleet Fix", () => {
    expect(lineSchema.parse({ ...line, suppliedBy: "fleetfix" }).suppliedBy).toBe("fleetfix");
    expect(() => lineSchema.parse({ ...line, kind: "labour", suppliedBy: "fleetfix" })).toThrow();
  });
  it("a part needs a part number and name", () => {
    expect(() => partSchema.parse({ partNo: "", name: "Filter", stocked: true, sellPriceFils: 0 })).toThrow();
    const p = partSchema.parse({ partNo: "OF-1", name: "Filter", stocked: true, sellPriceFils: 3500 });
    expect(p.unit).toBe("each");
    expect(p.reorderLevel).toBe(0);
    expect(p.active).toBe(true);
  });
  it("receiving needs at least one line", () => {
    expect(() => receiveSchema.parse({ vatFils: 0, lines: [] })).toThrow();
  });
  it("a part request defaults to not already bought", () => {
    const r = requestPartSchema.parse({
      documentId: "11111111-1111-4111-8111-111111111111", position: 0,
      supplierId: "00000000-0000-4000-8000-0000000f1ee7", qty: 2,
    });
    expect(r.alreadyBought).toBe(false);
  });
  it("numbers purchase orders PO-00001", () => {
    expect(formatPoNumber(7)).toBe("PO-00007");
  });
});
