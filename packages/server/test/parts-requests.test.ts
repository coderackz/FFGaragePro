import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FLEETFIX_SUPPLIER_ID } from "@ffgp/shared";
import { Db } from "../src/db";
import { addUser, call, createPart, makeApp, setUp, tempDir } from "./helpers";

const PART = { kind: "part", description: "Front brake pads", qty: 1, unitPriceFils: 30000, discountPct: 0 };

export async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const advisor = await addUser(app, owner, "advisor");
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  const vehicle = (await call(app, "POST", "/api/vehicles", owner, { customerId: customer.id, plate: "D 12345", make: "Toyota", model: "Land Cruiser", year: 2019, vin: "JTMHV05J904123456" })).body.vehicle;
  const jobCard = async (lines: unknown[]) =>
    (await call(app, "POST", "/api/documents", owner, { type: "jobcard", customerId: customer.id, vehicleId: vehicle.id, lines })).body.document;
  const vendor = async (name: string, extra: Record<string, unknown> = {}) => (await call(app, "POST", "/api/suppliers", owner, { name, ...extra })).body.supplier;
  return { app, owner, advisor, customer, vehicle, jobCard, vendor };
}

describe("migration 29", () => {
  it("purchase orders keep everything and may have no vendor; quotes, prices and Mulkiya have tables", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 28 });
    const t = "2026-11-01T08:00:00.000Z";
    old.run("INSERT INTO suppliers (id, name, created_at, updated_at) VALUES ('s1', 'Gulf Parts', ?, ?)", [t, t]);
    old.run("INSERT INTO purchase_orders (id, series, seq, number, supplier_id, status, notes, net_fils, created_at, updated_at, version) VALUES ('p1', '', 7, 'PO-00007', 's1', 'received', 'n', 500, ?, ?, 3)", [t, t]);
    old.run("INSERT INTO po_lines (id, po_id, position, description, qty, received_qty, unit_cost_fils, created_at, updated_at) VALUES ('l1', 'p1', 0, 'Belt', 1, 1, 500, ?, ?)", [t, t]);
    old.run("INSERT INTO goods_receipts (id, po_id, net_fils, vat_fils, gross_fils, created_at) VALUES ('g1', 'p1', 500, 0, 500, ?)", [t]);
    old.close();
    const db = new Db(file);
    expect(db.get("SELECT id, series, seq, number, supplier_id, status, notes, net_fils, version, job_document_id FROM purchase_orders")).toEqual({
      id: "p1", series: "", seq: 7, number: "PO-00007", supplier_id: "s1", status: "received", notes: "n", net_fils: 500, version: 3, job_document_id: null,
    });
    expect(db.get("SELECT po_id FROM po_lines")).toEqual({ po_id: "p1" });
    db.run("INSERT INTO purchase_orders (id, series, seq, number, supplier_id, status, created_at, updated_at) VALUES ('p2', '', 8, 'PO-00008', NULL, 'draft', ?, ?)", [t, t]);
    db.run("INSERT INTO po_quotes (id, po_id, supplier_id, created_at, updated_at) VALUES ('p2:s1', 'p2', 's1', ?, ?)", [t, t]);
    db.run("INSERT INTO po_quote_prices (id, quote_id, po_line_id, unit_cost_fils, created_at, updated_at) VALUES ('p2:s1:l1', 'p2:s1', 'l1', NULL, ?, ?)", [t, t]);
    expect(db.all("SELECT name FROM pragma_table_info('messages') WHERE name IN ('po_id', 'supplier_id') ORDER BY name")).toEqual([{ name: "po_id" }, { name: "supplier_id" }]);
    expect(db.all("SELECT name FROM pragma_table_info('vehicle_files') ORDER BY cid").map((c: any) => c.name)).toEqual(["id", "vehicle_id", "kind", "file_name", "data_base64", "created_at", "updated_at"]);
    db.close();
  });
});

