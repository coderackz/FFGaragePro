import { describe, expect, it } from "vitest";
import { FLEETFIX_SUPPLIER_ID } from "@ffgp/shared";
import { addUser, call, createPart, makeApp, onHand, orderRequest, setUp, type App } from "./helpers";

async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const accountant = await addUser(app, owner, "accountant");
  const advisor = await addUser(app, owner, "advisor");
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  return { app, owner, accountant, advisor, customer };
}

const partLine = (part: { id: string; name: string }, qty: number) => ({
  kind: "part", description: part.name, qty, unitPriceFils: 20000, discountPct: 0, partId: part.id,
});

async function jobCard(app: App, token: string, customerId: string, lines: unknown[]) {
  return (await call(app, "POST", "/api/documents", token, { type: "jobcard", customerId, lines })).body.document;
}

const request = (app: App, token: string, documentId: string, extra: Record<string, unknown> = {}) =>
  call(app, "POST", "/api/purchase-requests", token, { documentId, position: 0, supplierId: FLEETFIX_SUPPLIER_ID, qty: 1, ...extra });

async function newPo(app: App, token: string, lines: unknown[], supplierId = FLEETFIX_SUPPLIER_ID) {
  const res = await call(app, "POST", "/api/purchase-orders", token, { supplierId, lines });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.purchaseOrder;
}

