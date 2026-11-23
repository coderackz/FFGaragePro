import { describe, expect, it } from "vitest";
import { addressPartsFrom, addressPartsSchema, customerSchema, EMPTY_ADDRESS, formatAddress, sameAddress } from "../src/index";

describe("addresses", () => {
  it("prints as tidy lines", () => {
    expect(formatAddress({ ...EMPTY_ADDRESS, unit: "Warehouse 12", street: "Street 6", area: "Al Quoz Ind. 3", emirate: "dubai", poBox: "1234" })).toBe("Warehouse 12\nStreet 6, Al Quoz Ind. 3\nDubai, PO Box 1234");
    expect(formatAddress({ ...EMPTY_ADDRESS, unit: "Shop 4", building: "Al Noor Tower", country: "Oman" })).toBe("Shop 4, Al Noor Tower\nOman");
    expect(formatAddress({ ...EMPTY_ADDRESS, emirate: "sharjah", country: "United Arab Emirates" })).toBe("Sharjah");
    expect(formatAddress({ ...EMPTY_ADDRESS, poBox: "PO Box 55" })).toBe("PO Box 55");
    expect(formatAddress(EMPTY_ADDRESS)).toBeNull();
  });
  it("an emirate the address already names isn't said twice", () => {
    expect(formatAddress({ ...EMPTY_ADDRESS, street: "Al Quoz 3, Dubai", emirate: "dubai" })).toBe("Al Quoz 3, Dubai");
    expect(formatAddress({ ...EMPTY_ADDRESS, street: "Warehouse 4 Al Quoz Dubai", emirate: "dubai" })).toBe("Warehouse 4 Al Quoz Dubai");
    expect(formatAddress({ ...EMPTY_ADDRESS, street: "Al Quoz 3, Dubai, UAE", emirate: "dubai" })).toBe("Al Quoz 3, Dubai, UAE");
  });
  it("a place named after an emirate still prints the emirate", () => {
    expect(formatAddress({ ...EMPTY_ADDRESS, building: "Marina Tower", area: "Dubai Marina", emirate: "dubai" })).toBe("Marina Tower\nDubai Marina\nDubai");
    expect(formatAddress({ ...EMPTY_ADDRESS, street: "Dubai - Abu Dhabi Road", emirate: "abu_dhabi" })).toBe("Dubai - Abu Dhabi Road\nAbu Dhabi");
  });
  it("an old address shows in Street", () => {
    expect(addressPartsFrom("Warehouse 12\r\nDubai", EMPTY_ADDRESS)).toEqual({ ...EMPTY_ADDRESS, street: "Warehouse 12, Dubai" });
    expect(addressPartsFrom("x", { ...EMPTY_ADDRESS, area: "Al Quoz" })).toEqual({ ...EMPTY_ADDRESS, area: "Al Quoz" });
    expect(addressPartsFrom(null, EMPTY_ADDRESS)).toEqual(EMPTY_ADDRESS);
  });
  it("blank boxes are empty; the same parts are the same", () => {
    expect(addressPartsSchema.parse({ unit: " ", street: " Street 6 " })).toEqual({ ...EMPTY_ADDRESS, street: "Street 6" });
    expect(sameAddress({ ...EMPTY_ADDRESS, street: "a" }, { ...EMPTY_ADDRESS, street: "a" })).toBe(true);
    expect(sameAddress({ ...EMPTY_ADDRESS, street: "a" }, EMPTY_ADDRESS)).toBe(false);
    expect(customerSchema.parse({ name: "A" }).addressParts).toBeUndefined();
  });
});