describe("advisors see no vendors", () => {
  it("the supplier list and details, purchase orders, the used parts list and vendor messages are refused", async () => {
    const { app, owner, advisor, vendor } = await world();
    const gulf = await vendor("Gulf Parts", { phone: "0501234567" });
    const po = (await call(app, "POST", "/api/purchase-orders", owner, { supplierId: gulf.id, notes: null, lines: [{ partId: null, description: "Belt", qty: 1, unitCostFils: 100 }] })).body.purchaseOrder;
    for (const path of ["/api/suppliers", `/api/suppliers/${gulf.id}`, "/api/purchase-orders", `/api/purchase-orders/${po.id}`, "/api/used-parts-to-buy"]) {
      expect((await call(app, "GET", path, advisor)).status, path).toBe(403);
      expect((await call(app, "GET", path, owner)).status, path).toBe(200);
    }
    const sent = await call(app, "POST", `/api/purchase-orders/${po.id}/messages`, owner, { supplierId: gulf.id, channel: "whatsapp", recipient: "971501234567", body: "Order PO-00001" });
    expect(sent.status).toBe(200);
    const id = sent.body.message.id;
    expect((await call(app, "GET", "/api/messages", owner)).body.messages.map((m: any) => m.id)).toContain(id);
    expect((await call(app, "GET", "/api/messages", advisor)).body.messages.map((m: any) => m.id)).not.toContain(id);
    expect((await call(app, "GET", `/api/messages/${id}`, advisor)).status).toBe(404);
    expect((await call(app, "POST", `/api/purchase-orders/${po.id}/messages`, advisor, { supplierId: gulf.id, channel: "whatsapp", recipient: "971501234567", body: "x" })).status).toBe(403);
  });
});

describe("Request part without a vendor", () => {
  const request = (app: any, token: string, documentId: string, position: number, extra: Record<string, unknown> = {}) =>
    call(app, "POST", "/api/purchase-requests", token, { documentId, position, qty: 1, ...extra });

  it("an advisor's request makes this job card's order with no vendor; the next joins it; a vendor sent anyway is ignored", async () => {
    const { app, owner, advisor, jobCard } = await world();
    const jc = await jobCard([PART, { ...PART, description: "Rear shocks", qty: 2 }]);
    const first = await request(app, advisor, jc.id, 0, { supplierId: FLEETFIX_SUPPLIER_ID });
    expect(first.status).toBe(200);
    expect(first.body.document.lines[0]).toMatchObject({ orderStatus: "requested", purchaseOrderNumber: "PO-00001" });
    const second = await request(app, advisor, jc.id, 1, { qty: 2 });
    expect(second.body.document.lines[1]).toMatchObject({ orderStatus: "requested", purchaseOrderNumber: "PO-00001" });
    expect(app.db.all("SELECT supplier_id, job_document_id, status FROM purchase_orders")).toEqual([{ supplier_id: null, job_document_id: jc.id, status: "draft" }]);
    expect(app.db.all("SELECT description, qty, unit_cost_fils FROM po_lines ORDER BY position")).toEqual([
      { description: "Front brake pads", qty: 1, unit_cost_fils: 0 }, { description: "Rear shocks", qty: 2, unit_cost_fils: 0 },
    ]);
    const other = await jobCard([PART]);
    expect((await request(app, owner, other.id, 0)).body.document.lines[0].purchaseOrderNumber).toBe("PO-00002");
  });

  it("Request parts takes every line still to request, not shelf, used, Fleet Fix or ordered ones", async () => {
    const { app, owner, advisor, jobCard } = await world();
    const shelf = await createPart(app, owner);
    const jc = await jobCard([
      PART, { ...PART, description: "Oil filter", partId: shelf.id }, { ...PART, description: "Alternator", condition: "used" },
      { ...PART, description: "Wiper", suppliedBy: "fleetfix" }, { ...PART, description: "Coolant" }, { kind: "labour", description: "Fit", qty: 1, unitPriceFils: 100, discountPct: 0 },
    ]);
    await request(app, advisor, jc.id, 4);
    const all = await call(app, "POST", "/api/purchase-requests/all", advisor, { documentId: jc.id });
    expect(all.status).toBe(200);
    expect(all.body.document.lines.map((l: any) => l.orderStatus)).toEqual(["requested", null, null, null, "requested", null]);
    expect(app.db.all("SELECT description FROM po_lines ORDER BY position")).toEqual([{ description: "Coolant" }, { description: "Front brake pads" }]);
    expect((await call(app, "POST", "/api/purchase-requests/all", advisor, { documentId: jc.id })).body.error).toBe("Nothing to request");
  });

  it("Already bought needs the shop, and only Owner or Accountant", async () => {
    const { app, owner, advisor, jobCard, vendor } = await world();
    const jc = await jobCard([PART]);
    const bought = { alreadyBought: true, unitCostFils: 10000 };
    expect((await request(app, owner, jc.id, 0, bought)).body.error).toBe("Choose the supplier");
    const shop = await vendor("Corner shop");
    expect((await request(app, advisor, jc.id, 0, { ...bought, supplierId: shop.id })).status).toBe(403);
    const ok = await request(app, owner, jc.id, 0, { ...bought, supplierId: shop.id });
    expect(ok.body.document.lines[0]).toMatchObject({ orderStatus: "received" });
  });
});

