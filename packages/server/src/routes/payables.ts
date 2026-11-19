import type { FastifyInstance } from "fastify";
import { can, dubaiDate } from "@ffgp/shared";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { badRequest, notFound } from "../errors";
import { payablesAging, supplierBalance, supplierOpenItems, supplierStatement } from "../payables/ledger";
import { supplierOut } from "./parts";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const today = () => dubaiDate(new Date().toISOString());

export interface PayablesRouteOptions { posts: boolean }

/** Suppliers' money: balances, open items, statements, aging (later tasks add bills, payments, expenses, bank). */
export function payablesRoutes(app: FastifyInstance, db: Db, _o: PayablesRouteOptions): void {
  const supplier = (id: string) => {
    const s = db.get<Parameters<typeof supplierOut>[0]>("SELECT * FROM suppliers WHERE id = ?", [id]);
    if (!s) throw notFound("Supplier not found");
    return s;
  };

  app.get<{ Params: { id: string } }>("/api/suppliers/:id", async (req) => {
    const user = sessionUser(db, req);
    const s = supplierOut(supplier(req.params.id));
    // Balances are for those who look after paying suppliers.
    return { supplier: can(user.role, "payables.manage") ? { ...s, ...supplierBalance(db, s.id) } : s };
  });

  app.get<{ Params: { id: string } }>("/api/suppliers/:id/open-items", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    supplier(req.params.id);
    return { items: supplierOpenItems(db, req.params.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/suppliers/:id/statement", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    supplier(req.params.id);
    const to = req.query.to && YMD.test(req.query.to) ? req.query.to : today();
    const from = req.query.from && YMD.test(req.query.from) ? req.query.from : `${to.slice(0, 8)}01`;
    if (from > to) throw badRequest("The start date is after the end date");
    return { from, to, statement: supplierStatement(db, req.params.id, from, to) };
  });

  app.get<{ Querystring: { asOf?: string } }>("/api/reports/payables-aging", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return payablesAging(db, req.query.asOf && YMD.test(req.query.asOf) ? req.query.asOf : today());
  });
}
