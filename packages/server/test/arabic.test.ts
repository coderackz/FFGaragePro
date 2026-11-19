import { describe, expect, it } from "vitest";
import { Db } from "../src/db";
import { call, createPart, makeApp, setUp, tempDir, type App } from "./helpers";
import { join } from "node:path";

const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, {
    name: "Mohammed Al Marri", nameAr: "محمد المري", addressAr: "البرشاء 1، دبي", docLanguage: "en_ar",
  })).body.customer;
  const make = async (type: string, lines: unknown[] = [LINE]) =>
    (await call(app, "POST", "/api/documents", owner, { type, customerId: customer.id, lines })).body.document;
  const issue = async (id: string) => (await call(app, "POST", `/api/documents/${id}/issue`, owner)).body.document;
  const doc = async (id: string) => (await call(app, "GET", `/api/documents/${id}`, owner)).body.document;
  return { app, owner, customer, make, issue, doc };
}

describe("English + Arabic documents (server)", () => {
  it("migration 9 adds the columns with English defaults", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 8 });
    old.run("INSERT INTO customers (id, kind, name, created_at, updated_at) VALUES ('c1', 'individual', 'Old', 'x', 'x')");
    old.close();
    const db = new Db(file);
    expect(db.get("SELECT doc_language, name_ar, address_ar FROM customers WHERE id = 'c1'")).toEqual({ doc_language: "en", name_ar: null, address_ar: null });
    expect(db.all<{ name: string }>("PRAGMA table_info(documents)").map((c) => c.name)).toContain("language");
    expect(db.all<{ name: string }>("PRAGMA table_info(parts)").map((c) => c.name)).toContain("name_ar");
  });

  it("customer Arabic fields round-trip", async () => {
    const { app, owner, customer } = await garage();
    expect(customer).toMatchObject({ nameAr: "محمد المري", addressAr: "البرشاء 1، دبي", docLanguage: "en_ar" });
    const got = (await call(app, "GET", `/api/customers/${customer.id}`, owner)).body.customer;
    expect(got).toMatchObject({ nameAr: "محمد المري", docLanguage: "en_ar" });
    expect((await call(app, "POST", "/api/customers", owner, { name: "X", docLanguage: "ar" })).status).toBe(400);
  });

  it("new document takes the customer's language", async () => {
    const { make } = await garage();
    const inv = await make("invoice");
    expect(inv.language).toBe("en_ar");
    expect(inv.customer).toMatchObject({ nameAr: "محمد المري", addressAr: "البرشاء 1، دبي", docLanguage: "en_ar" });
  });

  it("a converted document takes the customer's language at that moment", async () => {
    const { app, owner, customer, make, doc } = await garage();
    const est = await make("estimate");
    await call(app, "PATCH", `/api/customers/${customer.id}`, owner, { docLanguage: "en" });
    const res = await call(app, "POST", `/api/documents/${est.id}/convert`, owner);
    expect(res.status).toBe(200);
    expect((await doc(res.body.document.id)).language).toBe("en");
    expect((await doc(est.id)).language).toBe("en_ar");
  });

  it("document keeps its language when the customer changes", async () => {
    const { app, owner, customer, make, issue, doc } = await garage();
    const inv = await issue((await make("invoice")).id);
    await call(app, "PATCH", `/api/customers/${customer.id}`, owner, { docLanguage: "en" });
    expect((await doc(inv.id)).language).toBe("en_ar");
  });

  it("credit note takes its invoice's language", async () => {
    const { app, owner, customer, make, issue } = await garage();
    const inv = await issue((await make("invoice")).id);
    await call(app, "PATCH", `/api/customers/${customer.id}`, owner, { docLanguage: "en" });
    const cn = (await call(app, "POST", `/api/documents/${inv.id}/credit-notes`, owner, { reason: "Wrong part" })).body.document;
    expect(cn.language).toBe("en_ar");
  });

  it("language can change while editable, not once issued", async () => {
    const { app, owner, make, issue } = await garage();
    const inv = await make("invoice");
    const ok = await call(app, "PATCH", `/api/documents/${inv.id}`, owner, { language: "en" });
    expect(ok.status).toBe(200);
    expect(ok.body.document.language).toBe("en");
    await issue(inv.id);
    const refused = await call(app, "PATCH", `/api/documents/${inv.id}`, owner, { language: "en_ar" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it("lines carry the part's Arabic name", async () => {
    const { app, owner, make } = await garage();
    const part = await createPart(app, owner, { nameAr: "فلتر زيت", stocked: false });
    expect((await call(app, "GET", `/api/parts/${part.id}`, owner)).body.part.nameAr).toBe("فلتر زيت");
    const inv = await make("invoice", [{ kind: "part", description: "Oil filter", qty: 1, unitPriceFils: 3500, discountPct: 0, partId: part.id }, LINE]);
    expect(inv.lines[0].partNameAr).toBe("فلتر زيت");
    expect(inv.lines[1].partNameAr ?? null).toBeNull();
  });

  it("receipts say the customer's language and Arabic name", async () => {
    const { app, owner, customer } = await garage();
    const r = (await call(app, "POST", "/api/receipts", owner, { customerId: customer.id, amountFils: 5000, method: "cash" })).body.receipt;
    expect(r).toMatchObject({ customerLanguage: "en_ar", customerNameAr: "محمد المري" });
  });
});

export type { App };
