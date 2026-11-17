import { describe, expect, it } from "vitest";
import { addUser, call, makeApp, setUp } from "./helpers";

describe("customers and vehicles", () => {
  it("creates a customer with vehicles and finds them by plate", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const advisor = await addUser(app, owner, "advisor");
    const c = await call(app, "POST", "/api/customers", advisor, { name: "Fleet Co LLC", kind: "company", phone: "050 111 2222", trn: "100999888700003" });
    expect(c.status).toBe(200);
    const id = c.body.customer.id;
    expect((await call(app, "POST", "/api/vehicles", advisor, { customerId: id, plate: "dxb  a 12345", make: "Toyota", model: "Hiace", year: 2021 })).status).toBe(200);
    expect((await call(app, "POST", "/api/vehicles", advisor, { customerId: id, plate: "SHJ 3 777" })).status).toBe(200);

    const found = await call(app, "GET", "/api/customers?q=12345", advisor);
    expect(found.body.customers.map((x: any) => x.id)).toEqual([id]);
    const detail = await call(app, "GET", `/api/customers/${id}`, advisor);
    expect(detail.body.vehicles.map((v: any) => v.plate).sort()).toEqual(["DXB A 12345", "SHJ 3 777"]);
    const vehicles = await call(app, "GET", "/api/vehicles?q=hiace", advisor);
    expect(vehicles.body.vehicles[0].customerName).toBe("Fleet Co LLC");
  });

  it("rejects a duplicate plate", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const id = (await call(app, "POST", "/api/customers", owner, { name: "A" })).body.customer.id;
    await call(app, "POST", "/api/vehicles", owner, { customerId: id, plate: "DXB A 1" });
    expect((await call(app, "POST", "/api/vehicles", owner, { customerId: id, plate: "dxb a 1" })).status).toBe(409);
  });

  it("updates customer and vehicle", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const id = (await call(app, "POST", "/api/customers", owner, { name: "A" })).body.customer.id;
    const v = (await call(app, "POST", "/api/vehicles", owner, { customerId: id, plate: "AUH 5 55" })).body.vehicle;
    expect((await call(app, "PATCH", `/api/customers/${id}`, owner, { name: "A2", phone: "1" })).body.customer.name).toBe("A2");
    expect((await call(app, "PATCH", `/api/vehicles/${v.id}`, owner, { customerId: id, plate: "AUH 5 55", odometer: 12000 })).body.vehicle.odometer).toBe(12000);
  });

  it("vehicle for unknown customer is rejected", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const res = await call(app, "POST", "/api/vehicles", owner, { customerId: "00000000-0000-4000-8000-000000000000", plate: "X 1" });
    expect(res.status).toBe(404);
  });
});
