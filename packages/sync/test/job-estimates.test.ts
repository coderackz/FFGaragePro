import { afterEach, describe, expect, it } from "vitest";
import { applyAtCloud, installCapture, localChanges } from "../src/index";
import { call, garageApp, setUp, twin, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe("estimates for job cards across computers", () => {
  it("an approved, re-estimated estimate reaches the cloud with its approval, number, earlier version and declined line", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    const customer = (await call(A, "POST", "/api/customers", token, { kind: "individual", name: "Ali" })).body.customer;
    const line = (description: string, unitPriceFils: number) => ({ kind: "labour", description, qty: 1, unitPriceFils, discountPct: 0 });
    const jc = (await call(A, "POST", "/api/documents", token, { type: "jobcard", customerId: customer.id, lines: [line("Service", 0), line("AC re-gas", 0)] })).body.document;
    const est = (await call(A, "POST", `/api/documents/${jc.id}/estimate`, token, {})).body.document;
    await call(A, "PUT", `/api/documents/${est.id}/lines`, token, { lines: [line("Service", 20000), line("AC re-gas", 15000)] });
    expect((await call(A, "POST", `/api/documents/${est.id}/approve`, token, { via: "phone", byName: "Ali", declined: [1] })).status).toBe(200);
    expect((await call(A, "POST", `/api/documents/${est.id}/revise`, token, {})).status).toBe(200);
    expect((await call(A, "POST", `/api/documents/${est.id}/approve`, token, { via: "in_person", byName: "Ali", declined: [1] })).status).toBe(200);
    expect(applyAtCloud(C.db, "P1", localChanges(A.db, 0)).issues).toEqual([]);
    const seen = (await call(C, "GET", `/api/documents/${est.id}`, token)).body.document;
    expect(seen).toMatchObject({ number: `${est.number}-1`, revision: 1, status: "approved", approval: { via: "in_person", byName: "Ali" }, forJob: { id: jc.id }, totals: { netFils: 20000 } });
    expect(seen.lines.map((l: any) => l.declined)).toEqual([false, true]);
    expect(seen.versions).toEqual([expect.objectContaining({ revision: 0, number: est.number, approvedVia: "phone" })]);
    expect((await call(C, "GET", `/api/documents/${jc.id}`, token)).body.document.lines.map((l: any) => [l.description, l.unitPriceFils])).toEqual([["Service", 20000]]);
  });
});
