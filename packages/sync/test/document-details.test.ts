import { afterEach, describe, expect, it } from "vitest";
import { applyAtCloud, installCapture, localChanges } from "../src/index";
import { call, garageApp, setUp, twin, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe("line descriptions and units across computers", () => {
  it("a line's description and unit reach the cloud", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    const customer = (await call(A, "POST", "/api/customers", token, { kind: "individual", name: "Ali" })).body.customer;
    const doc = (await call(A, "POST", "/api/documents", token, { type: "estimate", customerId: customer.id, lines: [
      { kind: "labour", description: "Brakes", details: "Pads\nDiscs", unit: "Hr", qty: 1, unitPriceFils: 10000, discountPct: 0 },
    ] })).body.document;
    const result = applyAtCloud(C.db, "P1", localChanges(A.db, 0));
    expect(result.issues).toEqual([]);
    expect(C.db.get("SELECT details, unit FROM document_lines WHERE document_id = ?", [doc.id])).toEqual({ details: "Pads\nDiscs", unit: "Hr" });
  });
});
