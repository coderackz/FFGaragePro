import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_ADDRESS } from "@ffgp/shared";
import { applyAtCloud, installCapture, localChanges } from "../src/index";
import { call, garageApp, setUp, twin, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe("addresses across computers", () => {
  it("two PCs change different parts: both kept, the printed address has both", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const customer = (await call(A, "POST", "/api/customers", token, { name: "Ali", addressParts: { ...EMPTY_ADDRESS, street: "Street 12" } })).body.customer;
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    await call(A, "PATCH", `/api/customers/${customer.id}`, token, { addressParts: { ...EMPTY_ADDRESS, street: "Street 12", building: "Al Noor" } });
    await call(C, "PATCH", `/api/customers/${customer.id}`, token, { addressParts: { ...EMPTY_ADDRESS, street: "Street 12", area: "Al Barsha" } });
    expect(applyAtCloud(C.db, "P1", localChanges(A.db, 0)).issues).toEqual([]);
    const row = () => C.db.get("SELECT addr_building AS b, addr_area AS a, address FROM customers WHERE id = ?", [customer.id]);
    expect(row()).toEqual({ b: "Al Noor", a: "Al Barsha", address: "Al Noor\nStreet 12, Al Barsha" });
  });

  it("an address rewritten by an older screen isn't lost when another place changes one part", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const customer = (await call(A, "POST", "/api/customers", token, { name: "Ali", addressParts: { ...EMPTY_ADDRESS, street: "Street 12" } })).body.customer;
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    await call(A, "PATCH", `/api/customers/${customer.id}`, token, { address: "New place, Shop 9, Deira" });
    await call(C, "PATCH", `/api/customers/${customer.id}`, token, { addressParts: { ...EMPTY_ADDRESS, street: "Street 12", building: "Al Noor" } });
    expect(applyAtCloud(C.db, "P1", localChanges(A.db, 0)).issues).toEqual([]);
    expect(C.db.get("SELECT address FROM customers WHERE id = ?", [customer.id])).toEqual({ address: "Al Noor\nNew place, Shop 9, Deira" });
  });

  it("each place clears a different last part: nothing comes back", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const customer = (await call(A, "POST", "/api/customers", token, { name: "Ali", addressParts: { ...EMPTY_ADDRESS, building: "Al Noor", area: "Al Barsha" } })).body.customer;
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    await call(A, "PATCH", `/api/customers/${customer.id}`, token, { addressParts: { ...EMPTY_ADDRESS, building: "Al Noor" } });
    await call(C, "PATCH", `/api/customers/${customer.id}`, token, { addressParts: { ...EMPTY_ADDRESS, area: "Al Barsha" } });
    applyAtCloud(C.db, "P1", localChanges(A.db, 0));
    expect(C.db.get("SELECT address FROM customers WHERE id = ?", [customer.id])).toEqual({ address: null });
  });

  it("an address from before the parts isn't cleared by some other change arriving", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const customer = (await call(A, "POST", "/api/customers", token, { name: "Ali", address: "Villa 4" })).body.customer;
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    await call(A, "PATCH", `/api/customers/${customer.id}`, token, { notes: "VIP" });
    applyAtCloud(C.db, "P1", localChanges(A.db, 0));
    expect(C.db.get("SELECT address, notes FROM customers WHERE id = ?", [customer.id])).toEqual({ address: "Villa 4", notes: "VIP" });
  });

  it("an address changed on a PC before its update isn't replaced by the cloud's parts", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const customer = (await call(A, "POST", "/api/customers", token, { name: "Ali", address: "Villa 4" })).body.customer;
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    await call(A, "PATCH", `/api/customers/${customer.id}`, token, { address: "Shop 7, Deira" });
    await call(C, "PATCH", `/api/customers/${customer.id}`, token, { addressParts: { ...EMPTY_ADDRESS, street: "Villa 4", building: "Al Noor" } });
    // As the PC wrote it before its update: the row had no address parts then.
    const old = localChanges(A.db, 0).map((e) => ({
      ...e, changed: e.changed?.filter((k) => !k.startsWith("addr_")) ?? null,
      data: Array.isArray(e.data) || !e.data ? e.data : Object.fromEntries(Object.entries(e.data).filter(([k]) => !k.startsWith("addr_"))),
    }));
    expect(applyAtCloud(C.db, "P1", old).issues).toEqual([]);
    expect(C.db.get("SELECT address, addr_street AS s, addr_building AS b FROM customers WHERE id = ?", [customer.id])).toEqual({ address: "Shop 7, Deira", s: "Shop 7, Deira", b: null });
  });
});
