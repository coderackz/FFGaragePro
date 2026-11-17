import { describe, expect, it } from "vitest";
import { can, formatDocNumber } from "../src/index";

describe("document numbers", () => {
  it("pads per type", () => {
    expect(formatDocNumber("invoice", 7)).toBe("INV-00007");
    expect(formatDocNumber("estimate", 12345)).toBe("EST-12345");
    expect(formatDocNumber("jobcard", 123456)).toBe("JC-123456");
  });
});

describe("permissions", () => {
  it("restricts by role", () => {
    expect(can("advisor", "users.manage")).toBe(false);
    expect(can("owner", "users.manage")).toBe(true);
    expect(can("accountant", "payments.record")).toBe(true);
    expect(can("advisor", "payments.record")).toBe(false);
    expect(can("advisor", "documents.edit")).toBe(true);
    expect(can("advisor", "costs.view")).toBe(false);
  });
});
