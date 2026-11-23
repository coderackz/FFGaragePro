import { describe, expect, it } from "vitest";
import {
  changedProblem, checkEmail, checkEmiratesId, checkIban, checkOdometer, checkPhone, checkPlate, checkTrn, checkYear, formatEmiratesId, formatIban, formatPhone, formatPlate, formatTrn,
  parsePhone, parsePlate, phoneDigits, vinNote,
} from "../src/index";

describe("phones", () => {
  it("a UAE number typed any common way is the same number", () => {
    expect(parsePhone("050 123 4567")).toEqual({ iso: "AE", national: "501234567" });
    for (const t of ["+971501234567", "00971 50 123 4567", "971501234567", "501234567", "+971 (0)50-123-4567"]) expect(parsePhone(t)?.national).toBe("501234567");
  });
  it("is written one way", () => {
    expect(formatPhone(parsePhone("0501234567")!)).toBe("+971 50 123 4567");
    expect(formatPhone(parsePhone("04 321 0000")!)).toBe("+971 4 321 0000");
    expect(formatPhone(parsePhone("800 4357")!)).toBe("800 4357");
    expect(formatPhone(parsePhone("600 512345")!)).toBe("600 512345");
    expect(formatPhone(parsePhone("+91 98765 43210")!)).toBe("+91 9876543210");
    for (const t of ["050 123 4567", "04 321 0000", "800 4357", "+91 98765 43210"]) expect(parsePhone(formatPhone(parsePhone(t)!))).toEqual(parsePhone(t));
  });
  it("other countries need their code; two numbers or words aren't a number", () => {
    expect(parsePhone("+91 98765 43210")).toEqual({ iso: "IN", national: "9876543210" });
    expect(parsePhone("050 123 4567 / 055 1112222")).toBeNull();
    expect(parsePhone("Ali's office")).toBeNull();
    expect(parsePhone("")).toBeNull();
  });
  it("says what's wrong", () => {
    expect(checkPhone("")).toBeNull();
    expect(checkPhone("050 123 4567")).toBeNull();
    expect(checkPhone("050 123 456")).toBe("A UAE mobile has 10 digits, like 050 123 4567");
    expect(checkPhone("abc")).toBe("That isn't a phone number");
  });
  it("is searched by its digits", () => {
    for (const t of ["0501234567", "+971 50 123 4567", "00971501234567", "50 123 4567"]) expect(phoneDigits(t)).toBe("501234567");
    expect(phoneDigits("Ahmed")).toBe("");
  });
});

describe("plates", () => {
  it("reads the emirate, code and number", () => {
    expect(parsePlate("dxb k 48213")).toEqual({ emirate: "DXB", code: "K", number: "48213" });
    expect(parsePlate("DXB K48213")).toEqual({ emirate: "DXB", code: "K", number: "48213" });
    expect(parsePlate("Dubai AA 5")).toEqual({ emirate: "DXB", code: "AA", number: "5" });
    expect(parsePlate("AUH 12 34567")).toEqual({ emirate: "AUH", code: "12", number: "34567" });
    expect(parsePlate("Abu Dhabi 34567")).toEqual({ emirate: "AUH", code: "", number: "34567" });
    expect(parsePlate("KSA 1234 ABC")).toBeNull();
    expect(parsePlate("DXB K 482133")).toBeNull();
  });
  it("is written one way", () => {
    expect(formatPlate({ emirate: "SHJ", code: "3", number: "12345" })).toBe("SHJ 3 12345");
    expect(formatPlate({ emirate: "AUH", code: "", number: "34567" })).toBe("AUH 34567");
  });
  it("a UAE plate is checked; one from elsewhere is as typed", () => {
    expect(checkPlate("DXB K 482133")).toBe("A UAE plate is a code (like K or 12) and up to 5 digits");
    expect(checkPlate("DXB K 48213")).toBeNull();
    expect(checkPlate("KSA 1234 ABC")).toBeNull();
  });
});

describe("other numbers", () => {
  it("TRN", () => {
    expect(checkTrn("100123456700003")).toBeNull();
    expect(checkTrn("100 1234 5670 0003")).toBeNull();
    expect(checkTrn("1001234567")).toBe("A UAE TRN has 15 digits (this has 10)");
    expect(checkTrn("10012345670000X")).toBe("A UAE TRN has digits only");
    expect(formatTrn("100123456700003")).toBe("100 1234 5670 0003");
  });
  it("IBAN, with its check digits", () => {
    expect(checkIban("AE07 0331 2345 6789 0123 456")).toBeNull();
    expect(checkIban("ae070331234567890123456")).toBeNull();
    expect(checkIban("AE08 0331 2345 6789 0123 456")).toMatch(/check digits/);
    expect(checkIban("AE07 0331")).toBe("A UAE IBAN is AE followed by 21 digits");
    expect(formatIban("ae070331234567890123456")).toBe("AE07 0331 2345 6789 0123 456");
  });
  it("VIN is only noted", () => {
    expect(vinNote("GRJ76-1234567")).toBe("A VIN usually has 17 characters (this has 13)");
    expect(vinNote("JTMHV05J604012345")).toBeNull();
    expect(vinNote("JTMHV05J6O4012345")).toBe("A VIN doesn't use the letters I, O or Q");
    expect(vinNote("")).toBeNull();
  });
  it("year, odometer, Emirates ID, email", () => {
    expect(checkYear("2021")).toBeNull();
    expect(checkYear("1890")).not.toBeNull();
    expect(checkYear("21")).not.toBeNull();
    expect(checkOdometer("84,250")).toBeNull();
    expect(checkOdometer("12 km")).not.toBeNull();
    expect(checkEmiratesId("784-1990-1234567-1")).toBeNull();
    expect(checkEmiratesId("123")).toBe("An Emirates ID has 15 digits starting 784");
    expect(formatEmiratesId("784199012345671")).toBe("784-1990-1234567-1");
    expect(checkEmail("a@b.ae")).toBeNull();
    expect(checkEmail("a@b")).toBe("Enter an email like name@company.ae");
  });
  it("a value that was already wrong isn't a problem until it's changed", () => {
    expect(changedProblem("123", "123", checkTrn)).toBeNull();
    expect(changedProblem("123", "1234", checkTrn)).not.toBeNull();
    expect(changedProblem(null, "", checkTrn)).toBeNull();
    expect(changedProblem("123", "", checkTrn)).toBeNull();
  });
});
