import { describe, expect, it } from "vitest";
import { correctMake, correctModel, fitmentMatches, makeFromVin, makeOfModel, nameKey } from "../src";

describe("vehicle names", () => {
  it("compares names without capitals, spaces or punctuation", () => {
    expect(nameKey("Land Cruiser")).toBe(nameKey("LANDCRUISER"));
    expect(nameKey("land-cruiser")).toBe(nameKey("Land  Cruiser"));
    expect(fitmentMatches({ make: "Toyota", model: "Land Cruiser" }, { make: "TOYOTA", model: "LANDCRUISER", year: null, engine: null })).toBe(true);
  });

  it("makes: the list's spelling silently, short names and misspellings with a note", () => {
    expect(correctMake("toyota", [])).toEqual({ value: "Toyota", note: false });
    expect(correctMake("Toyota", [])).toBeNull();
    expect(correctMake("Toyta", [])).toEqual({ value: "Toyota", note: true });
    expect(correctMake("Mitsubshi", [])).toEqual({ value: "Mitsubishi", note: true });
    expect(correctMake("Merc", [])).toEqual({ value: "Mercedes-Benz", note: true });
    expect(correctMake("vw", [])).toEqual({ value: "Volkswagen", note: true });
    expect(correctMake("Chevy", [])).toEqual({ value: "Chevrolet", note: true });
    expect(correctMake("Zxqvbn", [])).toBeNull();
  });

  it("makes: the garage's own names are known and corrected to; two equally close names are left alone", () => {
    expect(correctMake("Toyta", ["Toyta"])).toBeNull();
    expect(correctMake("Forthin", ["Forthing"])).toEqual({ value: "Forthing", note: true });
    expect(correctMake("Abcdx", ["Abcde", "Abcdf"])).toBeNull();
    expect(correctMake("Ki", [])).toBeNull(); // too short to guess
  });

  it("models: within the make only, with short names", () => {
    expect(correctModel("landcruser", "Toyota", [])).toEqual({ value: "Land Cruiser", note: true });
    expect(correctModel("LC200", "Toyota", [])).toEqual({ value: "Land Cruiser", note: true });
    expect(correctModel("prado", "toyota", [])).toEqual({ value: "Land Cruiser Prado", note: true });
    expect(correctModel("camry", "Toyota", [])).toEqual({ value: "Camry", note: false });
    expect(correctModel("Patrol", "Toyota", [])).toBeNull();
    expect(correctModel("Sunny", "", [])).toBeNull();
    expect(correctModel("T2x", "Jetour", [{ make: "Jetour", name: "T2" }])).toEqual({ value: "T2", note: true });
    expect(correctModel("Ultra", "Rox", [])).toBeNull();
  });

  it("a model's make when only one make has it", () => {
    expect(makeOfModel("Land Cruiser")).toBe("Toyota");
    expect(makeOfModel("lc200")).toBe("Toyota");
    expect(makeOfModel("Patrol")).toBe("Nissan");
    expect(makeOfModel("X3")).toBeNull(); // BMW and Kaiyi
    expect(makeOfModel("Unknown car")).toBeNull();
  });

  it("the make from the VIN's manufacturer code", () => {
    expect(makeFromVin("JTMHV05J904123456")).toBe("Toyota");
    expect(makeFromVin("JTJHY7AX4H4123456")).toBe("Lexus");
    expect(makeFromVin("WDD2050461A123456")).toBe("Mercedes-Benz");
    expect(makeFromVin("kmhd841cbku123456")).toBe("Hyundai");
    expect(makeFromVin("SALGA2BE5KA123456")).toBe("Land Rover");
    expect(makeFromVin("ZZZ12345678901234")).toBeNull();
    expect(makeFromVin("JT")).toBeNull();
  });
});
