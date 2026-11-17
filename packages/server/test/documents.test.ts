import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { addUser, call, makeApp, setUp, tempDir } from "./helpers";

const LINES = [
  { kind: "labour", description: "Brake pad replacement", qty: 1.5, unitPriceFils: 15000, discountPct: 0 },
  { kind: "part", description: "Front brake pads", qty: 2, unitPriceFils: 10000, discountPct: 10 },
];

async function customerWithVehicle(app: any, token: string) {
  const customer = (await call(app, "POST", "/api/customers", token, { name: "Ahmed", phone: "050" })).body.customer;
  const vehicle = (await call(app, "POST", "/api/vehicles", token, { customerId: customer.id, plate: "DXB B 4321", make: "Nissan" })).body.vehicle;
  return { customer, vehicle };
}

describe("documents", () => {
  it("runs estimate → job card → invoice → paid, keeping lines and totals", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const advisor = await addUser(app, owner, "advisor");
    const accountant = await addUser(app, owner, "accountant");
    const { customer, vehicle } = await customerWithVehicle(app, advisor);

    const est = (await call(app, "POST", "/api/documents", advisor, { type: "estimate", customerId: customer.id, vehicleId: vehicle.id, odometer: 50100, lines: LINES })).body.document;
    expect(est.number).toBe("EST-00001");
    expect(est.status).toBe("draft");
    expect(est.totals).toEqual({ netFils: 40500, vatFils: 2025, grossFils: 42525 });

    expect((await call(app, "PATCH", `/api/documents/${est.id}`, advisor, { status: "approved" })).body.document.status).toBe("approved");
    const jc = (await call(app, "POST", `/api/documents/${est.id}/convert`, advisor)).body.document;
    expect(jc.number).toBe("JC-00001");
    expect(jc.lines).toHaveLength(2);
    expect(jc.source.number).toBe("EST-00001");
    expect((await call(app, "POST", `/api/documents/${est.id}/convert`, advisor)).status).toBe(409);

    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, advisor)).body.document;
    expect(inv.number).toBe("INV-00001");
    expect(inv.status).toBe("draft");
    expect(inv.totals.grossFils).toBe(42525);

    expect((await call(app, "POST", `/api/documents/${inv.id}/issue`, advisor)).body.document.status).toBe("issued");
    expect((await call(app, "PUT", `/api/documents/${inv.id}/lines`, owner, { lines: LINES.slice(0, 1) })).status).toBe(409);
    expect((await call(app, "PATCH", `/api/documents/${inv.id}`, owner, { lines: LINES.slice(0, 1) })).status).toBe(409);
    expect((await call(app, "PATCH", `/api/documents/${inv.id}`, owner, { notes: "changed after issue" })).status).toBe(409);

    // Advisors can't take payments; accountants can.
    expect((await call(app, "POST", `/api/documents/${inv.id}/payments`, advisor, { amountFils: 100, method: "cash" })).status).toBe(403);
    expect((await call(app, "POST", `/api/documents/${inv.id}/payments`, accountant, { amountFils: 50000, method: "cash" })).status).toBe(400);
    const part = (await call(app, "POST", `/api/documents/${inv.id}/payments`, accountant, { amountFils: 20000, method: "card", reference: "4411" })).body.document;
    expect(part.status).toBe("part_paid");
    expect(part.balanceFils).toBe(22525);
    const paid = (await call(app, "POST", `/api/documents/${inv.id}/payments`, accountant, { amountFils: 22525, method: "cash" })).body.document;
    expect(paid.status).toBe("paid");
    expect(paid.payments).toHaveLength(2);
    expect((await call(app, "POST", `/api/documents/${inv.id}/payments`, accountant, { amountFils: 1, method: "cash" })).status).toBe(400);
  });

  it("can't pay a draft invoice or issue an empty one", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const { customer } = await customerWithVehicle(app, owner);
    const inv = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id })).body.document;
    expect((await call(app, "POST", `/api/documents/${inv.id}/payments`, owner, { amountFils: 100, method: "cash" })).status).toBe(400);
    expect((await call(app, "POST", `/api/documents/${inv.id}/issue`, owner)).status).toBe(400);
  });

  it("rejects a vehicle that belongs to another customer", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const { vehicle } = await customerWithVehicle(app, owner);
    const other = (await call(app, "POST", "/api/customers", owner, { name: "Other" })).body.customer;
    const res = await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: other.id, vehicleId: vehicle.id });
    expect(res.status).toBe(400);
  });

  it("rejects manual status changes that skip the workflow", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const { customer } = await customerWithVehicle(app, owner);
    const est = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: LINES })).body.document;
    expect((await call(app, "PATCH", `/api/documents/${est.id}`, owner, { status: "converted" })).status).toBe(400);
    expect((await call(app, "PATCH", `/api/documents/${est.id}`, owner, { status: "paid" })).status).toBe(400);
  });

  it("numbering continues after a restart and is per type", async () => {
    const dir = tempDir();
    let app = await buildApp({ dataDir: dir });
    const owner = await setUp(app);
    const { customer } = await customerWithVehicle(app, owner);
    await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id });
    await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id });
    await app.close();
    app = await buildApp({ dataDir: dir });
    const next = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id })).body.document;
    expect(next.number).toBe("EST-00002");
    await app.close();
  });

  it("lists and searches documents", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const { customer, vehicle } = await customerWithVehicle(app, owner);
    await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, vehicleId: vehicle.id, lines: LINES });
    await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, lines: LINES });
    const list = await call(app, "GET", "/api/documents?type=estimate", owner);
    expect(list.body.documents).toHaveLength(1);
    expect(list.body.documents[0].plate).toBe("DXB B 4321");
    expect(list.body.documents[0].grossFils).toBe(42525);
    expect((await call(app, "GET", "/api/documents?q=4321", owner)).body.documents).toHaveLength(1);
    expect((await call(app, "GET", "/api/documents?q=ahmed", owner)).body.documents).toHaveLength(2);
  });
});
