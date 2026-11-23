import { afterEach, describe, expect, it } from "vitest";
import { clearLocalDraft, draftKey, readLocalDraft, readyToCreate, writeLocalDraft } from "../src/renderer/lib/autosave";

function stubStorage(throws = false) {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => { if (throws) throw new Error("blocked"); return data.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (throws) throw new Error("blocked"); data.set(k, v); },
    removeItem: (k: string) => { if (throws) throw new Error("blocked"); data.delete(k); },
  };
  return data;
}
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

describe("auto-save helpers", () => {
  it("a key per garage and document; a new one per type", () => {
    expect(draftKey("g1", "d1", "jobcard")).toBe("ffgp.docdraft.g1.d1");
    expect(draftKey("g1", null, "estimate")).toBe("ffgp.docdraft.g1.new-estimate");
  });

  it("a new document is created once it has a customer and a line with a title", () => {
    expect(readyToCreate({ customer: null, lines: [{ description: "Brakes" }] })).toBe(false);
    expect(readyToCreate({ customer: { id: "c" }, lines: [{ description: "  " }] })).toBe(false);
    expect(readyToCreate({ customer: { id: "c" }, lines: [{ description: "" }, { description: "Brakes" }] })).toBe(true);
  });

  it("the copy on this PC: written, read back with when, cleared", () => {
    stubStorage();
    writeLocalDraft("k", { notes: "x" });
    const back = readLocalDraft<{ notes: string }>("k");
    expect(back?.draft).toEqual({ notes: "x" });
    expect(Number.isNaN(Date.parse(back!.savedAt))).toBe(false);
    clearLocalDraft("k");
    expect(readLocalDraft("k")).toBeNull();
  });

  it("storage that refuses (private window, blocked) never breaks the screen", () => {
    stubStorage(true);
    expect(() => writeLocalDraft("k", { a: 1 })).not.toThrow();
    expect(readLocalDraft("k")).toBeNull();
    expect(() => clearLocalDraft("k")).not.toThrow();
  });
});
