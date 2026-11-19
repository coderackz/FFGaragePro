import { describe, expect, it } from "vitest";
import { describeAudit, type AuditEntry } from "../src/renderer/pages/settings/describe";

const entry = (e: Partial<AuditEntry>): AuditEntry => ({
  id: "1", action: "settings.change", entity: "settings", entityId: null, before: null, after: null, user: "Owner One", device: "FRONT-PC",
  createdAt: "2026-11-19T08:00:00.000Z", ...e,
});

describe("activity log in plain words", () => {
  it("settings changes name the section, field and values", () => {
    expect(describeAudit(entry({ entityId: "pricing", before: { labourRateFils: null }, after: { labourRateFils: 18000 } })))
      .toBe("Changed Pricing — Labour rate: not set → AED 180.00");
    expect(describeAudit(entry({ entityId: "inventory", before: { belowZero: "warn" }, after: { belowZero: "block" } })))
      .toBe("Changed Inventory — Stock below zero: Warn → Block");
    expect(describeAudit(entry({ entityId: "profile", before: { name: "A", phone: null }, after: { name: "B", phone: "04" } })))
      .toBe("Changed Garage details — Garage name: A → B; Phone: not set → 04");
  });

  it("images say so", () => {
    expect(describeAudit(entry({ entityId: "documents", before: { logo: null }, after: { logo: "(image)" } })))
      .toBe("Changed Documents & printing — Logo: not set → new image");
  });

  it("discounts, users and restores", () => {
    expect(describeAudit(entry({ action: "discount.approve", after: { document: "EST-00004", approvedBy: "Owner One", lines: [{ description: "Service", discountPct: 15 }] } })))
      .toBe("Approved a 15% discount on EST-00004");
    expect(describeAudit(entry({ action: "user.create", after: { name: "Sara", username: "sara", role: "advisor" } })))
      .toBe("Added user Sara (Service Advisor)");
    expect(describeAudit(entry({ action: "user.update", before: { username: "sara", role: "advisor" }, after: { role: "owner" } })))
      .toBe("Changed user sara — Role: Service Advisor → Owner");
    expect(describeAudit(entry({ action: "backup.restore", after: { file: "Fleetfix G 2026-11-18 09-00.db" } }))).toBe("Restored a backup (Fleetfix G 2026-11-18 09-00.db)");
  });
});
