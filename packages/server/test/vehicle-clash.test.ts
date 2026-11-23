import { expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";

it("a plate already registered says whose it is", async () => {
  const app = await makeApp();
  const owner = await setUp(app);
  const a = (await call(app, "POST", "/api/customers", owner, { name: "Emirates Logistics LLC" })).body.customer;
  const b = (await call(app, "POST", "/api/customers", owner, { name: "Ali" })).body.customer;
  await call(app, "POST", "/api/vehicles", owner, { customerId: a.id, plate: "DXB K 48213" });
  const res = await call(app, "POST", "/api/vehicles", owner, { customerId: b.id, plate: "dxb k 48213" });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("Plate DXB K 48213 is already registered to Emirates Logistics LLC");
});

it("a plate that looks like one already here is asked about, not refused; the same plate written differently is refused", async () => {
  const app = await makeApp();
  const owner = await setUp(app);
  const a = (await call(app, "POST", "/api/customers", owner, { name: "Emirates Logistics LLC" })).body.customer;
  const b = (await call(app, "POST", "/api/customers", owner, { name: "Ali" })).body.customer;
  const add = (plate: string, extra: object = {}) => call(app, "POST", "/api/vehicles", owner, { customerId: b.id, plate, ...extra });
  const old = (await call(app, "POST", "/api/vehicles", owner, { customerId: a.id, plate: "DXB-K-48213" })).body.vehicle;
  await call(app, "POST", "/api/vehicles", owner, { customerId: a.id, plate: "K 777" });
  // The same emirate, code and number: the same plate.
  for (const plate of ["DXB K 48213", "Dubai K48213"]) {
    expect(await add(plate)).toMatchObject({ status: 409, body: { error: `Plate ${plate.toUpperCase()} is already registered to Emirates Logistics LLC` } });
  }
  // The same code and number without an emirate: maybe the same car. The new form asks; an older one saves as before.
  const asked = await add("DXB K 777", { checkSimilar: true });
  expect(asked).toMatchObject({ status: 409, body: { code: "plate_similar", error: "Plate K 777 is already registered to Emirates Logistics LLC" } });
  expect((await add("DXB K 777")).status).toBe(200);
  // Another emirate or another number isn't the same car.
  expect((await add("SHJ K 48213", { checkSimilar: true })).status).toBe(200);
  expect((await add("DXB K 48214", { checkSimilar: true })).status).toBe(200);
  // An old record is never held up by its own plate.
  expect((await call(app, "PATCH", `/api/vehicles/${old.id}`, owner, { colour: "White", checkSimilar: true })).status).toBe(200);
});
