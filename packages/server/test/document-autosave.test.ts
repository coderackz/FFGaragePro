import { describe, expect, it } from "vitest";
import { call, makeApp, setUp } from "./helpers";

describe("saving a document opened before someone else changed it", () => {
  it("a save based on an old version is refused; no base means no check", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed", phone: "050" })).body.customer;
    const doc = (await call(app, "POST", "/api/documents", owner, { type: "estimate", customerId: customer.id, lines: [] })).body.document;
    await new Promise((r) => setTimeout(r, 5));
    const first = await call(app, "PATCH", `/api/documents/${doc.id}`, owner, { notes: "first", baseUpdatedAt: doc.updatedAt });
    expect(first.status).toBe(200);
    // Another screen still holds the old version.
    const stale = await call(app, "PATCH", `/api/documents/${doc.id}`, owner, { notes: "stale", baseUpdatedAt: doc.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("This document was changed on another computer. Reload it to see the changes.");
    expect((await call(app, "GET", `/api/documents/${doc.id}`, owner)).body.document.notes).toBe("first");
    // An older screen that sends no base still saves.
    expect((await call(app, "PATCH", `/api/documents/${doc.id}`, owner, { notes: "older" })).status).toBe(200);
  });
});
