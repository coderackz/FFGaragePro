import { describe, expect, it } from "vitest";
import { defaultUnit, lineSchema, UNIT_SUGGESTIONS } from "../src/index";

describe("line units", () => {
  it("defaults: labour Hr, other Pc, a part its own unit with each as Pc", () => {
    expect(defaultUnit("labour")).toBe("Hr");
    expect(defaultUnit("other")).toBe("Pc");
    expect(defaultUnit("part", "litre")).toBe("litre");
    expect(defaultUnit("part", "each")).toBe("Pc");
    expect(defaultUnit("part", null)).toBe("Pc");
    expect(UNIT_SUGGESTIONS).toEqual(["Pc", "Set", "Pair", "Box", "Litre", "Kg", "Metre", "Hr", "Job"]);
  });

  it("a line's description and unit: absent stays absent (kept by the server), blank becomes null", () => {
    const base = { kind: "labour", description: "Brakes", qty: 1, unitPriceFils: 100 };
    const absent = lineSchema.parse(base);
    expect(absent.details).toBeUndefined();
    expect(absent.unit).toBeUndefined();
    expect(lineSchema.parse({ ...base, details: "   ", unit: " " })).toMatchObject({ details: null, unit: null });
    expect(lineSchema.parse({ ...base, details: "Pads\nDiscs  ", unit: " Hr " })).toMatchObject({ details: "Pads\nDiscs", unit: "Hr" });
    expect(lineSchema.safeParse({ ...base, details: "x".repeat(2001) }).success).toBe(false);
    expect(lineSchema.safeParse({ ...base, unit: "x".repeat(13) }).success).toBe(false);
  });
});
