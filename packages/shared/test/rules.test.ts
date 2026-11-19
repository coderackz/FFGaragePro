import { describe, expect, it } from "vitest";
import { can, formatDocNumber, formatPoNumber } from "../src/index";

describe("document numbers", () => {
  it("pads per type", () => {
    expect(formatDocNumber("invoice", 7)).toBe("INV-00007");
    expect(formatDocNumber("estimate", 12345)).toBe("EST-12345");
    expect(formatDocNumber("jobcard", 123456)).toBe("JC-123456");
  });
  it("adds a device series when there is one", () => {
    expect(formatDocNumber("invoice", 3, "P1")).toBe("INV-P1-00003");
    expect(formatDocNumber("invoice", 3, "")).toBe("INV-00003");
    expect(formatPoNumber(4, "P2")).toBe("PO-P2-00004");
  });
  it("uses the garage's own prefix when given", () => {
    expect(formatDocNumber("invoice", 12, "", "TI")).toBe("TI-00012");
    expect(formatPoNumber(5, "", "LPO")).toBe("LPO-00005");
  });
});

describe("activity log permission", () => {
  it("only the owner sees the activity log", () => {
    expect(can("owner", "audit.view")).toBe(true);
    expect(can("accountant", "audit.view")).toBe(false);
    expect(can("advisor", "audit.view")).toBe(false);
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
