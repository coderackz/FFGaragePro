import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db";
import { tempDir } from "./helpers";

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
