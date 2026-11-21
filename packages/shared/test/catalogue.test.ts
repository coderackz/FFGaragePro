import { describe, expect, it } from "vitest";
import { categorySchema, fitmentMatches, normalizeNumber, packToBase, partSchema, poLineNetFils, specText } from "../src";

describe("catalogue", () => {
  it("normalize", () => {
    expect(normalizeNumber(" 04152-yzza1 ")).toBe("04152YZZA1");
    expect(normalizeNumber("W 68/3")).toBe("W683");
    expect(normalizeNumber("0 986.494.123")).toBe("0986494123");
  });

  it("fitment match", () => {
    const lc = { make: "Toyota", model: "Land Cruiser", yearFrom: 2016, yearTo: 2021, engine: "1GR-FE" };
    expect(fitmentMatches(lc, { make: "TOYOTA", model: "land  cruiser", year: 2018, engine: "1gr-fe" })).toBe(true);
    expect(fitmentMatches(lc, { make: "Toyota", model: "Land Cruiser", year: 2022, engine: null })).toBe(false);
    // The engine only counts when both sides have one; a vehicle without a year still matches on make and model.
    expect(fitmentMatches(lc, { make: "Toyota", model: "Land Cruiser", year: 2018, engine: null })).toBe(true);
    expect(fitmentMatches(lc, { make: "Toyota", model: "Land Cruiser", year: null, engine: null })).toBe(true);
    expect(fitmentMatches(lc, { make: "Toyota", model: "Land Cruiser", year: 2018, engine: "2UZ-FE" })).toBe(false);
    // Open fields mean "any".
    expect(fitmentMatches({ make: "Nissan", model: null, yearFrom: null, yearTo: null, engine: null }, { make: "nissan", model: "Patrol", year: 2010, engine: null })).toBe(true);
    expect(fitmentMatches({ make: "Nissan", model: "Patrol", yearFrom: 2010, yearTo: null, engine: null }, { make: "Nissan", model: "Patrol", year: 2009, engine: null })).toBe(false);
    expect(fitmentMatches(lc, { make: null, model: null, year: null, engine: null })).toBe(false);
  });

  it("spec text tyre size", () => {
    const tyre = [
      { key: "width", label: "Width", type: "number" as const }, { key: "profile", label: "Profile", type: "number" as const },
      { key: "rim", label: "Rim", type: "number" as const }, { key: "load", label: "Load index", type: "text" as const },
    ];
    expect(specText({ width: 265, profile: 65, rim: 17, load: "112" }, tyre)).toBe("265/65R17 2656517 265 65 17 112");
    expect(specText({ grade: "5W-30" }, [{ key: "grade", label: "Grade", type: "text" }])).toBe("5W-30 5W30");
    expect(specText({}, [])).toBe("");
  });

  it("packs", () => {
    expect(packToBase(2, 208, 166400)).toEqual({ qty: 416, unitCostFils: 800 });
    expect(packToBase(3, 12, 1000)).toEqual({ qty: 36, unitCostFils: 83 });
    // Priced per pack: exactly 3 × AED 10.00.
    expect(poLineNetFils({ qty: 36, unitCostFils: 83, packSize: 12, packCostFils: 1000 })).toBe(3000);
    // Part of a box, a changed unit cost, or no pack price: per unit.
    expect(poLineNetFils({ qty: 30, unitCostFils: 83, packSize: 12, packCostFils: 1000 })).toBe(2490);
    expect(poLineNetFils({ qty: 36, unitCostFils: 90, packSize: 12, packCostFils: 1000 })).toBe(3240);
    expect(poLineNetFils({ qty: 36, unitCostFils: 83, packSize: 12, packCostFils: null })).toBe(2988);
    expect(poLineNetFils({ qty: 4.5, unitCostFils: 800 })).toBe(3600);
  });

  it("schemas", () => {
    const part = partSchema.parse({
      partNo: "OF-1", name: "Oil filter", stocked: true, sellPriceFils: 2500,
      numbers: [{ number: "04152-YZZA1", kind: "oem" }], fitments: [{ make: "Toyota", model: "Land Cruiser", yearFrom: 2016, yearTo: 2021 }],
      packs: [{ name: "Box of 10", size: 10 }], attributes: { type: "Oil" },
    });
    expect(part.numbers[0]).toMatchObject({ number: "04152-YZZA1", kind: "oem", brand: null });
    expect(partSchema.parse({ partNo: "X", name: "X", stocked: false, sellPriceFils: 0 })).toMatchObject({ numbers: [], fitments: [], packs: [], attributes: {}, categoryId: null });
    expect(() => partSchema.parse({ partNo: "X", name: "X", stocked: false, sellPriceFils: 0, fitments: [{ make: "Toyota", yearFrom: 2021, yearTo: 2016 }] })).toThrow();
    expect(() => partSchema.parse({ partNo: "X", name: "X", stocked: false, sellPriceFils: 0, fitments: [{ make: "" }] })).toThrow();
    expect(categorySchema.parse({ name: "Tyres", attributes: [{ key: "width", label: "Width", type: "number", unit: "mm" }] }).attributes[0]).toMatchObject({ key: "width" });
  });
});
