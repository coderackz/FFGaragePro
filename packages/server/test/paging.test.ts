import { describe, expect, it } from "vitest";
import { FLEETFIX_SUPPLIER_ID } from "@ffgp/shared";
import { call, createPart, makeApp, setUp } from "./helpers";

/** Long lists come 300 at a time (more on asking), and say when there are more. */
describe("long lists", () => {
  it("parts, purchase orders, customers and vehicles take a limit and say when there are more", async () => {
    const app = await makeApp();
    const owner = await setUp(app);
    for (const n of [1, 2, 3]) {
      await createPart(app, owner, { partNo: `P-${n}`, name: `Part ${n}` });
      const c = (await call(app, "POST", "/api/customers", owner, { name: `Customer ${n}`, phone: `050${n}` })).body.customer;
      await call(app, "POST", "/api/vehicles", owner, { customerId: c.id, plate: `DXB A ${n}` });
      await call(app, "POST", "/api/purchase-orders", owner, { supplierId: FLEETFIX_SUPPLIER_ID, lines: [] });
    }
    const lists = [["/api/parts", "parts"], ["/api/purchase-orders", "purchaseOrders"], ["/api/customers", "customers"], ["/api/vehicles", "vehicles"]] as const;
    for (const [url, key] of lists) {
      const two = (await call(app, "GET", `${url}?limit=2`, owner)).body;
      expect(two[key], url).toHaveLength(2);
      expect(two.more, url).toBe(true);
      const all = (await call(app, "GET", `${url}?limit=3`, owner)).body;
      expect(all[key], url).toHaveLength(3);
      expect(all.more, url).toBe(false);
      // No limit: the first 300.
      expect((await call(app, "GET", url, owner)).body, url).toMatchObject({ more: false });
      // Nonsense is the default; nothing above 10,000.
      expect((await call(app, "GET", `${url}?limit=abc`, owner)).body[key], url).toHaveLength(3);
    }
  });
});
