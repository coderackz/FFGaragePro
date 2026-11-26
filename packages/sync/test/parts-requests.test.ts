import { afterEach, describe, expect, it } from "vitest";
import { applyAtCloud, applyAtPc, changesFor, installCapture, localChanges, setState } from "../src/index";
import { call, garageApp, setUp, twin, type App } from "./helpers";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});
const T = "2026-11-26T08:00:00.000Z";

describe("parts requests across computers", () => {
  it("a request without a vendor, a vendor's prices and a Mulkiya photo reach the other computer; the same quote twice is one", async () => {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const supplier = (await call(A, "POST", "/api/suppliers", token, { name: "Gulf Parts" })).body.supplier;
    const customer = (await call(A, "POST", "/api/customers", token, { kind: "individual", name: "Ali" })).body.customer;
    const vehicleId = (await call(A, "POST", "/api/vehicles", token, { customerId: customer.id, plate: "D 12345" })).body.vehicle.id;
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    
    const write = (db: App["db"]) => {
      db.run("INSERT OR REPLACE INTO purchase_orders (id, series, seq, number, supplier_id, status, created_at, updated_at) VALUES ('p1', 'P1', 1, 'PO-P1-00001', NULL, 'draft', ?, ?)", [T, T]);
      db.run("INSERT OR REPLACE INTO po_lines (id, po_id, position, description, qty, unit_cost_fils, created_at, updated_at) VALUES ('l1', 'p1', 0, 'Brake pads', 1, 0, ?, ?)", [T, T]);
      db.run("INSERT OR REPLACE INTO po_quotes (id, po_id, supplier_id, asked_at, created_at, updated_at) VALUES (?, 'p1', ?, ?, ?, ?)", [`p1:${supplier.id}`, supplier.id, T, T, T]);
      db.run("INSERT OR REPLACE INTO po_quote_prices (id, quote_id, po_line_id, unit_cost_fils, created_at, updated_at) VALUES (?, ?, 'l1', 18000, ?, ?)", [`p1:${supplier.id}:l1`, `p1:${supplier.id}`, T, T]);
    };
    write(A.db);
    A.db.run("INSERT INTO vehicle_files (id, vehicle_id, kind, file_name, data_base64, created_at, updated_at) VALUES (?, ?, 'mulkiya_front', 'front.jpg', 'AAAA', ?, ?)", [`${vehicleId}:mulkiya_front`, vehicleId, T, T]);
    expect(applyAtCloud(C.db, "P1", localChanges(A.db, 0)).issues).toEqual([]);
    setState(A.db, "last_pushed_seq", String(A.db.get<{ m: number }>("SELECT MAX(seq) AS m FROM change_log")!.m));
    expect(C.db.get("SELECT supplier_id FROM purchase_orders WHERE id = 'p1'")).toEqual({ supplier_id: null });
    expect(C.db.get("SELECT unit_cost_fils FROM po_quote_prices")).toEqual({ unit_cost_fils: 18000 });
    expect(C.db.get("SELECT kind, data_base64 FROM vehicle_files")).toEqual({ kind: "mulkiya_front", data_base64: "AAAA" });
    // The cloud asks the same vendor again: the same row, changed.
    C.db.run("UPDATE po_quote_prices SET unit_cost_fils = 17000, updated_at = ? WHERE id = ?", ["2026-11-26T09:00:00.000Z", `p1:${supplier.id}:l1`]);
    applyAtPc(A.db, changesFor(C.db, 0, "P1"));
    expect(A.db.all("SELECT unit_cost_fils FROM po_quote_prices")).toEqual([{ unit_cost_fils: 17000 }]);
    expect(A.db.all("SELECT id FROM po_quotes")).toHaveLength(1);
  });
});
