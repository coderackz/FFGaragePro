import { describe, expect, it } from "vitest";
import { call, createPart, makeApp, setUp } from "./helpers";

const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };
const ARABIC = /[؀-ۿ]|nameAr|addressAr|docLanguage|messageLanguage|"language"|customerNameAr|partNameAr|textAr|subjectAr/;

describe("no Arabic", () => {
  it("Arabic sent by an older screen is ignored, and nothing Arabic comes back", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const customer = (await call(app, "POST", "/api/customers", owner, {
      name: "Mohammed", nameAr: "محمد", addressAr: "دبي", docLanguage: "en_ar", messageLanguage: "ar",
    })).body.customer;
    expect(JSON.stringify(customer)).not.toMatch(ARABIC);
    const part = await createPart(app, owner, { nameAr: "فلتر زيت" });
    expect(JSON.stringify((await call(app, "GET", `/api/parts/${part.id}`, owner)).body)).not.toMatch(ARABIC);
    const contact = (await call(app, "POST", `/api/customers/${customer.id}/contacts`, owner, { name: "Accounts", email: "a@b.example", language: "ar" })).body.contact;
    expect(JSON.stringify(contact)).not.toMatch(ARABIC);
    const inv = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [{ ...LINE, partId: part.id, kind: "part" }] })).body.document;
    expect((await call(app, "PATCH", `/api/documents/${inv.id}`, owner, { language: "en_ar" })).status).toBe(200);
    expect(JSON.stringify((await call(app, "GET", `/api/documents/${inv.id}`, owner)).body)).not.toMatch(ARABIC);
    const t = await call(app, "POST", "/api/message-templates", owner, { name: "Offer", channel: "email", subjectEn: "Hi", textEn: "Hello {customer}", subjectAr: "مرحبا", textAr: "أهلا" });
    expect(t.status).toBe(200);
    expect(JSON.stringify(t.body)).not.toMatch(ARABIC);
    expect(JSON.stringify((await call(app, "GET", "/api/settings", owner)).body)).not.toMatch(/nameAr|addressAr|termsAr|warrantyAr|subjectAr|textAr/);
  });
});
