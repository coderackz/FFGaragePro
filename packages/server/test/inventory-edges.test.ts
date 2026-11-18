import { describe, expect, it } from "vitest";
import { FLEETFIX_SUPPLIER_ID } from "@ffgp/shared";
import { addUser, call, createPart, makeApp, onHand, setUp, type App } from "./helpers";

// Final-review findings: two PCs working on the same job card / purchase order, and costs.

async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const accountant = await addUser(app, owner, "accountant");
  const advisor = await addUser(app, owner, "advisor");
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
  const disc = await createPart(app, owner, { partNo: "BD-220", name: "Brake disc", stocked: false });
  return { app, owner, accountant, advisor, customer, disc };
}
const line = (part: { id: string; name: string }, qty = 1, extra: Record<string, unknown> = {}) => ({
  kind: "part", description: part.name, qty, unitPriceFils: 20000, discountPct: 0, partId: part.id, ...extra,
});
const labour = { kind: "labour", description: "Fitting", qty: 1, unitPriceFils: 5000, discountPct: 0 };
const jobCard = async (app: App, token: string, customerId: string, lines: unknown[]) =>
  (await call(app, "POST", "/api/documents", token, { type: "jobcard", customerId, lines })).body.document;
const request = (app: App, token: string, documentId: string, extra: Record<string, unknown> = {}) =>
  call(app, "POST", "/api/purchase-requests", token, { documentId, position: 0, supplierId: FLEETFIX_SUPPLIER_ID, qty: 1, ...extra });
const getDoc = async (app: App, token: string, id: string) => (await call(app, "GET", `/api/documents/${id}`, token)).body.document;
const getPo = async (app: App, token: string, id: string) => (await call(app, "GET", `/api/purchase-orders/${id}`, token)).body.purchaseOrder;

