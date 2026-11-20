import type { FastifyInstance } from "fastify";
import { requireAction, sessionUser } from "../auth";
import type { Db } from "../db";
import { addAdvance, addLeave, createEmployee, expiringDocuments, getEmployee, listEmployees, updateEmployee } from "../payroll/employees";
import { approveRun, editLine, getRun, listRuns, openRun, refreshRun } from "../payroll/runs";

export interface PayrollRouteOptions { posts: boolean }

/** Payroll: employees, leave, advances (Owner and Accountant only: advisors never see salaries). */
export function payrollRoutes(app: FastifyInstance, db: Db, _options: PayrollRouteOptions): void {
  const manager = (req: Parameters<typeof sessionUser>[1]) => {
    const user = sessionUser(db, req);
    requireAction(user, "payroll.manage");
    return user;
  };
  app.get<{ Querystring: { includeLeft?: string } }>("/api/employees", async (req) => {
    manager(req);
    return { employees: listEmployees(db, { includeLeft: req.query.includeLeft === "1" }) };
  });
  app.post("/api/employees", async (req) => {
    manager(req);
    return { employee: createEmployee(db, req.body) };
  });
  app.get<{ Params: { id: string } }>("/api/employees/:id", async (req) => {
    manager(req);
    return { employee: getEmployee(db, req.params.id) };
  });
  app.patch<{ Params: { id: string } }>("/api/employees/:id", async (req) => {
    manager(req);
    return { employee: updateEmployee(db, req.params.id, req.body) };
  });
  app.post<{ Params: { id: string } }>("/api/employees/:id/leave", async (req) => {
    const user = manager(req);
    return { leave: addLeave(db, req.params.id, req.body, user.id) };
  });
  app.post<{ Params: { id: string } }>("/api/employees/:id/advances", async (req) => {
    const user = manager(req);
    return { advance: addAdvance(db, req.params.id, req.body, user.id) };
  });
  app.get("/api/payroll/runs", async (req) => {
    manager(req);
    return { runs: listRuns(db) };
  });
  app.post<{ Body: { month?: string } }>("/api/payroll/runs", async (req) => {
    const user = manager(req);
    return { run: openRun(db, req.body?.month, user.id) };
  });
  app.get<{ Params: { id: string } }>("/api/payroll/runs/:id", async (req) => {
    manager(req);
    return { run: getRun(db, req.params.id) };
  });
  app.patch<{ Params: { id: string; employeeId: string } }>("/api/payroll/runs/:id/lines/:employeeId", async (req) => {
    manager(req);
    return { run: editLine(db, req.params.id, req.params.employeeId, req.body) };
  });
  app.post<{ Params: { id: string } }>("/api/payroll/runs/:id/refresh", async (req) => {
    manager(req);
    return { run: refreshRun(db, req.params.id) };
  });
  app.post<{ Params: { id: string } }>("/api/payroll/runs/:id/approve", async (req) => {
    const user = sessionUser(db, req);
    requireAction(user, "payroll.approve");
    return { run: approveRun(db, req.params.id, user.id) };
  });
  app.get("/api/payroll/expiring", async (req) => {
    manager(req);
    return { documents: expiringDocuments(db) };
  });
}
