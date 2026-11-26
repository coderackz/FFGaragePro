import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "@ffgp/server";
import { applyAtCloud, installCapture, localChanges } from "../src/index";
import { tempDir } from "./helpers";

const T = "2026-11-01T08:00:00.000Z";
const cols = (db: Db, table: string) => db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name);

describe("migration 30: no Arabic is kept", () => {
  it("drops the Arabic columns and settings on a linked PC (sync triggers installed), and changes from before still apply", () => {
    const file = join(tempDir(), "garage.db");
    const old = new Db(file, { migrateTo: 29 });
    installCapture(old, "local");
    old.run("INSERT INTO customers (id, kind, name, name_ar, address_ar, doc_language, message_language, created_at, updated_at) VALUES ('c1', 'individual', 'Ahmed', 'أحمد', 'دبي', 'en_ar', 'ar', ?, ?)", [T, T]);
    old.run("INSERT INTO settings (key, value) VALUES ('garage.nameAr', '\"كراج\"'), ('garage.addressAr', '\"دبي\"'), ('documents.termsAr', '\"شروط\"'), ('documents.warrantyAr', '\"ضمان\"')");
    old.run(`INSERT INTO settings (key, value) VALUES ('messages.vehicle_received', '{"on":true,"subjectEn":"Hi","subjectAr":"مرحبا","textEn":"Hello","textAr":"أهلا"}')`);
    const pending = localChanges(old, 0).filter((e) => e.table === "customers");
    expect(pending[0]!.data).toHaveProperty("name_ar", "أحمد");
    old.close();

    const db = new Db(file);
    expect(cols(db, "customers")).not.toEqual(expect.arrayContaining(["name_ar"]));
    for (const [table, gone] of [
      ["customers", ["name_ar", "address_ar", "doc_language", "message_language"]], ["parts", ["name_ar"]], ["documents", ["language"]],
      ["customer_contacts", ["language"]], ["employees", ["name_ar", "language"]], ["message_templates", ["subject_ar", "text_ar"]],
    ] as const) for (const c of gone) expect(cols(db, table), `${table}.${c}`).not.toContain(c);
    expect(db.get("SELECT name FROM customers")).toEqual({ name: "Ahmed" });
    expect(db.all("SELECT key FROM settings WHERE key IN ('garage.nameAr', 'garage.addressAr', 'documents.termsAr', 'documents.warrantyAr')")).toEqual([]);
    expect(JSON.parse(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'messages.vehicle_received'")!.value)).toEqual({ on: true, subjectEn: "Hi", textEn: "Hello" });
    installCapture(db, "local");
    db.run("UPDATE customers SET name = 'Ahmed Ali' WHERE id = 'c1'");
    expect(db.get("SELECT name FROM customers")).toEqual({ name: "Ahmed Ali" });

    // A change captured before the update (with the Arabic name) arriving at an updated cloud: applied without it.
    const cloud = new Db(join(tempDir(), "cloud.db"));
    installCapture(cloud, "cloud");
    const result = applyAtCloud(cloud, "P1", pending);
    expect(result.issues).toEqual([]);
    expect(cloud.get("SELECT name FROM customers WHERE id = 'c1'")).toEqual({ name: "Ahmed" });
    db.close();
    cloud.close();
  });
});
