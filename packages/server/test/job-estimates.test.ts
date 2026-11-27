import { describe, expect, it } from "vitest";
import { FLEETFIX_SUPPLIER_ID } from "@ffgp/shared";
import { addUser, call, makeApp, orderRequest, setUp, type App } from "./helpers";

const labour = (description: string, unitPriceFils = 0) => ({ kind: "labour", description, qty: 1, unitPriceFils, discountPct: 0 });
const part = (description: string, unitPriceFils = 0, qty = 1) => ({ kind: "part", description, qty, unitPriceFils, discountPct: 0 });

async function world() {
  const app = await makeApp();
  const owner = await setUp(app);
  const accountant = await addUser(app, owner, "accountant");
  const advisor = await addUser(app, owner, "advisor");
  const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "0501112222" })).body.customer;
  const jobCard = async (lines: unknown[]) =>
    (await call(app, "POST", "/api/documents", advisor, { type: "jobcard", customerId: customer.id, lines })).body.document;
  const doc = async (id: string, token = owner) => (await call(app, "GET", `/api/documents/${id}`, token)).body.document;
  const estimateFor = (jobId: string, token = accountant) => call(app, "POST", `/api/documents/${jobId}/estimate`, token, {});
  const approve = (id: string, body: Record<string, unknown> = {}, token = accountant) =>
    call(app, "POST", `/api/documents/${id}/approve`, token, { via: "phone", byName: "Ahmed", declined: [], ...body });
  const setLines = (id: string, lines: unknown[], token = accountant) => call(app, "PUT", `/api/documents/${id}/lines`, token, { lines });
  return { app, owner, accountant, advisor, customer, jobCard, doc, estimateFor, approve, setLines };
}
const descs = (d: any) => d.lines.map((l: any) => l.description);

describe("an estimate from a job card", () => {
  it("is made with the job card's lines, for that job card, and the job card shows it", async () => {
    const { jobCard, estimateFor, doc } = await world();
    const jc = await jobCard([labour("Inspection"), part("Front brake pads")]);
    const res = await estimateFor(jc.id);
    expect(res.status).toBe(200);
    const est = res.body.document;
    expect(est).toMatchObject({ type: "estimate", number: "EST-00001", status: "draft", revision: 0, forJob: { id: jc.id, number: jc.number } });
    expect(descs(est)).toEqual(["Inspection", "Front brake pads"]);
    expect((await doc(jc.id)).estimate).toMatchObject({ id: est.id, number: "EST-00001", status: "draft" });
  });

  it("asked again before approval, it brings the job card's new lines into the same estimate", async () => {
    const { advisor, jobCard, estimateFor, setLines } = await world();
    const jc = await jobCard([labour("Inspection")]);
    const est = (await estimateFor(jc.id)).body.document;
    await setLines(jc.id, [labour("Inspection"), part("Wiper blades")], advisor);
    const again = (await estimateFor(jc.id)).body.document;
    expect(again.id).toBe(est.id);
    expect(again.number).toBe("EST-00001");
    expect(descs(again)).toEqual(["Inspection", "Wiper blades"]);
  });

  it("an estimate for a job card can't become another job card", async () => {
    const { app, owner, jobCard, estimateFor } = await world();
    const jc = await jobCard([labour("Inspection")]);
    const est = (await estimateFor(jc.id)).body.document;
    const conv = await call(app, "POST", `/api/documents/${est.id}/convert`, owner, {});
    expect(conv.status).toBe(409);
    expect(conv.body.error).toBe(`${est.number} is for ${jc.number}`);
  });
});

