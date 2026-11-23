import { describe, expect, it } from "vitest";
import { mergeSavedLines, sentLines } from "../src/renderer/lib/documentDraft";
import type { DocLine } from "../src/renderer/lib/types";

const l = (p: Partial<DocLine> = {}): DocLine => ({ kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0, unit: "Hr", ...p });

describe("what's typed and what was saved", () => {
  it("blank lines aren't sent; titles are trimmed", () => {
    expect(sentLines([l({ description: " Brakes " }), l({ description: "", unitPriceFils: 0 })]).map((x) => x.description)).toEqual(["Brakes"]);
  });

  it("the same lines saved: what's typed stays as typed, and the server's figures come in", () => {
    const merged = mergeSavedLines([l({ description: "Replace ", details: "Front\n" })], [l({ id: "a", description: "Replace", details: "Front", netFils: 10000, promoFils: 500 })]);
    expect(merged).toEqual([expect.objectContaining({ id: "a", description: "Replace ", details: "Front\n", netFils: 10000, promoFils: 500 })]);
  });

  it("a line not typed in yet stays where it is", () => {
    const blank = l({ kind: "other", description: "", unitPriceFils: 0, unit: "Pc" });
    const merged = mergeSavedLines([blank, l()], [l({ id: "a" })]);
    expect(merged?.map((x) => x.id)).toEqual([undefined, "a"]);
  });

  it("a part requested meanwhile: its order comes in", () => {
    const part = l({ kind: "part", description: "Filter", unit: "Pc" });
    expect(mergeSavedLines([part], [{ ...part, id: "a", poLineId: "po", orderStatus: "on_order" }])?.[0]).toMatchObject({ poLineId: "po", orderStatus: "on_order" });
  });

  it("different lines (someone else's change): nothing to merge", () => {
    expect(mergeSavedLines([l()], [l({ unitPriceFils: 20000 })])).toBeNull();
    expect(mergeSavedLines([l()], [l({ description: "Other work" })])).toBeNull();
    expect(mergeSavedLines([l()], [l(), l()])).toBeNull();
    expect(mergeSavedLines([l({ details: "a" })], [l({ details: "b" })])).toBeNull();
  });
});
