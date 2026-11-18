import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { Db } from "../src/db";
import { call, setUp, tempDir } from "./helpers";

const LINE = { kind: "labour", description: "Service", qty: 1, unitPriceFils: 10000, discountPct: 0 };

async function appWith(numbers: Parameters<typeof buildApp>[0]["numbers"], dataDir = tempDir()) {
  const app = await buildApp({ dataDir, numbers });
  return app;
}

describe("number series", () => {
  it("offline series numbers separately and never clashes", async () => {
    let online: { series: string; seq: number } | null = null;
    const app = await appWith({ next: async () => online, offlineSeries: "P1" });
    try {
      const owner = await setUp(app);
      const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
      const inv = async () => (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [LINE] })).body.document;
      const a = await inv();
      const b = await inv();
      expect([a.number, b.number]).toEqual(["INV-P1-00001", "INV-P1-00002"]);
      expect(app.db.get<{ series: string }>("SELECT series FROM documents WHERE id = ?", [a.id])!.series).toBe("P1");
      online = { series: "", seq: 12 };
      expect((await inv()).number).toBe("INV-00012");
      online = { series: "", seq: 1 };
      expect((await inv()).number).toBe("INV-00001");
      online = null;
      expect((await inv()).number).toBe("INV-P1-00003");
      expect(app.db.all("SELECT 1 FROM documents WHERE type = 'invoice'")).toHaveLength(5);

      const supplier = (await call(app, "POST", "/api/suppliers", owner, { name: "Parts Co" })).body.supplier;
      const po = (await call(app, "POST", "/api/purchase-orders", owner, { supplierId: supplier.id, lines: [] })).body.purchaseOrder;
      expect(po.number).toBe("PO-P1-00001");
    } finally {
      await app.close();
    }
  });

  it("without the numbers option, numbering is exactly as before", async () => {
    const app = await appWith(undefined);
    try {
      const owner = await setUp(app);
      const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
      const doc = (await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [LINE] })).body.document;
      expect(doc.number).toBe("INV-00001");
      expect(app.db.get<{ series: string }>("SELECT series FROM documents WHERE id = ?", [doc.id])!.series).toBe("");
    } finally {
      await app.close();
    }
  });

  it("a stale counter never hands out a number that's already used (a PC after leaving the cloud)", async () => {
    const app = await appWith(undefined);
    try {
      const owner = await setUp(app);
      const customer = (await call(app, "POST", "/api/customers", owner, { name: "Ahmed" })).body.customer;
      const inv = async () => await call(app, "POST", "/api/documents", owner, { type: "invoice", customerId: customer.id, lines: [LINE] });
      expect((await inv()).body.document.number).toBe("INV-00001");
      // Numbers 2 and 3 arrived from the cloud while this PC's counter stood still.
      const t = new Date().toISOString();
      for (const n of [2, 3]) {
        app.db.run("INSERT INTO documents (id, type, series, seq, number, status, customer_id, created_at, updated_at) VALUES (?, 'invoice', '', ?, ?, 'draft', ?, ?, ?)", [`synced-${n}`, n, `INV-0000${n}`, customer.id, t, t]);
      }
      const next = await inv();
      expect(next.status).toBe(200);
      expect(next.body.document.number).toBe("INV-00004");
    } finally {
      await app.close();
    }
  });

  it("existing databases migrate", async () => {
    const dir = tempDir();
    const file = join(dir, "garage.db");
    const old = new Db(file, { migrateTo: 4 });
    const t = new Date().toISOString();
    old.run("INSERT INTO users (id, name, username, role, password_hash, created_at, updated_at) VALUES ('u1','O','o','owner','x',?,?)", [t, t]);
    old.run("INSERT INTO customers (id, kind, name, created_at, updated_at) VALUES ('c1','individual','A',?,?)", [t, t]);
    old.run("INSERT INTO documents (id, type, seq, number, status, customer_id, created_at, updated_at) VALUES ('d1','jobcard',1,'JC-00001','converted','c1',?,?)", [t, t]);
    old.run("INSERT INTO documents (id, type, seq, number, status, customer_id, source_id, gross_fils, created_at, updated_at) VALUES ('d2','invoice',1,'INV-00001','issued','c1','d1',500,?,?)", [t, t]);
    old.run("INSERT INTO document_lines (id, document_id, position, kind, description, qty, unit_price_fils, net_fils, vat_fils, gross_fils) VALUES ('l1','d2',0,'labour','x',1,476,476,24,500)");
    old.run("INSERT INTO payments (id, document_id, amount_fils, method, paid_at, created_at) VALUES ('p1','d2',500,'cash',?,?)", [t, t]);
    old.run(`INSERT INTO purchase_orders (id, seq, number, supplier_id, status, created_at, updated_at, version) VALUES ('po1',1,'PO-00001','00000000-0000-4000-8000-0000000f1ee7','draft',?,?,3)`, [t, t]);
    old.run("INSERT INTO po_lines (id, po_id, position, description, qty, created_at, updated_at) VALUES ('pl1','po1',0,'Filter',1,?,?)", [t, t]);
    old.close();

    const db = new Db(file);
    try {
      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
      expect(db.all<{ id: string; series: string }>("SELECT id, series FROM documents ORDER BY id")).toEqual([{ id: "d1", series: "" }, { id: "d2", series: "" }]);
      expect(db.get("SELECT COUNT(*) AS n FROM document_lines")).toEqual({ n: 1 });
      expect(db.get("SELECT version, series FROM purchase_orders WHERE id = 'po1'")).toEqual({ version: 3, series: "" });
      // Conversion uniqueness and the new numbering key still hold.
      expect(() => db.run("INSERT INTO documents (id, type, seq, number, status, customer_id, source_id, created_at, updated_at) VALUES ('d3','invoice',2,'INV-00002','draft','c1','d1',?,?)", [t, t])).toThrow();
      expect(() => db.run("INSERT INTO documents (id, type, seq, number, status, customer_id, created_at, updated_at) VALUES ('d4','invoice',1,'INV-00001','draft','c1',?,?)", [t, t])).toThrow();
      db.run("INSERT INTO documents (id, type, series, seq, number, status, customer_id, created_at, updated_at) VALUES ('d5','invoice','P1',1,'INV-P1-00001','draft','c1',?,?)", [t, t]);
      // Foreign keys still point at the rebuilt tables.
      expect(() => db.run("INSERT INTO payments (id, document_id, amount_fils, method, paid_at, created_at) VALUES ('p2','nope',5,'cash',?,?)", [t, t])).toThrow();
      db.run("DELETE FROM documents WHERE id = 'd5'");
    } finally {
      db.close();
    }
  });
});
