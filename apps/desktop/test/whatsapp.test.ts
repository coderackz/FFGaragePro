import { describe, expect, it } from "vitest";
import { uaePhone, whatsappUrl } from "../src/renderer/messages/whatsapp";

describe("uaePhone normalises", () => {
  it("UAE mobiles in any common form", () => {
    for (const raw of ["050 123 4567", "+971 50 123 4567", "00971501234567", "0501234567", "971-50-123-4567", "50 123 4567"]) {
      expect(uaePhone(raw), raw).toBe("971501234567");
    }
  });

  it("international numbers with + or 00 keep their country code", () => {
    expect(uaePhone("+44 7700 900123")).toBe("447700900123");
    expect(uaePhone("0091 98765 43210")).toBe("919876543210");
  });

  it("refuses rubbish and too-short numbers", () => {
    for (const raw of ["abc", "1234", "", "050-ABC-4567", "+12"]) expect(uaePhone(raw), raw).toBeNull();
  });
});

describe("whatsappUrl", () => {
  it("encodes Arabic and ampersands", () => {
    const url = whatsappUrl("971501234567", "Tom & Jerry — مرحبا");
    expect(url.startsWith("https://wa.me/971501234567?text=")).toBe(true);
    expect(decodeURIComponent(url.split("?text=")[1]!)).toBe("Tom & Jerry — مرحبا");
    expect(url).not.toContain(" ");
    expect(url).not.toMatch(/&(?!$)/);
  });
});
