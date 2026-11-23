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
});
