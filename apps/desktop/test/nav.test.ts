import { can as roleCan, type Action } from "@ffgp/shared";
import { describe, expect, it } from "vitest";
import { navGroups } from "../src/renderer/components/nav";
import { GUIDES, searchGuides } from "../src/renderer/help/guides";

const as = (role: "owner" | "accountant" | "advisor") => (a: Action) => roleCan(role, a);

describe("the side menu", () => {
  it("owner sees every group in order", () => {
    const groups = navGroups(as("owner"));
    expect(groups.map((g) => g.section)).toEqual([null, "Operations", "Finance", "Accounts", "HR & Payroll", "Inventory", "Reports", "Knowledge", "Settings"]);
    expect(groups.find((g) => g.section === "Operations")!.items.map((i) => i.label)).toEqual(["Estimates", "Job Cards", "Invoices", "Customers", "Vehicles"]);
    expect(groups.find((g) => g.section === "Accounts")!.items.map((i) => i.label)).toEqual(["Books", "VAT return", "Fixed assets"]);
  });
  it("advisor sees no accounts, HR or bills: only receipts and credit notes in Finance", () => {
    const sections = navGroups(as("advisor")).map((g) => g.section);
    expect(navGroups(as("advisor")).find((g) => g.section === "Finance")!.items.map((i) => i.label)).toEqual(["Receipts", "Credit Notes"]);
    expect(sections).not.toContain("Accounts");
    expect(sections).not.toContain("HR & Payroll");
    expect(navGroups(as("advisor")).find((g) => g.section === "Operations")!.items.map((i) => i.label)).toContain("Estimates");
  });
});

describe("Knowledge", () => {
  it("guides search", () => {
    expect(GUIDES).toHaveLength(12);
    expect(searchGuides("gratuity").map((g) => g.slug)).toContain("payroll");
    expect(searchGuides("")).toHaveLength(12);
  });
});
