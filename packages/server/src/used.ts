import { phoneDigits, type UsedPurchaseInput } from "@ffgp/shared";
import { newId, now, type Db } from "./db";
import { conflict, notFound } from "./errors";

/** Used lines on open job cards whose purchase isn't recorded yet. No costs: every role sees the list. */
export function usedPartsToBuy(db: Db) {
  return db.all<{ documentId: string; documentNumber: string; position: number; description: string; qty: number; customerName: string; plate: string | null }>(
    `SELECT d.id AS documentId, d.number AS documentNumber, l.position, l.description, l.qty, c.name AS customerName, v.plate
     FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN customers c ON c.id = d.customer_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
     WHERE l.condition = 'used' AND l.po_line_id IS NULL AND d.type = 'jobcard' AND d.status <> 'converted'
     ORDER BY d.created_at, d.seq, l.position`,
  );
}

interface Seller { id: string; name: string; phone: string | null; trn: string | null }

/** The saved seller this is: picked, or the one with the same phone (however it's written), or without a phone the same name. */
function savedSeller(db: Db, seller: UsedPurchaseInput["seller"]): Seller | null {
  if ("supplierId" in seller) {
    const s = db.get<Seller>("SELECT id, name, phone, trn FROM suppliers WHERE id = ?", [seller.supplierId]);
    if (!s) throw notFound("Supplier not found");
    return s;
  }
  const all = db.all<Seller>("SELECT id, name, phone, trn FROM suppliers ORDER BY created_at, rowid");
  const digits = phoneDigits(seller.phone ?? "");
  if (digits) return all.find((s) => phoneDigits(s.phone ?? "") === digits) ?? null;
  return all.find((s) => s.name.trim().toLowerCase() === seller.name.toLowerCase()) ?? null;
}

/** The saved seller, refusing one that doesn't exist or whose TRN isn't the bill's. */
export function checkSeller(db: Db, seller: UsedPurchaseInput["seller"], bill: UsedPurchaseInput["bill"]): Seller | null {
  const saved = savedSeller(db, seller);
  const trn = saved?.trn?.replace(/\s+/g, "");
  if (bill && trn && trn !== bill.trn) throw conflict("This seller has another TRN saved");
  return saved;
}

/** The seller's supplier id, saving a new one, and the bill's TRN on a seller without one. Call inside db.tx. */
export function resolveSeller(db: Db, seller: UsedPurchaseInput["seller"], bill: UsedPurchaseInput["bill"]): string {
  const saved = checkSeller(db, seller, bill);
  const t = now();
  if (saved) {
    if (bill && !saved.trn?.trim()) db.run("UPDATE suppliers SET trn = ?, updated_at = ? WHERE id = ?", [bill.trn, t, saved.id]);
    return saved.id;
  }
  if ("supplierId" in seller) throw notFound("Supplier not found");
  const id = newId();
  db.run("INSERT INTO suppliers (id, name, trn, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [id, seller.name, bill?.trn ?? null, seller.phone, t, t]);
  return id;
}
