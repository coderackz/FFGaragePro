import { describe, expect, it } from "vitest";
import { EMPTY_ADDRESS } from "@ffgp/shared";
import { call, makeApp, setUp, SETUP } from "./helpers";

const parts = (p: Partial<typeof EMPTY_ADDRESS>) => ({ ...EMPTY_ADDRESS, ...p });

describe("addresses in parts", () => {
  it("parts are stored and the printed address is made from them", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const made = (await call(app, "POST", "/api/customers", owner, { name: "Ali", addressParts: parts({ unit: "Villa 4", street: "Street 12", area: "Al Barsha 1", emirate: "dubai" }) })).body.customer;
    expect(made.address).toBe("Villa 4\nStreet 12, Al Barsha 1\nDubai");
    const c = (await call(app, "GET", `/api/customers/${made.id}`, owner)).body.customer;
    expect(c.addressParts).toEqual(parts({ unit: "Villa 4", street: "Street 12", area: "Al Barsha 1", emirate: "dubai" }));
    const s = (await call(app, "POST", "/api/suppliers", owner, { name: "Muscat Parts", addressParts: parts({ building: "Al Noor", country: "Oman" }) })).body.supplier;
    expect(s.address).toBe("Al Noor\nOman");
    const changed = (await call(app, "PATCH", `/api/suppliers/${s.id}`, owner, { addressParts: parts({ building: "Al Noor 2", country: "Oman" }) })).body.supplier;
    expect(changed).toMatchObject({ address: "Al Noor 2\nOman", addressParts: { building: "Al Noor 2", country: "Oman" } });
    const cleared = (await call(app, "PATCH", `/api/customers/${made.id}`, owner, { addressParts: EMPTY_ADDRESS })).body.customer;
    expect(cleared.address).toBeNull();
  });

  it("an old address shows in Street and isn't touched by a save that changes only the notes", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const c = (await call(app, "POST", "/api/customers", owner, { name: "Ali", address: "Villa 4\nAl Barsha" })).body.customer;
    expect(c.addressParts).toEqual(parts({ street: "Villa 4, Al Barsha" }));
    const saved = (await call(app, "PATCH", `/api/customers/${c.id}`, owner, { notes: "VIP", addressParts: c.addressParts })).body.customer;
    expect(saved).toMatchObject({ notes: "VIP", address: "Villa 4\nAl Barsha" });
    const edited = (await call(app, "PATCH", `/api/customers/${c.id}`, owner, { addressParts: { ...c.addressParts, emirate: "dubai" } })).body.customer;
    expect(edited.address).toBe("Villa 4, Al Barsha\nDubai");
  });

  it("an older screen that sends the same address keeps the parts; a different one clears them", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const p = parts({ street: "Street 12", emirate: "dubai" });
    const c = (await call(app, "POST", "/api/customers", owner, { name: "Ali", addressParts: p })).body.customer;
    const same = (await call(app, "PATCH", `/api/customers/${c.id}`, owner, { name: "Ali B", address: c.address })).body.customer;
    expect(same.addressParts).toEqual(p);
    const none = (await call(app, "PATCH", `/api/customers/${c.id}`, owner, { name: "Ali C" })).body.customer;
    expect(none.addressParts).toEqual(p);
    const other = (await call(app, "PATCH", `/api/customers/${c.id}`, owner, { address: "Somewhere else" })).body.customer;
    expect(other).toMatchObject({ address: "Somewhere else", addressParts: parts({ street: "Somewhere else" }) });
    const garage = (await call(app, "PATCH", "/api/settings", owner, { name: "G", addressParts: parts({ unit: "W 12" }) })).body.garage;
    expect(garage.address).toBe("W 12");
    expect((await call(app, "PATCH", "/api/settings", owner, { name: "G2", address: "W 12" })).body.garage.addressParts.unit).toBe("W 12");
    expect((await call(app, "PATCH", "/api/settings", owner, { name: "G2", address: "Old way" })).body.garage).toMatchObject({ address: "Old way", addressParts: { unit: null, street: "Old way" } });
  });

  it("setup stores the emirate as the VAT emirate", async () => {
    const app = await makeApp();
    const res = await call(app, "POST", "/api/setup", undefined, { ...SETUP, garage: { name: "Al Quoz Auto", addressParts: parts({ unit: "Warehouse 12", area: "Al Quoz Ind. 3" }), emirate: "dubai" } });
    expect(res.status).toBe(200);
    const s = (await call(app, "GET", "/api/settings", res.body.token)).body;
    expect(s.settings.garage.emirate).toBe("dubai");
    expect(s.garage).toMatchObject({ address: "Warehouse 12\nAl Quoz Ind. 3\nDubai", addressParts: { unit: "Warehouse 12", emirate: "dubai" } });
  });

  it("changing the garage's emirate in Settings changes its printed address; an old address is left alone", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const before = (await call(app, "GET", "/api/settings", owner)).body;
    await call(app, "PUT", "/api/settings/garage", owner, { ...before.settings.garage, emirate: "sharjah" });
    const old = (await call(app, "GET", "/api/settings", owner)).body.garage;
    expect(old.address).toBe(before.garage.address);
    if (before.garage.address) expect(old.addressParts.street).toBe(before.garage.address.replace(/\n/g, ", "));
    await call(app, "PATCH", "/api/settings", owner, { name: "G", addressParts: parts({ unit: "Shop 1", emirate: "sharjah" }) });
    expect((await call(app, "GET", "/api/settings", owner)).body.garage.address).toBe("Shop 1\nSharjah");
    await call(app, "PUT", "/api/settings/garage", owner, { ...before.settings.garage, emirate: "ajman" });
    expect((await call(app, "GET", "/api/settings", owner)).body.garage.address).toBe("Shop 1\nAjman");
  });
});

describe("searching by phone", () => {
  it("0501234567 finds +971 50 123 4567, and +971501234567 finds 050 123 4567", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const a = (await call(app, "POST", "/api/customers", owner, { name: "New way", phone: "+971 50 123 4567" })).body.customer;
    const b = (await call(app, "POST", "/api/customers", owner, { name: "Old way", phone: "050 765 4321" })).body.customer;
    await call(app, "POST", "/api/customers", owner, { name: "No phone" });
    for (const c of [a, b]) await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: c.id, lines: [] });
    const names = async (q: string) => (await call(app, "GET", `/api/customers?q=${encodeURIComponent(q)}`, owner)).body.customers.map((c: { name: string }) => c.name);
    const docs = async (q: string) => (await call(app, "GET", `/api/documents?q=${encodeURIComponent(q)}`, owner)).body.documents.map((d: { customerName: string }) => d.customerName);
    for (const find of [names, docs]) {
      for (const q of ["0501234567", "+971501234567", "050 123 4567", "1234567"]) expect(await find(q)).toEqual(["New way"]);
      for (const q of ["+971507654321", "0507654321"]) expect(await find(q)).toEqual(["Old way"]);
    }
    expect(await names("way")).toEqual(["New way", "Old way"]);
  });
});
