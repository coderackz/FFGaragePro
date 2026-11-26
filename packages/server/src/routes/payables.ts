import type { FastifyInstance } from "fastify";
import { can, coreWriteoffSchema, dubaiDate, supplierReturnSchema, warrantyClaimSchema, warrantyResolveSchema } from "@ffgp/shared";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { badRequest, notFound } from "../errors";
import { cancelBill, createBill, getBill, listBills } from "../payables/bills";
import { postPending } from "../books/pending";
import { expenseFromLine, importStatement, matchLine, reconcileView, setMapping, unmatchLine } from "../payables/reconcile";
import { payablesAging, supplierBalance, supplierOpenItems, supplierStatement } from "../payables/ledger";
import { allocatePayment, createPayment, listPayments } from "../payables/payments";
import {
  chequesInHand, chequesIssued, clearCheques, createExpense, createTransfer, depositCheques, expensePhoto, listExpenses, moneyAccounts,
} from "../payables/money";
import { reserveNumber, type NumberSource } from "../numbering";
import { coresOwed, createSupplierReturn, listReturns, returnOut, writeOffCores } from "../payables/returns";
import { claimOut, createClaim, listClaims, resolveClaim } from "../payables/warranty";
import { supplierOut } from "./parts";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const today = () => dubaiDate(new Date().toISOString());

export interface PayablesRouteOptions { posts: boolean; numbers?: NumberSource }

/** Suppliers' money: balances, open items, statements, aging (later tasks add bills, payments, expenses, bank). */
export function payablesRoutes(app: FastifyInstance, db: Db, o: PayablesRouteOptions): void {
  const supplier = (id: string) => {
    const s = db.get<Parameters<typeof supplierOut>[0]>("SELECT * FROM suppliers WHERE id = ?", [id]);
    if (!s) throw notFound("Supplier not found");
    return s;
  };

  app.get<{ Params: { id: string } }>("/api/suppliers/:id", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "purchases.manage");
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

  // ── Bills ──
  app.get<{ Querystring: { supplierId?: string; status?: string } }>("/api/bills", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { bills: listBills(db, req.query) };
  });
  app.get<{ Params: { id: string } }>("/api/bills/:id", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    const bill = getBill(db, req.params.id);
    if (!bill) throw notFound("Bill not found");
    return { bill };
  });
  app.post("/api/bills", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return { bill: createBill(db, req.body, user.id) };
  });
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/bills/:id/cancel", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return { bill: cancelBill(db, req.params.id, req.body?.reason ?? "", user.id) };
  });

  // ── Debit notes: parts and cores returned, cores written off (warranty credits come from claims) ──
  app.get<{ Querystring: { supplierId?: string } }>("/api/supplier-returns", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { supplierReturns: listReturns(db, req.query.supplierId || null) };
  });
  app.get<{ Params: { id: string } }>("/api/supplier-returns/:id", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { supplierReturn: returnOut(db, req.params.id) };
  });
  app.post("/api/supplier-returns", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    const input = supplierReturnSchema.parse(req.body);
    const reserved = await reserveNumber(o.numbers, "supplier_return");
    const id = db.tx(() => createSupplierReturn(db, input, user, o.numbers, reserved));
    return { supplierReturn: returnOut(db, id) };
  });
  app.get<{ Querystring: { supplierId?: string } }>("/api/cores", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { cores: coresOwed(db, req.query.supplierId || null) };
  });
  app.post("/api/cores/write-offs", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    const input = coreWriteoffSchema.parse(req.body);
    db.tx(() => writeOffCores(db, input, user));
    return { cores: coresOwed(db, input.supplierId) };
  });

  // ── Warranty claims ──
  app.get<{ Querystring: { status?: string; supplierId?: string } }>("/api/warranty-claims", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { warrantyClaims: listClaims(db, { status: req.query.status || null, supplierId: req.query.supplierId || null }) };
  });
  app.get<{ Params: { id: string } }>("/api/warranty-claims/:id", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { warrantyClaim: claimOut(db, req.params.id) };
  });
  app.post("/api/warranty-claims", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    const input = warrantyClaimSchema.parse(req.body);
    const reserved = await reserveNumber(o.numbers, "warranty_claim");
    const id = db.tx(() => createClaim(db, input, user, o.numbers, reserved));
    return { warrantyClaim: claimOut(db, id) };
  });
  app.post<{ Params: { id: string } }>("/api/warranty-claims/:id/resolve", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    const input = warrantyResolveSchema.parse(req.body);
    const reserved = input.outcome === "credited" ? await reserveNumber(o.numbers, "supplier_return") : null;
    db.tx(() => resolveClaim(db, req.params.id, input, user, o.numbers, reserved));
    return { warrantyClaim: claimOut(db, req.params.id) };
  });

  // ── Paying suppliers ──
  app.get<{ Querystring: { supplierId?: string } }>("/api/supplier-payments", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { payments: listPayments(db, req.query.supplierId) };
  });
  app.post("/api/supplier-payments", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return { payment: await createPayment(db, req.body, user.id, o.numbers) };
  });
  app.post<{ Params: { id: string } }>("/api/supplier-payments/:id/allocations", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return { payment: allocatePayment(db, req.params.id, req.body, user.id) };
  });

  // ── Expenses, transfers, cheques, money accounts ──
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/expenses", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { expenses: listExpenses(db, req.query) };
  });
  app.get<{ Params: { id: string } }>("/api/expenses/:id/photo", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { photo: expensePhoto(db, req.params.id) };
  });
  app.post("/api/expenses", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return { expense: await createExpense(db, req.body, user.id, o.numbers) };
  });
  app.post("/api/transfers", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return { transfer: createTransfer(db, req.body, user.id) };
  });
  app.get("/api/cheques/in-hand", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { cheques: chequesInHand(db) };
  });
  app.post("/api/cheques/deposits", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return { deposits: depositCheques(db, req.body, user.id) };
  });
  app.get("/api/cheques/issued", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { cheques: chequesIssued(db) };
  });
  app.post("/api/cheques/clearances", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return { clearances: clearCheques(db, req.body, user.id) };
  });
  app.get("/api/money-accounts", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    if (o.posts) postPending(db);
    return { accounts: moneyAccounts(db) };
  });

  // ── Bank reconciliation ──
  app.put<{ Params: { id: string } }>("/api/money-accounts/:id/mapping", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    return { mapping: setMapping(db, req.params.id, req.body) };
  });
  app.post<{ Params: { id: string } }>("/api/money-accounts/:id/imports", { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return importStatement(db, req.params.id, req.body, user.id);
  });
  app.get<{ Params: { id: string }; Querystring: { to?: string } }>("/api/money-accounts/:id/reconcile", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    if (o.posts) postPending(db);
    return reconcileView(db, req.params.id, req.query.to && YMD.test(req.query.to) ? req.query.to : undefined);
  });
  app.post<{ Params: { id: string }; Body: { journalLineId?: string } }>("/api/bank-lines/:id/match", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    if (!req.body?.journalLineId) throw badRequest("Choose the entry to match");
    matchLine(db, req.params.id, req.body.journalLineId);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/bank-lines/:id/unmatch", async (req) => {
    requireAction(sessionUser(db, req), "payables.manage");
    unmatchLine(db, req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/bank-lines/:id/expense", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payables.manage");
    return expenseFromLine(db, req.params.id, req.body, user.id, o.posts, o.numbers);
  });
}
