import { describe, expect, it } from "vitest";
import { addUser, call, createPart, makeApp, setUp } from "./helpers";

async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const advisor = await addUser(app, owner, "advisor");
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  let n = 0;
  const vehicle = async (make: string, model: string | null) =>
    (await call(app, "POST", "/api/vehicles", owner, { customerId: customer.id, plate: `D ${10000 + n++}`, make, model })).body.vehicle;
  return { app, owner, advisor, vehicle };
}

describe("the garage's makes and models", () => {
  it("lists what its vehicles and parts use, one entry per name however it's written", async () => {
    const { app, owner, advisor, vehicle } = await world();
    await vehicle("Toyota", "Land Cruiser");
    await vehicle("TOYOTA", "LANDCRUISER");
    await vehicle("Toyta", "Camry");
    await vehicle("Jetour", "T2");
    await createPart(app, owner, { fitments: [{ make: "Nissan", model: "Patrol" }] });
    const { makes, models } = (await call(app, "GET", "/api/vehicle-names", advisor)).body;
    expect(makes).toEqual([
      { name: "Jetour", vehicles: 1 }, { name: "Nissan", vehicles: 0 }, { name: "Toyota", vehicles: 2 }, { name: "Toyta", vehicles: 1 },
    ]);
    expect(models).toEqual([
      { make: "Jetour", name: "T2", vehicles: 1 }, { make: "Nissan", name: "Patrol", vehicles: 0 },
      { make: "Toyota", name: "Land Cruiser", vehicles: 2 }, { make: "Toyta", name: "Camry", vehicles: 1 },
    ]);
  });

  it("the owner renames or merges a spelling: every vehicle and part with it changes; nobody else may", async () => {
    const { app, owner, advisor, vehicle } = await world();
    await vehicle("Toyota", "Land Cruiser");
    const typo = await vehicle("Toyta", "Camry");
    await vehicle("Nissan", "Land Cruiser"); // another make's model of the same name: untouched
    await createPart(app, owner, { fitments: [{ make: "toyta", model: "camry" }] });
    expect((await call(app, "POST", "/api/vehicle-names/rename", advisor, { kind: "make", from: "Toyta", to: "Toyota" })).status).toBe(403);
    const merged = await call(app, "POST", "/api/vehicle-names/rename", owner, { kind: "make", from: "Toyta", to: "Toyota" });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ vehicles: 1, fitments: 1 });
    expect((await call(app, "GET", `/api/vehicles/${typo.id}`, owner)).body.vehicle).toMatchObject({ make: "Toyota", model: "Camry" });
    expect(app.db.get("SELECT make FROM part_fitments")).toEqual({ make: "Toyota" });
    const model = await call(app, "POST", "/api/vehicle-names/rename", owner, { kind: "model", make: "toyota", from: "Land Cruiser", to: "Land Cruiser Prado" });
    expect(model.body).toMatchObject({ vehicles: 1, fitments: 0 });
    expect(app.db.all("SELECT make, model FROM vehicles ORDER BY make, model")).toEqual([
      { make: "Nissan", model: "Land Cruiser" }, { make: "Toyota", model: "Camry" }, { make: "Toyota", model: "Land Cruiser Prado" },
    ]);
    expect((await call(app, "POST", "/api/vehicle-names/rename", owner, { kind: "model", from: "Camry", to: "X" })).body.error).toBe("Say which make the model is of");
  });
});
