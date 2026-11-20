import { afterEach, describe, expect, it, vi } from "vitest";
import { addUser, call, EMPLOYEE, makeApp, setUp } from "./helpers";

afterEach(() => vi.useRealTimers());
const RULES = { gratuityDayRate: "basic_30", gratuityCap: "basic", leaveBasis: "basic", salaryDayRate: "gross_30" };
const PDF = Buffer.from("%PDF-1.4 payslip").toString("base64");

describe("payslips by message", () => {
  it("payslip messages are private", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T08:00:00Z"));
    const app = await makeApp(undefined, { postsBooks: true });
    const owner = await setUp(app);
    await call(app, "PUT", "/api/settings/books", owner, { startDate: "2026-10-01" });
    await call(app, "PUT", "/api/settings/payroll", owner, RULES);
    const e = (await call(app, "POST", "/api/employees", owner, { ...EMPLOYEE, email: "ravi@example.com" })).body.employee;
    const run = (await call(app, "POST", "/api/payroll/runs", owner, { month: "2026-10" })).body.run;
    await call(app, "POST", `/api/payroll/runs/${run.id}/approve`, owner, {});
    const slip = {
      event: "payslip", channel: "email", employeeId: e.id, recipient: "ravi@example.com", subject: "Your payslip for October 2026",
      body: "Dear Ravi, please find attached your payslip.", attachment: { fileName: "Payslip October 2026.pdf", base64: PDF }, dedupeKey: `payslip:${run.id}:${e.id}`,
    };
    const sent = await call(app, "POST", "/api/messages", owner, slip);
    expect(sent.status).toBe(200);
    expect((await call(app, "POST", "/api/messages", owner, slip)).body.message.id).toBe(sent.body.message.id);
    const advisor = await addUser(app, owner, "advisor");
    expect((await call(app, "GET", "/api/messages", advisor)).body.messages.map((m: { event: string }) => m.event)).not.toContain("payslip");
    expect((await call(app, "GET", `/api/messages/${sent.body.message.id}`, advisor)).status).toBe(404);
    expect((await call(app, "POST", "/api/messages", advisor, { ...slip, dedupeKey: "other" })).status).toBe(403);
    const accountant = await addUser(app, owner, "accountant");
    expect((await call(app, "GET", "/api/messages", accountant)).body.messages.map((m: { event: string }) => m.event)).toContain("payslip");
    const forRun = (await call(app, "GET", `/api/payroll/runs/${run.id}/messages`, owner)).body.messages;
    expect(forRun).toEqual([expect.objectContaining({ employeeId: e.id, channel: "email", status: "queued" })]);
    expect((await call(app, "POST", "/api/messages", owner, { ...slip, employeeId: null, dedupeKey: "x" })).status).toBe(400);
  });
});
