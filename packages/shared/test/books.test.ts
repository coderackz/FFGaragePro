import { describe, expect, it } from "vitest";
import { can, DEFAULT_CHART, DEFAULT_SETTINGS, journalDraftSchema, SYSTEM_ACCOUNTS } from "../src";

const TYPE_BY_DIGIT = { "1": "asset", "2": "liability", "3": "equity", "4": "income", "5": "cost_of_sales", "6": "expense" } as const;

describe("chart of accounts", () => {
  it("chart: system accounts are in it, codes unique, ids fixed, type follows the code", () => {
    const ids = new Set(DEFAULT_CHART.map((a) => a.id));
    for (const a of Object.values(SYSTEM_ACCOUNTS)) expect(ids.has(a.id)).toBe(true);
    expect(new Set(DEFAULT_CHART.map((a) => a.code)).size).toBe(DEFAULT_CHART.length);
    for (const a of DEFAULT_CHART) {
      expect(a.id).toBe(`00000000-0000-4000-8000-0000000a${a.code}`);
      expect(a.type).toBe(TYPE_BY_DIGIT[a.code[0] as keyof typeof TYPE_BY_DIGIT]);
    }
    expect(SYSTEM_ACCOUNTS.receivables.code).toBe("1100");
    expect(SYSTEM_ACCOUNTS.opening_clearing.code).toBe("2900");
    expect(DEFAULT_CHART.find((a) => a.code === "6010")?.name).toBe("Rent");
  });
});

describe("journal drafts", () => {
  const line = (accountId: string, debitFils: number, creditFils: number) => ({ accountId, debitFils, creditFils });
  it("journal draft refuses unbalanced or one-sided lines", () => {
    const base = { date: "2026-11-20", narration: "Rent" };
    const bad = journalDraftSchema.safeParse({ ...base, lines: [line(SYSTEM_ACCOUNTS.cash.id, 0, 9000), line(SYSTEM_ACCOUNTS.bank.id, 10000, 0)] });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("Debits and credits must be equal");
    expect(journalDraftSchema.safeParse({ ...base, lines: [line(SYSTEM_ACCOUNTS.cash.id, 100, 100), line(SYSTEM_ACCOUNTS.bank.id, 0, 0)] }).success).toBe(false);
    expect(journalDraftSchema.safeParse({ ...base, lines: [line(SYSTEM_ACCOUNTS.cash.id, 0, 10000), line(SYSTEM_ACCOUNTS.bank.id, 10000, 0)] }).success).toBe(true);
  });
});

describe("books settings and permissions", () => {
  it("books defaults", () => {
    expect(DEFAULT_SETTINGS.books).toEqual({
      startDate: null, fiscalYearStartMonth: 1, lockDate: null,
      methodAccounts: { cash: SYSTEM_ACCOUNTS.cash.id, card: SYSTEM_ACCOUNTS.card_clearing.id, bank_transfer: SYSTEM_ACCOUNTS.bank.id, cheque: SYSTEM_ACCOUNTS.cheques_in_hand.id },
    });
    expect(DEFAULT_SETTINGS.numbering.journalPrefix).toBe("JV");
  });

  it("permissions", () => {
    expect(can("accountant", "books.view")).toBe(true);
    expect(can("accountant", "books.post")).toBe(true);
    expect(can("accountant", "books.lock")).toBe(false);
    expect(can("owner", "books.lock")).toBe(true);
    for (const a of ["books.view", "books.post", "books.lock"] as const) expect(can("advisor", a)).toBe(false);
  });
});
