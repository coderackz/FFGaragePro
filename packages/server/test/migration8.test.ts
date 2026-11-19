import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db";
import { tempDir } from "./helpers";

/** A garage at migration 7 with two issued invoices and three payments (invoice 1 fully paid). */
function garageAt7(): string {
  const file = join(tempDir(), "garage.db");
  const db = new Db(file, { migrateTo: 7 });
  const t = "2026-11-01T08:00:00.000Z";
  db.run("INSERT INTO garage (id, name, created_at, updated_at) VALUES (1, 'G', ?, ?)", [t, t]);
  db.run("INSERT INTO users (id, name, username, role, password_hash, created_at, updated_at) VALUES ('u1', 'O', 'o', 'owner', 'x', ?, ?)", [t, t]);
  db.run("INSERT INTO customers (id, kind, name, created_at, updated_at) VALUES ('c1', 'company', 'Fleet LLC', ?, ?)", [t, t]);
  const inv = (id: string, seq: number, gross: number, paid: number, status: string, issuedAt: string) =>
    db.run(
      `INSERT INTO documents (id, type, series, seq, number, status, customer_id, issued_at, net_fils, vat_fils, gross_fils, paid_fils, created_at, updated_at)
       VALUES (?, 'invoice', '', ?, ?, ?, 'c1', ?, ?, ?, ?, ?, ?, ?)`,
      [id, seq, `INV-0000${seq}`, status, issuedAt, gross - gross / 21, gross / 21, gross, paid, t, t],
    );
  inv("d1", 1, 10500, 10500, "paid", "2026-11-02T21:30:00.000Z");
  inv("d2", 2, 21000, 5000, "part_paid", "2026-11-03T08:00:00.000Z");
  const pay = (id: string, doc: string, amount: number, at: string) =>
    db.run("INSERT INTO payments (id, document_id, amount_fils, method, reference, paid_at, created_by, created_at) VALUES (?, ?, ?, 'cash', NULL, ?, 'u1', ?)", [id, doc, amount, at, at]);
  pay("p-late", "d1", 6000, "2026-11-05T10:00:00.000Z");
  pay("p-early", "d1", 4500, "2026-11-04T10:00:00.000Z");
  pay("p-mid", "d2", 5000, "2026-11-04T12:00:00.000Z");
  db.close();
  return file;
}

describe("migration 8", () => {
  it("existing payments become receipts, nothing changes on the invoices", () => {
    const db = new Db(garageAt7());
    const receipts = db.all<{ id: string; number: string; customer_id: string; amount_fils: number }>("SELECT id, number, customer_id, amount_fils FROM receipts ORDER BY received_at");
    // Numbered from the payment's own id, so every PC and the cloud give it the same number whatever payments
    // each had; new receipts start the main series at RCT-00001.
    expect(receipts.map((r) => [r.id, r.number])).toEqual([["p-early", "RCT-PEARLY"], ["p-mid", "RCT-PMID"], ["p-late", "RCT-PLATE"]]);
    expect(receipts.every((r) => r.customer_id === "c1")).toBe(true);
    const allocs = db.all<{ id: string; receipt_id: string; document_id: string; amount_fils: number }>("SELECT * FROM receipt_allocations ORDER BY id");
    expect(allocs.map((a) => a.id)).toEqual(["p-early-a", "p-late-a", "p-mid-a"]);
    const docs = db.all<{ id: string; paid_fils: number; status: string; credited_fils: number; due_date: string }>("SELECT id, paid_fils, status, credited_fils, due_date FROM documents ORDER BY id");
    expect(docs).toEqual([
      { id: "d1", paid_fils: 10500, status: "paid", credited_fils: 0, due_date: "2026-11-03" },
      { id: "d2", paid_fils: 5000, status: "part_paid", credited_fils: 0, due_date: "2026-11-03" },
    ]);
    expect(db.get("SELECT next FROM counters WHERE type = 'receipt'")).toBeUndefined();
    db.close();
  });

  it("two separate migrations give identical rows", () => {
    const file = garageAt7();
    const other = join(tempDir(), "garage.db");
    copyFileSync(file, other);
    const a = new Db(file);
    const b = new Db(other);
    for (const sql of ["SELECT * FROM receipts ORDER BY id", "SELECT * FROM receipt_allocations ORDER BY id", "SELECT * FROM documents ORDER BY id"]) {
      expect(a.all(sql)).toEqual(b.all(sql));
    }
    a.close();
    b.close();
  });

  it("a credit note doesn't count as converting its invoice; a second conversion still does", () => {
    const db = new Db(garageAt7());
    const t = "2026-11-06T08:00:00.000Z";
    const doc = (id: string, type: string, seq: number, source: string) =>
      db.run(`INSERT INTO documents (id, type, series, seq, number, status, customer_id, source_id, created_at, updated_at) VALUES (?, ?, '', ?, ?, 'issued', 'c1', ?, ?, ?)`,
        [id, type, seq, `${type}-${seq}`, source, t, t]);
    doc("cn1", "credit_note", 1, "d1");
    doc("cn2", "credit_note", 2, "d1");
    doc("j1", "jobcard", 1, "d2");
    expect(() => doc("j2", "jobcard", 2, "d2")).toThrow();
    db.close();
  });
});
