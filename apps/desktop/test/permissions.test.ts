import { describe, expect, it } from "vitest";
import { allowed, visible } from "../src/renderer/lib/permissions";

describe("read-only permissions in the browser app (review #6)", () => {
  it("a read-only owner still sees Users and Settings but can't change them", () => {
    expect(visible("owner", "users.manage")).toBe(true);
    expect(visible("owner", "settings.manage")).toBe(true);
    expect(allowed("owner", "users.manage", true)).toBe(false);
    expect(allowed("owner", "reports.view", true)).toBe(true);
    expect(allowed("owner", "users.manage", false)).toBe(true);
  });
  it("roles still limit what is visible", () => {
    expect(visible("advisor", "users.manage")).toBe(false);
  });
});
