import { describe, expect, it } from "vitest";
import { amountInWords } from "../src";

describe("amountInWords", () => {
  const cases: [number, string, string][] = [
    [0, "Zero dirhams only", "فقط صفر درهم لا غير"],
    [1, "One fils only", "فقط فلس واحد لا غير"],
    [50, "Fifty fils only", "فقط خمسون فلساً لا غير"],
    [100, "One dirham only", "فقط درهم واحد لا غير"],
    [200, "Two dirhams only", "فقط درهمان لا غير"],
    [300, "Three dirhams only", "فقط ثلاثة دراهم لا غير"],
    [1100, "Eleven dirhams only", "فقط أحد عشر درهماً لا غير"],
    [10000, "One hundred dirhams only", "فقط مائة درهم لا غير"],
    [20000, "Two hundred dirhams only", "فقط مائتا درهم لا غير"],
    [123450, "One thousand two hundred thirty-four dirhams and fifty fils only", "فقط ألف ومائتان وأربعة وثلاثون درهماً وخمسون فلساً لا غير"],
    [200000, "Two thousand dirhams only", "فقط ألفا درهم لا غير"],
    [525000, "Five thousand two hundred fifty dirhams only", "فقط خمسة آلاف ومائتان وخمسون درهماً لا غير"],
    [1200000, "Twelve thousand dirhams only", "فقط اثنا عشر ألف درهم لا غير"],
    [100000025, "One million dirhams and twenty-five fils only", "فقط مليون درهم وخمسة وعشرون فلساً لا غير"],
  ];
  it.each(cases)("%i fils", (fils, en, ar) => {
    expect(amountInWords(fils, "en")).toBe(en);
    expect(amountInWords(fils, "ar")).toBe(ar);
  });
  it("two hundred thousand / million use the construct form (review fix)", () => {
    expect(amountInWords(20000000, "ar")).toBe("فقط مائتا ألف درهم لا غير");
    expect(amountInWords(20050000, "ar")).toBe("فقط مائتا ألف وخمسمائة درهم لا غير");
    expect(amountInWords(120000000, "ar")).toBe("فقط مليون ومائتا ألف درهم لا غير");
    expect(amountInWords(20000000000, "ar")).toBe("فقط مائتا مليون درهم لا غير");
  });
  it("negative amounts use the absolute value", () => expect(amountInWords(-100, "en")).toBe("One dirham only"));
});
