import { describe, expect, it } from "vitest";
import { vatSheet } from "../src/renderer/books/vatSheet";

const row = (n: string, amountFils: number, vatFils: number) => ({ entryId: n, number: n, date: "2026-10-12", narration: `Entry ${n}`, amountFils, vatFils, adjustmentFils: 0, originalDate: null });
const figures = {
  from: "2026-10-01", to: "2026-10-31", payableFils: -5000, dueFils: 0, recoverableFils: 5000,
  boxes: [
    { key: "1b", label: "Standard rated supplies in Dubai", amountFils: 0, vatFils: 0, adjustmentFils: 0, rows: [] },
    { key: "9", label: "Standard rated expenses", amountFils: 100000, vatFils: 5000, adjustmentFils: 0, rows: [row("JV-00001", 60000, 3000), row("JV-00002", 40000, 2000)] },
  ],
};

describe("VAT return as Excel", () => {
  it("the boxes, boxes 12–14, then each box's entries", () => {
    const s = vatSheet(figures, { filedAt: null, reference: null });
    const boxes = s.rows.map((r) => r.box);
    expect(boxes.slice(0, 5)).toEqual(["1b", "9", "12", "13", "14"]);
    expect(s.rows.find((r) => r.box === "14")).toMatchObject({ label: "Refundable tax for the period", vat: 5000 });
    const entries = s.rows.filter((r) => r.entry);
    expect(entries).toEqual([
      expect.objectContaining({ box: "9", entry: "JV-00001", label: "Entry JV-00001", amount: 60000, vat: 3000 }),
      expect.objectContaining({ box: "9", entry: "JV-00002", amount: 40000, vat: 2000 }),
    ]);
    expect(s.subtitle).toBe("Not filed");
  });
});