describe("two PCs on one purchase order (C1)", () => {
  it("a stale save of a PO is refused instead of deleting lines added meanwhile", async () => {
    const { app, accountant, advisor, customer, disc } = await world();
    const one = await jobCard(app, advisor, customer.id, [line(disc)]);
    const poId = (await request(app, advisor, one.id)).body.document.lines[0].purchaseOrderId;
    const seen = await getPo(app, accountant, poId); // accountant opens the draft
    const two = await jobCard(app, advisor, customer.id, [line(disc)]);
    await request(app, advisor, two.id); // advisor adds to the same draft meanwhile
    const stale = await call(app, "PATCH", `/api/purchase-orders/${poId}`, accountant, {
      version: seen.version, lines: seen.lines.map((l: any) => ({ ...l, unitCostFils: 9000 })), status: "sent",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed/i);
    expect((await getPo(app, accountant, poId)).lines).toHaveLength(2);
    expect((await getDoc(app, advisor, two.id)).lines[0].orderStatus).toBe("on_order");
  });
});

describe("the job card's link to its order is kept by the server (I1, M4, M5)", () => {
  it("a save from a PC that didn't know about the request keeps the link", async () => {
    const { app, advisor, customer, disc } = await world();
    const jc = await jobCard(app, advisor, customer.id, [labour, line(disc)]);
    await request(app, advisor, jc.id, { position: 1, description: "Brake disc" });
    // PC-A still has the old copy (no poLineId) and saves an edit.
    const saved = await call(app, "PUT", `/api/documents/${jc.id}/lines`, advisor, { lines: [{ ...labour, qty: 2 }, line(disc)] });
    expect(saved.body.document.lines[1].orderStatus).toBe("on_order");
    expect((await request(app, advisor, jc.id, { position: 1 })).body.error).toBe("This line is already requested");
  });

  it("a stale save can't re-link a line to a cancelled order", async () => {
    const { app, accountant, advisor, customer, disc } = await world();
    const jc = await jobCard(app, advisor, customer.id, [line(disc)]);
    const requested = (await request(app, advisor, jc.id)).body.document.lines[0];
    await call(app, "PATCH", `/api/purchase-orders/${requested.purchaseOrderId}`, accountant, { status: "cancelled" });
    const saved = await call(app, "PUT", `/api/documents/${jc.id}/lines`, advisor, { lines: [line(disc, 1, { poLineId: requested.poLineId })] });
    expect(saved.status).toBe(200);
    expect(saved.body.document.lines[0].orderStatus).toBeNull();
    expect((await request(app, advisor, jc.id)).status).toBe(200);
  });

  it("a removed order line doesn't block saving the job card", async () => {
    const { app, accountant, advisor, customer, disc } = await world();
    const jc = await jobCard(app, advisor, customer.id, [line(disc)]);
    const requested = (await request(app, advisor, jc.id)).body.document.lines[0];
    const po = await getPo(app, accountant, requested.purchaseOrderId);
    await call(app, "PATCH", `/api/purchase-orders/${po.id}`, accountant, { version: po.version, lines: [{ description: "Coolant", qty: 1 }] });
    const saved = await call(app, "PUT", `/api/documents/${jc.id}/lines`, advisor, { lines: [line(disc, 1, { poLineId: requested.poLineId })] });
    expect(saved.status).toBe(200);
    expect(saved.body.document.lines[0].poLineId).toBeNull();
  });

  it("a line can't borrow another job's order line", async () => {
    const { app, accountant, advisor, customer, disc } = await world();
    const other = await jobCard(app, accountant, customer.id, [line(disc)]);
    const theirs = (await request(app, accountant, other.id, { alreadyBought: true, unitCostFils: 3000 })).body.document.lines[0];
    const mine = await jobCard(app, advisor, customer.id, [line(disc, 1, { poLineId: theirs.poLineId })]);
    expect(mine.lines[0].poLineId).toBeNull();
  });

  it("a request names its line, so a changed job card is refused", async () => {
    const { app, advisor, customer, disc } = await world();
    const jc = await jobCard(app, advisor, customer.id, [line(disc)]);
    const res = await request(app, advisor, jc.id, { description: "Front bumper" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed/i);
  });
});

describe("cancelling never touches issued invoices (M2)", () => {
  it("an issued invoice keeps its order link when the order is cancelled", async () => {
    const { app, owner, accountant, advisor, customer, disc } = await world();
    const jc = await jobCard(app, advisor, customer.id, [line(disc)]);
    const poId = (await request(app, advisor, jc.id)).body.document.lines[0].purchaseOrderId;
    const inv = (await call(app, "POST", `/api/documents/${jc.id}/convert`, owner)).body.document;
    await call(app, "POST", `/api/documents/${inv.id}/issue`, owner);
    const before = (await getDoc(app, owner, inv.id)).lines[0].poLineId;
    await call(app, "PATCH", `/api/purchase-orders/${poId}`, accountant, { status: "cancelled" });
    expect((await getDoc(app, owner, inv.id)).lines[0].poLineId).toBe(before);
  });
});

describe("advisors can't set order costs (M3)", () => {
  it("a plain request ignores a cost", async () => {
    const { app, accountant, advisor, customer, disc } = await world();
    const jc = await jobCard(app, advisor, customer.id, [line(disc)]);
    const poId = (await request(app, advisor, jc.id, { unitCostFils: 1 })).body.document.lines[0].purchaseOrderId;
    expect((await getPo(app, accountant, poId)).lines[0].unitCostFils).toBe(0);
  });
});

describe("shelf / per-job switch (I2)", () => {
  it("is refused while the part is on an open job card", async () => {
    const { app, owner, advisor, customer } = await world();
    const pads = await createPart(app, owner, { partNo: "BP-77", name: "Brake pads" }, { qty: 2, unitCostFils: 1000 });
    const jc = await jobCard(app, advisor, customer.id, [line(pads, 2)]);
    expect(await onHand(app, owner, pads.id)).toBe(0);
    const res = await call(app, "PATCH", `/api/parts/${pads.id}`, owner, { partNo: "BP-77", name: "Brake pads", stocked: false, sellPriceFils: 3500 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(jc.number);
  });
});

describe("notes survive status changes (I3)", () => {
  it("marking a PO sent keeps its notes", async () => {
    const { app, accountant } = await world();
    const po = (await call(app, "POST", "/api/purchase-orders", accountant, { supplierId: FLEETFIX_SUPPLIER_ID, notes: "Deliver before 10am", lines: [{ description: "Coolant", qty: 1 }] })).body.purchaseOrder;
    expect((await call(app, "PATCH", `/api/purchase-orders/${po.id}`, accountant, { status: "sent" })).body.purchaseOrder.notes).toBe("Deliver before 10am");
  });
  it("changing a job card's status keeps its notes", async () => {
    const { app, advisor, customer } = await world();
    const jc = (await call(app, "POST", "/api/documents", advisor, { type: "jobcard", customerId: customer.id, notes: "Noise from front left", lines: [labour] })).body.document;
    expect((await call(app, "PATCH", `/api/documents/${jc.id}`, advisor, { status: "in_progress" })).body.document.notes).toBe("Noise from front left");
  });
});

describe("job cost (I4)", () => {
  it("a stocked part fitted before its delivery is costed from the received order", async () => {
    const { app, owner, accountant, customer } = await world();
    const filter = await createPart(app, owner, { partNo: "OF-1", name: "Oil filter" });
    const jc = await jobCard(app, accountant, customer.id, [line(filter)]);
    expect((await getDoc(app, owner, jc.id)).costPending).toBe(true); // taken at cost 0
    const doc = (await request(app, accountant, jc.id, { alreadyBought: true, unitCostFils: 4000 })).body.document;
    expect(doc).toMatchObject({ partsCostFils: 4000, costPending: false });
  });
  it("typed-in part lines are counted as not costed", async () => {
    const { app, owner, customer } = await world();
    const jc = await jobCard(app, owner, customer.id, [labour, { kind: "part", description: "Wiper", qty: 1, unitPriceFils: 1500, discountPct: 0 }]);
    expect((await getDoc(app, owner, jc.id)).uncostedLines).toBe(1);
  });
});