describe("vendors' prices and ordering", () => {
  async function requested() {
    const w = await world();
    const jc = await w.jobCard([PART, { ...PART, description: "Rear shocks", qty: 2 }, { ...PART, description: "Coolant" }]);
    await call(w.app, "POST", "/api/purchase-requests/all", w.advisor, { documentId: jc.id });
    const id = w.app.db.get<{ id: string }>("SELECT id FROM purchase_orders")!.id;
    const get = async () => (await call(w.app, "GET", `/api/purchase-orders/${id}`, w.owner)).body.purchaseOrder;
    return { ...w, jc, id, get };
  }

  it("asks vendors (a new one saved, the same phone the same vendor), takes their prices, and shows the request", async () => {
    const { app, owner, id, get, vendor, jc } = await requested();
    const gulf = await vendor("Gulf Parts", { phone: "050 111 2222" });
    const asked = await call(app, "POST", `/api/purchase-orders/${id}/quotes`, owner, { vendors: [{ supplierId: gulf.id }, { name: "Sajaa Spares", phone: "0503334444", email: "sales@sajaa.example" }, { name: "Gulf", phone: "+971501112222" }] });
    expect(asked.status).toBe(200);
    expect(asked.body.purchaseOrder).toMatchObject({ request: true, supplier: null, job: { number: jc.number, vehicle: { make: "Toyota", vin: "JTMHV05J904123456", mulkiya: { front: false, back: false } } } });
    expect(asked.body.purchaseOrder.quotes.map((q: any) => q.name)).toEqual(["Gulf Parts", "Sajaa Spares"]);
    const sajaa = asked.body.purchaseOrder.quotes[1].supplierId;
    const [pads, shocks] = (await get()).lines;
    const priced = await call(app, "PUT", `/api/purchase-orders/${id}/quote-prices`, owner, { prices: [
      { supplierId: gulf.id, poLineId: pads.id, unitCostFils: 18000 }, { supplierId: sajaa, poLineId: pads.id, unitCostFils: 16500 },
      { supplierId: gulf.id, poLineId: shocks.id, unitCostFils: 42000 }, { supplierId: sajaa, poLineId: shocks.id, unitCostFils: null },
    ] });
    expect(priced.body.purchaseOrder.quotes[1].prices).toEqual(expect.arrayContaining([{ poLineId: pads.id, unitCostFils: 16500 }, { poLineId: shocks.id, unitCostFils: null }]));
    const other = await vendor("Not asked");
    expect((await call(app, "PUT", `/api/purchase-orders/${id}/quote-prices`, owner, { prices: [{ supplierId: other.id, poLineId: pads.id, unitCostFils: 1 }] })).body.error).toBe("Ask that vendor for prices first");
    const list = (await call(app, "GET", "/api/parts-requests", owner)).body.requests;
    expect(list).toEqual([expect.objectContaining({ id, jobDocumentNumber: jc.number, lineCount: 3, asked: 0, priced: 2, vehicle: expect.objectContaining({ plate: "D 12345" }) })]);
  });

  it("orders per vendor: the request keeps its number for the first part's vendor, another vendor gets a new order, the rest a new request", async () => {
    const { app, owner, advisor, id, get, vendor, jc } = await requested();
    const [gulf, sajaa] = [await vendor("Gulf Parts"), await vendor("Sajaa Spares")];
    await call(app, "POST", `/api/purchase-orders/${id}/quotes`, owner, { vendors: [{ supplierId: gulf.id }, { supplierId: sajaa.id }] });
    const [pads, shocks, coolant] = (await get()).lines;
    await call(app, "PUT", `/api/purchase-orders/${id}/quote-prices`, owner, { prices: [
      { supplierId: gulf.id, poLineId: pads.id, unitCostFils: 18000 }, { supplierId: sajaa.id, poLineId: shocks.id, unitCostFils: 39500 },
    ] });
    const version = (await get()).version;
    expect((await call(app, "POST", `/api/purchase-orders/${id}/order`, owner, { version, choices: [{ poLineId: shocks.id, supplierId: gulf.id }] })).body.error).toBe("Gulf Parts has no price for Rear shocks");
    expect((await call(app, "POST", `/api/purchase-orders/${id}/order`, owner, { version: version - 1, choices: [{ poLineId: pads.id, supplierId: gulf.id }] })).status).toBe(409);
    expect((await call(app, "POST", `/api/purchase-orders/${id}/order`, advisor, { version, choices: [{ poLineId: pads.id, supplierId: gulf.id }] })).status).toBe(403);
    const ordered = await call(app, "POST", `/api/purchase-orders/${id}/order`, owner, { version, choices: [{ poLineId: pads.id, supplierId: gulf.id }, { poLineId: shocks.id, supplierId: sajaa.id }] });
    expect(ordered.status).toBe(200);
    const pos = ordered.body.purchaseOrders;
    expect(pos.map((p: any) => [p.number, p.supplier?.name ?? null, p.status, p.netFils, p.lines.map((l: any) => l.description)])).toEqual([
      ["PO-00001", "Gulf Parts", "draft", 18000, ["Front brake pads"]],
      ["PO-00002", "Sajaa Spares", "draft", 79000, ["Rear shocks"]],
      ["PO-00003", null, "draft", 0, ["Coolant"]],
    ]);
    expect(pos[2].request).toBe(true);
    const doc = (await call(app, "GET", `/api/documents/${jc.id}`, advisor)).body.document;
    expect(doc.lines.map((l: any) => [l.orderStatus, l.purchaseOrderNumber])).toEqual([["on_order", "PO-00001"], ["on_order", "PO-00002"], ["requested", "PO-00003"]]);
    expect(doc).not.toHaveProperty("lines.0.supplierName");
    expect(JSON.stringify(doc)).not.toContain("Gulf");
    expect((await call(app, "POST", `/api/purchase-orders/${id}/quotes`, owner, { vendors: [{ supplierId: gulf.id }] })).body.error).toBe("PO-00001 isn't a request any more");
  });

  it("a request can't be received, marked sent or sent; asking marks the vendor asked; sending an order marks it sent", async () => {
    const { app, owner, id, get, vendor } = await requested();
    const gulf = await vendor("Gulf Parts", { phone: "0501112222" });
    const [pads] = (await get()).lines;
    expect((await call(app, "POST", `/api/purchase-orders/${id}/receive`, owner, { vatFils: 0, lines: [{ poLineId: pads.id, qty: 1, unitCostFils: 100 }] })).body.error).toBe("Choose the vendor first");
    expect((await call(app, "PATCH", `/api/purchase-orders/${id}`, owner, { status: "sent" })).body.error).toBe("Choose the vendor first");
    const ask = await call(app, "POST", `/api/purchase-orders/${id}/messages`, owner, { supplierId: gulf.id, channel: "whatsapp", recipient: "971501112222", body: "Price please" });
    expect(ask.body.message).toMatchObject({ event: "parts_request", status: "opened", purchaseOrderId: id, supplierId: gulf.id });
    expect(ask.body.purchaseOrder.quotes).toEqual([expect.objectContaining({ name: "Gulf Parts", askedAt: expect.any(String) })]);
    expect(ask.body.purchaseOrder.messages).toHaveLength(1);
    await call(app, "PUT", `/api/purchase-orders/${id}/quote-prices`, owner, { prices: [{ supplierId: gulf.id, poLineId: pads.id, unitCostFils: 100 }] });
    await call(app, "POST", `/api/purchase-orders/${id}/order`, owner, { version: (await get()).version, choices: [{ poLineId: pads.id, supplierId: gulf.id }] });
    const other = await vendor("Somebody");
    expect((await call(app, "POST", `/api/purchase-orders/${id}/messages`, owner, { supplierId: other.id, channel: "email", recipient: "a@b.example", body: "x" })).body.error).toBe("That isn't this order's vendor");
    const send = await call(app, "POST", `/api/purchase-orders/${id}/messages`, owner, { supplierId: gulf.id, channel: "email", recipient: "gulf@example.com", subject: "PO-00001", body: "Our order" });
    expect(send.body.message).toMatchObject({ event: "purchase_order", status: "queued" });
    expect(send.body.purchaseOrder.status).toBe("sent");
  });

  it("a part requested after vendors were asked joins the request, with no prices yet", async () => {
    const { app, owner, advisor, id, get, vendor, jc } = await requested();
    const gulf = await vendor("Gulf Parts");
    await call(app, "POST", `/api/purchase-orders/${id}/quotes`, owner, { vendors: [{ supplierId: gulf.id }] });
    const saved = await call(app, "PUT", `/api/documents/${jc.id}/lines`, advisor, { lines: (await call(app, "GET", `/api/documents/${jc.id}`, advisor)).body.document.lines.map((l: any) => ({ ...l })).concat([{ ...PART, description: "Wiper blades" }]) });
    expect(saved.status).toBe(200);
    await call(app, "POST", "/api/purchase-requests", advisor, { documentId: jc.id, position: 3, qty: 1 });
    const po = await get();
    expect(po.lines.map((l: any) => l.description)).toEqual(["Front brake pads", "Rear shocks", "Coolant", "Wiper blades"]);
    expect(po.quotes[0].prices).toEqual([]);
  });
});

