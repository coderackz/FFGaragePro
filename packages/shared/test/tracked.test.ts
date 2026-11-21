import { describe, expect, it } from "vitest";
import { dotAgeMonths, kitAvailable, lineSchema, oldestFirst, parseDot, partSchema, receiveSchema, splitUnitCodes, warrantyEnds } from "../src";

describe("tracked stock", () => {
  it("dot parse", () => {
    const today = "2026-11-21";
    expect(parseDot("2524", today)).toEqual({ week: 25, year: 2024, code: "2524" });
    expect(parseDot(" 25/24 ", today)).toEqual({ week: 25, year: 2024, code: "2524" });
    expect(parseDot("0126", today)).toEqual({ week: 1, year: 2026, code: "0126" });
    // Week 0 or 54, a 3-digit code, a date after today: not a DOT.
    for (const bad of ["0024", "5424", "524", "abcd", "4826", "0127"]) expect(parseDot(bad, today), bad).toBeNull();
  });

  it("split codes", () => {
    expect(splitUnitCodes("25 24, 26 24", "dot")).toEqual(["2524", "2624"]);
    expect(splitUnitCodes("2524 2624\n25/24;1025", "dot")).toEqual(["2524", "2624", "2524", "1025"]);
    expect(splitUnitCodes("SN 1\nSN-2, SN-3", "serial")).toEqual(["SN", "1", "SN-2", "SN-3"]);
  });

  it("oldest first", () => {
    expect(dotAgeMonths("2524", "2026-11-21")).toBe(29);
    const units = [
      { id: "a", code: "1025", receivedAt: "2026-01-01T00:00:00Z" },
      { id: "b", code: "4824", receivedAt: "2026-02-01T00:00:00Z" },
      { id: "c", code: "4824", receivedAt: "2025-12-01T00:00:00Z" },
      { id: "d", code: "SN-9", receivedAt: "2025-01-01T00:00:00Z" },
    ];
    // DOTs by week made, then the earlier delivery; anything that isn't a DOT by delivery, after them.
    expect(oldestFirst(units, "2026-11-21").map((u) => u.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("warranty end", () => {
    expect(warrantyEnds("2026-11-21", 24)).toBe("2028-11-21");
    expect(warrantyEnds("2026-01-31", 1)).toBe("2026-02-28");
    expect(warrantyEnds("2028-02-29", 12)).toBe("2029-02-28");
    expect(warrantyEnds("2026-11-21", 0)).toBeNull();
  });

  it("kit available", () => {
    const onHand = new Map([["filter", 3], ["oil", 10]]);
    expect(kitAvailable([{ partId: "filter", qty: 1 }, { partId: "oil", qty: 4.5 }], onHand)).toBe(2);
    expect(kitAvailable([{ partId: "filter", qty: 1 }, { partId: "gone", qty: 1 }], onHand)).toBe(0);
    expect(kitAvailable([], onHand)).toBe(0);
  });

  it("schemas", () => {
    const tyre = partSchema.parse({ partNo: "T1", name: "Tyre", stocked: true, sellPriceFils: 50000, tracking: "dot" });
    expect(tyre).toMatchObject({ tracking: "dot", warrantyMonths: 0, isKit: false, components: [] });
    // Old screens send none of these: nothing changes.
    expect(partSchema.parse({ partNo: "P", name: "P", stocked: true, sellPriceFils: 1 })).toMatchObject({ tracking: "none", isKit: false });
    // A kit isn't stocked or tracked itself.
    expect(partSchema.safeParse({ partNo: "K", name: "Kit", stocked: true, sellPriceFils: 1, isKit: true, components: [{ partId: crypto.randomUUID(), qty: 1 }] }).success).toBe(false);
    expect(partSchema.safeParse({ partNo: "K", name: "Kit", stocked: false, sellPriceFils: 1, isKit: true, components: [] }).success).toBe(false);
    const line = lineSchema.parse({ kind: "part", description: "Tyre", qty: 2, unitPriceFils: 1, unitIds: [crypto.randomUUID(), crypto.randomUUID()] });
    expect(line.unitIds).toHaveLength(2);
    expect(lineSchema.parse({ kind: "part", description: "x", qty: 1, unitPriceFils: 1 }).unitIds).toEqual([]);
    const rec = receiveSchema.parse({ lines: [{ poLineId: crypto.randomUUID(), qty: 2, unitCostFils: 1, units: ["2524", "2524"] }] });
    expect(rec.lines[0]!.units).toEqual(["2524", "2524"]);
  });
});