describe("purchasing", () => {
  it("advisor requests a part from a job card; accountant prices, sends, receives; job cost appears", async () => {
    const { app, owner, accountant, advisor, customer } = await world();
    const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
    const jc = await jobCard(app, advisor, customer.id, [partLine(disc, 1)]);

    const requested = await request(app, advisor, jc.id);
    expect(requested.status).toBe(200);
    expect(requested.body.document.lines[0]).toMatchObject({ orderStatus: "requested", purchaseOrderNumber: "PO-00001" });
    expect((await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document.costPending).toBe(true);

    const list = (await call(app, "GET", "/api/purchase-orders", accountant)).body.purchaseOrders;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: "PO-00001", status: "draft", supplierName: null });
    const po = (await call(app, "GET", `/api/purchase-orders/${list[0].id}`, accountant)).body.purchaseOrder;
    expect(po.lines[0]).toMatchObject({ partId: disc.id, description: "Brake disc", qty: 1, jobDocumentNumber: jc.number });

    await orderRequest(app, accountant, po.id, FLEETFIX_SUPPLIER_ID, 12000);
    // Ordered but not sent yet: still a request to the advisor.
    expect((await call(app, "GET", `/api/documents/${jc.id}`, advisor)).body.document.lines[0].orderStatus).toBe("requested");
    const priced = await call(app, "PATCH", `/api/purchase-orders/${po.id}`, accountant, { status: "sent" });
    expect((await call(app, "GET", `/api/documents/${jc.id}`, advisor)).body.document.lines[0].orderStatus).toBe("on_order");
    expect(priced.body.purchaseOrder).toMatchObject({ status: "sent", netFils: 12000 });
    expect(priced.body.purchaseOrder.lines[0].id).toBe(po.lines[0].id);

    const received = await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, accountant, {
      supplierInvoiceNo: "FF-881", vatFils: 600, lines: [{ poLineId: po.lines[0].id, qty: 1, unitCostFils: 12000 }],
    });
    expect(received.body.purchaseOrder.status).toBe("received");
    expect(received.body.purchaseOrder.receipts[0]).toMatchObject({ supplierInvoiceNo: "FF-881", netFils: 12000, vatFils: 600, grossFils: 12600 });

    const after = (await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document;
    expect(after.lines[0].orderStatus).toBe("received");
    expect(after).toMatchObject({ partsCostFils: 12000, costPending: false, marginFils: 8000 });
  });

  it("receiving a stocked part averages the cost", async () => {
    const { app, owner, accountant } = await world();
    const a = await createPart(app, owner, {}, { qty: 1, unitCostFils: 4000 });
    const po = await newPo(app, accountant, [{ partId: a.id, description: "Oil filter", qty: 1, unitCostFils: 5000 }]);
    await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, accountant, { lines: [{ poLineId: po.lines[0].id, qty: 1, unitCostFils: 5000 }] });
    const part = (await call(app, "GET", `/api/parts/${a.id}`, owner)).body;
    expect(part.part).toMatchObject({ onHand: 2, avgCostFils: 4500 });
    expect(part.movements[0]).toMatchObject({ reason: "receive", purchaseOrderNumber: po.number });
  });

  it("part receiving and over-receiving", async () => {
    const { app, owner, accountant } = await world();
    const a = await createPart(app, owner);
    const po = await newPo(app, accountant, [{ partId: a.id, description: "Oil filter", qty: 5, unitCostFils: 1000 }]);
    const receive = (qty: number) =>
      call(app, "POST", `/api/purchase-orders/${po.id}/receive`, accountant, { lines: [{ poLineId: po.lines[0].id, qty, unitCostFils: 1000 }] });
    expect((await receive(2)).body.purchaseOrder.status).toBe("part_received");
    const over = await receive(4);
    expect(over.status).toBe(400);
    expect(over.body.error).toContain("more than ordered");
    expect((await receive(3)).body.purchaseOrder.status).toBe("received");
    expect((await receive(1)).status).toBe(400);
    expect(await onHand(app, owner, a.id)).toBe(5);
  });

  it("a partial delivery at a different price keeps the ordered price for what's still to come", async () => {
    const { app, owner, accountant } = await world();
    const a = await createPart(app, owner);
    const po = await newPo(app, accountant, [{ partId: a.id, description: "Oil filter", qty: 10, unitCostFils: 5000 }]);
    const receive = (qty: number, unitCostFils: number) =>
      call(app, "POST", `/api/purchase-orders/${po.id}/receive`, accountant, { lines: [{ poLineId: po.lines[0].id, qty, unitCostFils }] });
    const part = (await receive(4, 5500)).body.purchaseOrder;
    // 4 at 55 delivered + 6 still to come at the ordered 50.
    expect(part.lines[0]).toMatchObject({ unitCostFils: 5000, netFils: 52000, receivedQty: 4 });
    expect(part.netFils).toBe(52000);
    const done = (await receive(6, 5000)).body.purchaseOrder;
    // All in: what was paid, on average 52 each.
    expect(done.lines[0]).toMatchObject({ unitCostFils: 5200, netFils: 52000 });
    expect(done.netFils).toBe(52000);
  });

  it("an unpriced line takes the delivery's price for the rest", async () => {
    const { app, owner, accountant } = await world();
    const a = await createPart(app, owner);
    const po = await newPo(app, accountant, [{ partId: a.id, description: "Oil filter", qty: 3, unitCostFils: 0 }]);
    const res = await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, accountant, { lines: [{ poLineId: po.lines[0].id, qty: 1, unitCostFils: 2000 }] });
    expect(res.body.purchaseOrder.lines[0]).toMatchObject({ unitCostFils: 2000, netFils: 6000 });
  });

  it("a job's part bought in two deliveries costs what each delivery cost", async () => {
    const { app, owner, accountant, customer } = await world();
    const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
    const jc = await jobCard(app, accountant, customer.id, [partLine(disc, 2)]);
    const poId = (await request(app, accountant, jc.id, { qty: 2 })).body.document.lines[0].purchaseOrderId;
    const po = await orderRequest(app, accountant, poId, FLEETFIX_SUPPLIER_ID);
    const receive = (unitCostFils: number) =>
      call(app, "POST", `/api/purchase-orders/${poId}/receive`, accountant, { lines: [{ poLineId: po.lines[0].id, qty: 1, unitCostFils }] });
    await receive(3000);
    await receive(4001);
    expect((await call(app, "GET", `/api/documents/${jc.id}`, owner)).body.document.partsCostFils).toBe(7001);
  });

  it("already bought, one step", async () => {
    const { app, owner, accountant, advisor, customer } = await world();
    const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
    const jc = await jobCard(app, advisor, customer.id, [partLine(disc, 2)]);
    expect((await request(app, advisor, jc.id, { qty: 2, alreadyBought: true, unitCostFils: 3000 })).status).toBe(403);
    const res = await request(app, accountant, jc.id, { qty: 2, alreadyBought: true, unitCostFils: 3000, supplierInvoiceNo: "CASH-12" });
    expect(res.status).toBe(200);
    expect(res.body.document.lines[0].orderStatus).toBe("received");
    expect(res.body.document.partsCostFils).toBe(6000);
    const po = (await call(app, "GET", `/api/purchase-orders/${res.body.document.lines[0].purchaseOrderId}`, accountant)).body.purchaseOrder;
    expect(po.status).toBe("received");
    expect(po.receipts[0].supplierInvoiceNo).toBe("CASH-12");
  });

  it("already bought: VAT is the garage's rate unless the receipt says otherwise (none from a shop without VAT)", async () => {
    const { app, owner, accountant, customer } = await world();
    const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
    const receiptOf = async (extra: Record<string, unknown>) => {
      const jc = await jobCard(app, accountant, customer.id, [partLine(disc, 2)]);
      const res = await request(app, accountant, jc.id, { qty: 2, alreadyBought: true, unitCostFils: 3000, ...extra });
      expect(res.status).toBe(200);
      return (await call(app, "GET", `/api/purchase-orders/${res.body.document.lines[0].purchaseOrderId}`, accountant)).body.purchaseOrder.receipts[0];
    };
    expect(await receiptOf({})).toMatchObject({ netFils: 6000, vatFils: 300, grossFils: 6300 });
    expect(await receiptOf({ vatFils: 0 })).toMatchObject({ netFils: 6000, vatFils: 0, grossFils: 6000 });
    expect(await receiptOf({ vatFils: 290 })).toMatchObject({ vatFils: 290, grossFils: 6290 });
  });

  it("an already-bought part gets its own PO, leaving the open draft alone", async () => {
    const { app, owner, accountant, customer } = await world();
    const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
    const draft = await newPo(app, accountant, [{ description: "Coolant", qty: 1, unitCostFils: 0 }]);
    const jc = await jobCard(app, accountant, customer.id, [partLine(disc, 1)]);
    const res = await request(app, accountant, jc.id, { alreadyBought: true, unitCostFils: 3000 });
    expect(res.body.document.lines[0].purchaseOrderId).not.toBe(draft.id);
    expect((await call(app, "GET", `/api/purchase-orders/${draft.id}`, accountant)).body.purchaseOrder.status).toBe("draft");
  });

  it("advisor can't open, make or receive POs", async () => {
    const { app, accountant, advisor } = await world();
    const po = await newPo(app, accountant, [{ description: "Coolant", qty: 1, unitCostFils: 2500 }]);
    expect((await call(app, "GET", `/api/purchase-orders/${po.id}`, advisor)).status).toBe(403);
    expect((await call(app, "GET", "/api/purchase-orders", advisor)).status).toBe(403);
    expect((await call(app, "POST", "/api/purchase-orders", advisor, { supplierId: FLEETFIX_SUPPLIER_ID, lines: [] })).status).toBe(403);
    expect((await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, advisor, { lines: [{ poLineId: po.lines[0].id, qty: 1, unitCostFils: 1 }] })).status).toBe(403);
  });

  it("can't request the same line twice, or a line that isn't a garage part", async () => {
    const { app, owner, advisor, customer } = await world();
    const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
    const jc = await jobCard(app, advisor, customer.id, [
      partLine(disc, 1),
      { kind: "labour", description: "Fitting", qty: 1, unitPriceFils: 5000, discountPct: 0 },
    ]);
    expect((await request(app, advisor, jc.id)).status).toBe(200);
    const again = await request(app, advisor, jc.id);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("This line is already requested");
    expect((await request(app, advisor, jc.id, { position: 1 })).status).toBe(400);
  });

  it("each job card has its own request", async () => {
    const { app, owner, advisor, customer } = await world();
    const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
    const one = await jobCard(app, advisor, customer.id, [partLine(disc, 1)]);
    const two = await jobCard(app, advisor, customer.id, [partLine(disc, 1)]);
    const a = (await request(app, advisor, one.id)).body.document.lines[0].purchaseOrderId;
    const b = (await request(app, advisor, two.id)).body.document.lines[0].purchaseOrderId;
    expect(b).not.toBe(a);
  });

  it("cancelling a PO frees its job lines to be requested again; can't cancel after receiving", async () => {
    const { app, owner, accountant, advisor, customer } = await world();
    const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
    const jc = await jobCard(app, advisor, customer.id, [partLine(disc, 1)]);
    const poId = (await request(app, advisor, jc.id)).body.document.lines[0].purchaseOrderId;
    expect((await call(app, "PATCH", `/api/purchase-orders/${poId}`, accountant, { status: "cancelled" })).body.purchaseOrder.status).toBe("cancelled");
    expect((await call(app, "GET", `/api/documents/${jc.id}`, advisor)).body.document.lines[0].orderStatus).toBeNull();
    const again = await request(app, advisor, jc.id);
    expect(again.status).toBe(200);
    const po2 = again.body.document.lines[0].purchaseOrderId;
    const line = (await orderRequest(app, accountant, po2, FLEETFIX_SUPPLIER_ID)).lines[0];
    await call(app, "POST", `/api/purchase-orders/${po2}/receive`, accountant, { lines: [{ poLineId: line.id, qty: 1, unitCostFils: 100 }] });
    expect((await call(app, "PATCH", `/api/purchase-orders/${po2}`, accountant, { status: "cancelled" })).status).toBe(409);
  });
});