describe("recording approval", () => {
  it("records who, how and when; declined lines don't count; approved lines go back to the job card", async () => {
    const { app, accountant, jobCard, estimateFor, approve, setLines, doc, advisor } = await world();
    const jc = await jobCard([labour("Inspection"), part("Front brake pads"), part("AC re-gas")]);
    const est = (await estimateFor(jc.id)).body.document;
    await setLines(est.id, [labour("Inspection", 5000), part("Front brake pads", 30000), part("AC re-gas", 20000), labour("Brake fluid flush", 8000)]);
    // The advisor adds work on the job card meanwhile: it stays.
    await setLines(jc.id, [labour("Inspection"), part("Front brake pads"), part("AC re-gas"), labour("Wash")], advisor);
    const res = await approve(est.id, { via: "phone", byName: "Ahmed", note: "Called at 10:40", declined: [2], at: "2026-11-27T06:40:00.000Z" });
    expect(res.status).toBe(200);
    const approved = res.body.document;
    expect(approved).toMatchObject({
      status: "approved", approval: { via: "phone", byName: "Ahmed", note: "Called at 10:40", at: "2026-11-27T06:40:00.000Z", recordedBy: "accountant user" },
    });
    expect(approved.lines.map((l: any) => [l.description, l.declined])).toEqual([["Inspection", false], ["Front brake pads", false], ["AC re-gas", true], ["Brake fluid flush", false]]);
    expect(approved.totals.netFils).toBe(43000);
    expect(app.db.get("SELECT net_fils FROM document_lines WHERE document_id = ? AND position = 2", [est.id])).toEqual({ net_fils: 0 });
    const job = await doc(jc.id);
    expect(job.lines.map((l: any) => [l.description, l.unitPriceFils])).toEqual([["Inspection", 5000], ["Front brake pads", 30000], ["Wash", 0], ["Brake fluid flush", 8000]]);
    expect(job.estimate).toMatchObject({ status: "approved", approval: { via: "phone", byName: "Ahmed" } });
    // Approved: not edited any more, nor approved twice.
    expect((await setLines(est.id, [labour("Inspection", 1)])).status).toBe(409);
    expect((await approve(est.id)).status).toBe(409);
    expect((await approve(est.id, {}, accountant)).body.error).toBe("EST-00001 is already approved");
  });

  it("refuses an approval with no name, a way it wasn't given, or a time in the future", async () => {
    const { jobCard, estimateFor, approve } = await world();
    const est = (await estimateFor((await jobCard([labour("Inspection", 100)])).id)).body.document;
    expect((await approve(est.id, { byName: "" })).status).toBe(400);
    expect((await approve(est.id, { via: "telepathy" })).status).toBe(400);
    expect((await approve(est.id, { at: "2099-01-01T00:00:00.000Z" })).body.error).toBe("The approval can't be later than now");
  });

  it("an older screen setting the status to Approved is recorded as set by hand, and goes back to the job card", async () => {
    const { app, advisor, jobCard, estimateFor, setLines, doc } = await world();
    const jc = await jobCard([labour("Inspection")]);
    const est = (await estimateFor(jc.id)).body.document;
    await setLines(est.id, [labour("Inspection", 7000)]);
    const res = await call(app, "PATCH", `/api/documents/${est.id}`, advisor, { status: "approved" });
    expect(res.body.document).toMatchObject({ status: "approved", approval: { via: "status", recordedBy: "advisor user" } });
    expect((await doc(jc.id)).lines[0].unitPriceFils).toBe(7000);
  });

  it("two lines with the same text are matched in order; a declined bought part keeps its cost on the job", async () => {
    const { app, owner, accountant, jobCard, estimateFor, approve, setLines, doc } = await world();
    const jc = await jobCard([part("Oil filter"), part("Oil filter"), part("Alternator")]);
    const poId = (await call(app, "POST", "/api/purchase-requests", owner, { documentId: jc.id, position: 2, qty: 1 })).body.document.lines[2].purchaseOrderId;
    const order = await orderRequest(app, accountant, poId, FLEETFIX_SUPPLIER_ID, 25000);
    await call(app, "POST", `/api/purchase-orders/${order.id}/receive`, accountant, { vatFils: 0, lines: [{ poLineId: order.lines[0].id, qty: 1, unitCostFils: 25000 }] });
    const est = (await estimateFor(jc.id)).body.document;
    await setLines(est.id, [part("Oil filter", 3500), part("Oil filter", 4000), part("Alternator", 60000)]);
    await approve(est.id, { declined: [2] });
    const job = await doc(jc.id, owner);
    expect(job.lines.map((l: any) => [l.description, l.unitPriceFils])).toEqual([["Oil filter", 3500], ["Oil filter", 4000]]);
    expect(job.uncharged).toMatchObject([{ description: "Alternator", costFils: 25000 }]);
  });
});

