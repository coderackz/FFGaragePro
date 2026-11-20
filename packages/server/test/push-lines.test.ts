import { describe, expect, it } from "vitest";
import { providerLine } from "../src/integrations/push";

const line = (qty: number, unitFils: number, netFils: number, discountPct = 0) => ({ kind: "labour" as const, description: "Service", qty, unitFils, discountPct, netFils, vatFils: 0, grossFils: netFils });

describe("lines as providers get them", () => {
  it("qty × unit only when that is exactly the net", () => {
    expect(providerLine(line(1.5, 3000, 4500))).toEqual({ description: "Service", quantity: 1.5, rateFils: 3000 });
    // 1.5 × 33.33 = 49.995: rounded to 50.00 here, so it goes as one line at its net.
    expect(providerLine(line(1.5, 3333, 5000))).toEqual({ description: "Service (1.5 × AED 33.33)", quantity: 1, rateFils: 5000 });
    expect(providerLine(line(2, 5000, 9000, 10))).toEqual({ description: "Service (2 × AED 50.00, less 10%)", quantity: 1, rateFils: 9000 });
  });
});
