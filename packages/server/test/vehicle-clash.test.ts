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
