import { describe, expect, it } from "vitest";
import { contactSchema, fillTemplate, recipientsFor, unknownPlaceholders, type Contact } from "../src";

const contact = (c: Partial<Contact>): Contact => ({
  id: "x", name: "X", phone: null, email: null, language: "en",
  getsApprovals: false, getsInvoices: false, getsReady: false, getsStatements: false, marketingConsentAt: null, ...c,
});

const fleet = { kind: "company" as const, name: "Gulf Fleet LLC", phone: "042000000", email: "office@gulffleet.ae", messageLanguage: "en" as const };
const accounts = contact({ id: "acc", name: "Accounts", email: "accounts@gulffleet.ae", getsInvoices: true, getsStatements: true });
const driverContact = contact({ id: "drv", name: "Fleet driver", phone: "0507654321", getsReady: true, language: "ar" });
const ali = { name: "Ali", phone: "0501234567" };

describe("message templates", () => {
  it("finds unknown placeholders", () => {
    expect(unknownPlaceholders("Hi {customer}, {total}")).toEqual(["total"]);
    expect(unknownPlaceholders("{doc_number} {plate} {garage_phone}")).toEqual([]);
  });

  it("fills placeholders, missing ones blank", () => {
    expect(fillTemplate("{doc_number} for {plate}", { doc_number: "INV-00001" })).toBe("INV-00001 for ");
    expect(fillTemplate("{unknown} stays", {})).toBe("{unknown} stays");
  });
});

describe("recipientsFor routes by role", () => {
  it("sends invoices to the accounts contact, never the driver", () => {
    expect(recipientsFor("invoice_issued", fleet, [accounts, driverContact], ali).map((r) => r.name)).toEqual(["Accounts"]);
  });

  it("sends vehicle ready to the job card's driver when named", () => {
    const r = recipientsFor("vehicle_ready", fleet, [accounts, driverContact], ali);
    expect(r).toEqual([{ contactId: null, name: "Ali", phone: "0501234567", email: null, language: "en" }]);
  });

  it("sends vehicle ready to the vehicle-ready contacts when no driver is named", () => {
    const r = recipientsFor("vehicle_ready", fleet, [accounts, driverContact], null);
    expect(r).toEqual([{ contactId: "drv", name: "Fleet driver", phone: "0507654321", email: null, language: "ar" }]);
  });

  it("uses a company's own details only when no contact has that tick", () => {
    expect(recipientsFor("estimate_ready", fleet, [accounts, driverContact]).map((r) => r.email)).toEqual(["office@gulffleet.ae"]);
    expect(recipientsFor("statement", fleet, [accounts]).map((r) => r.email)).toEqual(["accounts@gulffleet.ae"]);
  });

  it("an individual's own details get every message, in their message language", () => {
    const person = { kind: "individual" as const, name: "Mohammed", phone: "0551112222", email: "m@example.com", messageLanguage: "ar" as const };
    for (const e of ["vehicle_received", "estimate_ready", "invoice_issued", "payment_due", "statement"] as const) {
      expect(recipientsFor(e, person, [])).toEqual([{ contactId: null, name: "Mohammed", phone: "0551112222", email: "m@example.com", language: "ar" }]);
    }
  });

  it("skips anyone with neither phone nor email", () => {
    expect(recipientsFor("invoice_issued", { ...fleet, phone: null, email: null }, [contact({ name: "Nobody", getsInvoices: true })])).toEqual([]);
  });
});

describe("contactSchema", () => {
  it("needs a name and checks the email", () => {
    expect(contactSchema.safeParse({ name: "" }).success).toBe(false);
    expect(contactSchema.safeParse({ name: "A", email: "not-an-email" }).success).toBe(false);
    expect(contactSchema.parse({ name: "A" })).toMatchObject({ language: "en", getsApprovals: false, marketingConsent: false });
  });
});