describe("Mulkiya on the vehicle", () => {
  it("anyone who edits customers adds, replaces, reads and removes the front and back; the vehicle says which it has", async () => {
    const { app, advisor, vehicle } = await world();
    const path = (kind: string) => `/api/vehicles/${vehicle.id}/files/${kind}`;
    expect((await call(app, "PUT", path("mulkiya_front"), advisor, { fileName: "front.jpg", base64: "AAAA" })).status).toBe(200);
    expect((await call(app, "PUT", path("mulkiya_front"), advisor, { fileName: "front2.jpg", base64: "BBBB" })).status).toBe(200);
    expect((await call(app, "GET", path("mulkiya_front"), advisor)).body).toEqual({ fileName: "front2.jpg", base64: "BBBB" });
    expect((await call(app, "GET", `/api/vehicles/${vehicle.id}`, advisor)).body.vehicle.mulkiya).toEqual({ front: true, back: false });
    expect((await call(app, "PUT", path("mulkiya_back"), advisor, { fileName: "back.pdf", base64: "AAAA" })).body.error).toBe("Choose a JPEG or PNG photo");
    expect((await call(app, "PUT", path("passport"), advisor, { fileName: "a.jpg", base64: "AAAA" })).status).toBe(404);
    expect((await call(app, "GET", path("mulkiya_back"), advisor)).status).toBe(404);
    expect((await call(app, "DELETE", path("mulkiya_front"), advisor)).status).toBe(200);
    expect((await call(app, "GET", `/api/vehicles/${vehicle.id}`, advisor)).body.vehicle.mulkiya).toEqual({ front: false, back: false });
    expect(app.db.all("SELECT id FROM vehicle_files")).toEqual([]);
  });
});