describe("re-estimating", () => {
  it("what the client declined stays on that version, not the next", async () => {
    const { jobCard, estimateFor, approve, setLines, app, owner } = await world();
    const jc = await jobCard([labour("Service"), labour("AC re-gas")]);
    const est = (await estimateFor(jc.id)).body.document;
    await setLines(est.id, [labour("Service", 20000), labour("AC re-gas", 15000)]);
    await approve(est.id, { declined: [1] });
    const next = (await call(app, "POST", `/api/documents/${est.id}/revise`, owner, {})).body.document;
    expect(descs(next)).toEqual(["Service"]);
    expect(next.totals.netFils).toBe(20000);
  });

  it("an approved estimate becomes EST-00001-1, keeps the version before, and brings new job card lines", async () => {
    const { app, owner, advisor, jobCard, estimateFor, approve, setLines, doc } = await world();
    const jc = await jobCard([labour("Inspection")]);
    const est = (await estimateFor(jc.id)).body.document;
    await setLines(est.id, [labour("Inspection", 5000)]);
    await approve(est.id);
    await setLines(jc.id, [labour("Inspection", 5000), part("Brake discs")], advisor);
    const again = await estimateFor(jc.id);
    expect(again.status).toBe(200);
    const v1 = again.body.document;
    expect(v1).toMatchObject({ id: est.id, number: "EST-00001-1", revision: 1, status: "draft", approval: null });
    expect(descs(v1)).toEqual(["Inspection", "Brake discs"]);
    expect(v1.versions).toEqual([expect.objectContaining({ revision: 0, number: "EST-00001", approvedVia: "phone" })]);
    const old = await call(app, "GET", `/api/documents/${est.id}/versions/0`, owner);
    expect(old.body.document).toMatchObject({ number: "EST-00001", status: "approved", totals: { netFils: 5000 } });
    await setLines(est.id, [labour("Inspection", 5000), part("Brake discs", 40000)]);
    await approve(est.id, { via: "in_person" });
    expect((await doc(jc.id)).lines.map((l: any) => l.unitPriceFils)).toEqual([5000, 40000]);
    const rev = await call(app, "POST", `/api/documents/${est.id}/revise`, owner, {});
    expect(rev.body.document.number).toBe("EST-00001-2");
    expect((await call(app, "POST", `/api/documents/${est.id}/revise`, owner, {})).body.error).toBe("EST-00001-2 is a draft: change it as it is");
  });

  it("an estimate made first and converted is re-estimated for its job card, never a second job card", async () => {
    const { app, owner, customer, estimateFor, approve, setLines, doc } = await world();
    const first = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: [labour("Service", 20000)] })).body.document;
    const jc = (await call(app, "POST", `/api/documents/${first.id}/convert`, owner, {})).body.document;
    expect((await doc(jc.id)).estimate).toMatchObject({ id: first.id, status: "converted" });
    await setLines(jc.id, [labour("Service", 20000), part("Wiper blades")]);
    const v1 = (await estimateFor(jc.id)).body.document;
    expect(v1).toMatchObject({ id: first.id, number: "EST-00001-1", forJob: { id: jc.id }, status: "draft" });
    expect(descs(v1)).toEqual(["Service", "Wiper blades"]);
    await setLines(first.id, [labour("Service", 20000), part("Wiper blades", 3000)]);
    await approve(first.id);
    expect((await doc(jc.id)).lines.map((l: any) => l.unitPriceFils)).toEqual([20000, 3000]);
    expect((await call(app, "POST", `/api/documents/${first.id}/convert`, owner, {})).status).toBe(409);
    expect(app.db.all("SELECT id FROM documents WHERE type = 'jobcard'")).toHaveLength(1);
  });
});

describe("vendor prices and ordering", () => {
  it("an estimate line shows the vendors' prices and a suggested price to those who see costs; the order says the estimate isn't approved", async () => {
    const { app, owner, advisor, accountant, jobCard, estimateFor } = await world();
    const jc = await jobCard([part("Front brake pads")]);
    const poId = (await call(app, "POST", "/api/purchase-requests", advisor, { documentId: jc.id, position: 0, qty: 1 })).body.document.lines[0].purchaseOrderId;
    const gulf = (await call(app, "POST", "/api/suppliers", owner, { name: "Gulf Parts" })).body.supplier;
    await call(app, "POST", `/api/purchase-orders/${poId}/quotes`, owner, { vendors: [{ supplierId: gulf.id }] });
    const req = (await call(app, "GET", `/api/purchase-orders/${poId}`, owner)).body.purchaseOrder;
    await call(app, "PUT", `/api/purchase-orders/${poId}/quote-prices`, owner, { prices: [{ supplierId: gulf.id, poLineId: req.lines[0].id, unitCostFils: 18000 }] });
    const est = (await estimateFor(jc.id)).body.document;
    expect(est.lines[0].vendorPrices).toEqual([{ name: "Gulf Parts", unitCostFils: 18000 }]);
    const seen = (await call(app, "GET", `/api/documents/${est.id}`, advisor)).body.document;
    expect(seen.lines[0]).not.toHaveProperty("vendorPrices");
    const po = (await call(app, "GET", `/api/purchase-orders/${poId}`, accountant)).body.purchaseOrder;
    expect(po.job).toMatchObject({ estimate: { number: "EST-00001", status: "draft" } });
  });
});
