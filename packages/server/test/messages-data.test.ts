import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db";
import { addUser, call, makeApp, setUp, tempDir } from "./helpers";

async function garage() {
  const app = await makeApp();
  const owner = await setUp(app);
  const customer = (await call(app, "POST", "/api/customers", owner, { kind: "company", name: "Gulf Fleet LLC", email: "office@gulffleet.ae" })).body.customer;
  return { app, owner, customer };
}

describe("messages data (Part 3b)", () => {
  it("migration 10 keeps old rows", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 9 });
    old.run("INSERT INTO customers (id, kind, name, created_at, updated_at) VALUES ('c1', 'individual', 'Old', 'x', 'x')");
    old.close();
    const db = new Db(file);
    expect(db.get("SELECT name FROM customers WHERE id = 'c1'")).toEqual({ name: "Old" });
    for (const t of ["customer_contacts", "messages", "message_files"]) expect(db.get("SELECT name FROM sqlite_master WHERE name = ?", [t])).toBeTruthy();
    expect(db.all<{ name: string }>("PRAGMA table_info(documents)").map((c) => c.name)).toEqual(expect.arrayContaining(["driver_name", "driver_phone"]));
    db.close();
  });

  it("contacts round-trip", async () => {
    const { app, owner, customer } = await garage();
    const created = await call(app, "POST", `/api/customers/${customer.id}/contacts`, owner, {
      name: "Accounts", email: "accounts@gulffleet.ae", getsInvoices: true, getsStatements: true,
    });
    expect(created.status).toBe(200);
    const c = created.body.contact;
    expect(c).toMatchObject({ name: "Accounts", email: "accounts@gulffleet.ae", getsInvoices: true, getsApprovals: false, marketingConsentAt: null });

    const ticked = (await call(app, "PATCH", `/api/contacts/${c.id}`, owner, { ...c, marketingConsent: true })).body.contact;
    expect(ticked.marketingConsentAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const again = (await call(app, "PATCH", `/api/contacts/${c.id}`, owner, { ...ticked, marketingConsent: true, name: "Accounts team" })).body.contact;
    expect(again.marketingConsentAt).toBe(ticked.marketingConsentAt);
    const unticked = (await call(app, "PATCH", `/api/contacts/${c.id}`, owner, { ...again, marketingConsent: false })).body.contact;
    expect(unticked.marketingConsentAt).toBeNull();

    const list = (await call(app, "GET", `/api/customers/${customer.id}/contacts`, owner)).body.contacts;
    expect(list.map((x: { name: string }) => x.name)).toEqual(["Accounts team"]);
    expect((await call(app, "DELETE", `/api/contacts/${c.id}`, owner)).status).toBe(200);
    expect((await call(app, "GET", `/api/customers/${customer.id}/contacts`, owner)).body.contacts).toEqual([]);
  });

  it("an advisor can add contacts; a bad email is refused", async () => {
    const { app, owner, customer } = await garage();
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "POST", `/api/customers/${customer.id}/contacts`, advisor, { name: "Driver", phone: "0501234567", getsReady: true })).status).toBe(200);
    expect((await call(app, "POST", `/api/customers/${customer.id}/contacts`, advisor, { name: "X", email: "nope" })).status).toBe(400);
    expect((await call(app, "POST", `/api/customers/00000000-0000-4000-8000-000000000000/contacts`, advisor, { name: "X" })).status).toBe(404);
  });

  it("driver fields on a job card", async () => {
    const { app, owner, customer } = await garage();
    const jc = (await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id })).body.document;
    expect((await call(app, "PATCH", `/api/documents/${jc.id}`, owner, { driverName: "Ali", driverPhone: "050 123 4567" })).status).toBe(200);
    const got = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document;
    expect(got).toMatchObject({ driverName: "Ali", driverPhone: "050 123 4567" });    const created = (await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, driverName: "Sami", driverPhone: "0559876543" })).body.document;
    expect(created).toMatchObject({ driverName: "Sami", driverPhone: "0559876543" });
  });
});
