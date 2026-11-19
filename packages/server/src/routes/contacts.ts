import type { FastifyInstance } from "fastify";
import { contactSchema, type Contact, type ContactInput, type MessageLanguage } from "@ffgp/shared";
import { requireAction, sessionUser } from "../auth";
import { newId, now, type Db } from "../db";
import { notFound } from "../errors";

export interface ContactRow {
  id: string; customer_id: string; name: string; phone: string | null; email: string | null; language: string;
  gets_approvals: number; gets_invoices: number; gets_ready: number; gets_statements: number; marketing_consent_at: string | null;
}

export const contactOut = (c: ContactRow): Contact & { customerId: string } => ({
  id: c.id, customerId: c.customer_id, name: c.name, phone: c.phone, email: c.email, language: c.language as MessageLanguage,
  getsApprovals: !!c.gets_approvals, getsInvoices: !!c.gets_invoices, getsReady: !!c.gets_ready, getsStatements: !!c.gets_statements,
  marketingConsentAt: c.marketing_consent_at,
});

/** A customer's contacts, by name. */
export const contactsOf = (db: Db, customerId: string) =>
  db.all<ContactRow>("SELECT * FROM customer_contacts WHERE customer_id = ? ORDER BY name COLLATE NOCASE, created_at", [customerId]).map(contactOut);

const flags = (i: ContactInput) => [i.getsApprovals ? 1 : 0, i.getsInvoices ? 1 : 0, i.getsReady ? 1 : 0, i.getsStatements ? 1 : 0];

export function contactRoutes(app: FastifyInstance, db: Db): void {
  const getContact = (id: string) => db.get<ContactRow>("SELECT * FROM customer_contacts WHERE id = ?", [id]);

  app.get<{ Params: { id: string } }>("/api/customers/:id/contacts", async (req) => {
    sessionUser(db, req);
    if (!db.get("SELECT 1 FROM customers WHERE id = ?", [req.params.id])) throw notFound("Customer not found");
    return { contacts: contactsOf(db, req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/customers/:id/contacts", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "customers.edit");
    const input = contactSchema.parse(req.body);
    if (!db.get("SELECT 1 FROM customers WHERE id = ?", [req.params.id])) throw notFound("Customer not found");
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO customer_contacts (id, customer_id, name, phone, email, language, gets_approvals, gets_invoices, gets_ready, gets_statements,
         marketing_consent_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, input.name, input.phone, input.email, input.language, ...flags(input), input.marketingConsent ? t : null, t, t],
    );
    return { contact: contactOut(getContact(id)!) };
  });

  app.patch<{ Params: { id: string } }>("/api/contacts/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "customers.edit");
    const existing = getContact(req.params.id);
    if (!existing) throw notFound("Contact not found");
    const before = contactOut(existing);
    const input = contactSchema.parse({ ...before, marketingConsent: !!before.marketingConsentAt, ...(req.body as object) });
    const t = now();
    // Consent keeps the date it was first given; unticking clears it.
    const consentAt = input.marketingConsent ? (existing.marketing_consent_at ?? t) : null;
    db.run(
      `UPDATE customer_contacts SET name = ?, phone = ?, email = ?, language = ?, gets_approvals = ?, gets_invoices = ?, gets_ready = ?,
         gets_statements = ?, marketing_consent_at = ?, updated_at = ? WHERE id = ?`,
      [input.name, input.phone, input.email, input.language, ...flags(input), consentAt, t, existing.id],
    );
    return { contact: contactOut(getContact(existing.id)!) };
  });

  app.delete<{ Params: { id: string } }>("/api/contacts/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "customers.edit");
    if (!getContact(req.params.id)) throw notFound("Contact not found");
    db.run("DELETE FROM customer_contacts WHERE id = ?", [req.params.id]);
    return { ok: true };
  });
}
