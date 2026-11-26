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

  async function twoPlaces() {
    const A = await garageApp(undefined, { numbers: { next: async () => null, offlineSeries: "P1" } });
    apps.push(A);
    const token = await setUp(A);
    const customer = (await call(A, "POST", "/api/customers", token, { kind: "individual", name: "Ali" })).body.customer;
    const gulf = (await call(A, "POST", "/api/suppliers", token, { name: "Gulf Parts" })).body.supplier;
    const part = (description: string) => ({ kind: "part", description, qty: 1, unitPriceFils: 30000, discountPct: 0 });
    const doc = (await call(A, "POST", "/api/documents", token, { type: "jobcard", customerId: customer.id, lines: [part("Brake pads"), part("Wiper blades")] })).body.document;
    const C = await garageApp(twin(A.db));
    apps.push(C);
    installCapture(A.db, "local");
    installCapture(C.db, "cloud");
    let pushed = 0;
    const push = () => {
      const changes = localChanges(A.db, pushed);
      expect(applyAtCloud(C.db, "P1", changes).issues).toEqual([]);
      pushed = A.db.get<{ m: number }>("SELECT MAX(seq) AS m FROM change_log")!.m;
      setState(A.db, "last_pushed_seq", String(pushed));
    };
    const pull = () => expect(applyAtPc(A.db, changesFor(C.db, 0, "P1")).issues).toEqual([]);
    return { A, C, token, gulf, doc, push, pull };
  }
  const order = async (app: App, token: string, poId: string, supplierId: string, lineIds: string[]) => {
    await call(app, "POST", `/api/purchase-orders/${poId}/quotes`, token, { vendors: [{ supplierId }] });
    const po = (await call(app, "PUT", `/api/purchase-orders/${poId}/quote-prices`, token, { prices: lineIds.map((poLineId) => ({ supplierId, poLineId, unitCostFils: 1000 })) })).body.purchaseOrder;
    return call(app, "POST", `/api/purchase-orders/${poId}/order`, token, { version: po.version, choices: lineIds.map((poLineId) => ({ poLineId, supplierId })) });
  };

  it("a part requested on a PC while the cloud orders the request is flagged on the cloud, never lost", async () => {
    const { A, C, token, gulf, doc, push } = await twoPlaces();
    const first = (await call(A, "POST", "/api/purchase-requests", token, { documentId: doc.id, position: 0, qty: 1 })).body.document.lines[0];
    push();
    expect((await order(C, token, first.purchaseOrderId, gulf.id, [first.poLineId])).status).toBe(200);
    await call(C, "PATCH", `/api/purchase-orders/${first.purchaseOrderId}`, token, { status: "sent" });
    // The PC hasn't heard: the second part joins what it still sees as the request.
    expect((await call(A, "POST", "/api/purchase-requests", token, { documentId: doc.id, position: 1, qty: 1 })).body.document.lines[1].purchaseOrderId).toBe(first.purchaseOrderId);
    push();
    const list = (await call(C, "GET", "/api/parts-requests", token)).body;
    expect(list.late).toEqual([expect.objectContaining({ description: "Wiper blades", supplierName: "Gulf Parts" })]);
    expect((await call(C, "GET", `/api/documents/${doc.id}`, token)).body.document.lines.map((l: any) => l.orderStatus)).toEqual(["on_order", "requested"]);
  });

  it("an order and a priced line taken off a request on the cloud reach the PC", async () => {
    const { A, C, token, gulf, doc, push, pull } = await twoPlaces();
    const lines = (await call(A, "POST", "/api/purchase-requests/all", token, { documentId: doc.id })).body.document.lines;
    push();
    const poId = lines[0].purchaseOrderId;
    await call(C, "POST", `/api/purchase-orders/${poId}/quotes`, token, { vendors: [{ supplierId: gulf.id }] });
    const priced = (await call(C, "PUT", `/api/purchase-orders/${poId}/quote-prices`, token, { prices: lines.map((l: any) => ({ supplierId: gulf.id, poLineId: l.poLineId, unitCostFils: 1000 })) })).body.purchaseOrder;
    const off = await call(C, "PATCH", `/api/purchase-orders/${poId}`, token, { version: priced.version, lines: priced.lines.slice(0, 1).map((l: any) => ({ id: l.id, partId: null, description: l.description, qty: l.qty, unitCostFils: 0, jobDocumentId: l.jobDocumentId })) });
    expect(off.status).toBe(200);
    expect((await order(C, token, poId, gulf.id, [lines[0].poLineId])).status).toBe(200);
    pull();
    expect(A.db.get("SELECT supplier_id, net_fils FROM purchase_orders WHERE id = ?", [poId])).toEqual({ supplier_id: gulf.id, net_fils: 1000 });
    expect(A.db.all("SELECT description FROM po_lines WHERE po_id = ?", [poId])).toEqual([{ description: "Brake pads" }]);
    expect(A.db.all("SELECT id FROM po_quote_prices WHERE po_line_id = ?", [lines[1].poLineId])).toEqual([]);
  });
});

