import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { buildApp } from "../src/app";

const dirs: string[] = [];
const apps: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffgp-test-"));
  dirs.push(dir);
  return dir;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function makeApp(dataDir = tempDir(), options: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const app = await buildApp({ ...options, dataDir });
  apps.push(app);
  return app;
}

export async function call(app: App, method: string, url: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as object | undefined,
  });
  return { status: res.statusCode, body: res.json() as any };
}

export const SETUP = {
  garage: { name: "Al Quoz Auto Care", trn: "100123456700003", address: "Al Quoz 3, Dubai", phone: "+971 4 000 0000" },
  owner: { name: "Owner One", username: "owner", password: "owner-pass-1" },
};

/** Sets the garage up and returns the owner's token. */
export async function setUp(app: App): Promise<string> {
  const res = await call(app, "POST", "/api/setup", undefined, SETUP);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.token;
}

export async function addUser(app: App, ownerToken: string, role: "owner" | "accountant" | "advisor", username = role) {
  await call(app, "POST", "/api/users", ownerToken, { name: `${role} user`, username, role, password: `${role}-pass-1` });
  const login = await call(app, "POST", "/api/auth/login", undefined, { username, password: `${role}-pass-1` });
  return login.body.token as string;
}

/** Creates a part (stocked by default) and, if `opening` is given, posts opening stock at that cost. */
export async function createPart(
  app: App, token: string, fields: Record<string, unknown> = {}, opening?: { qty: number; unitCostFils: number },
) {
  const res = await call(app, "POST", "/api/parts", token, { partNo: "OF-1001", name: "Oil filter", stocked: true, sellPriceFils: 3500, ...fields });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  const part = res.body.part;
  if (opening) await call(app, "POST", `/api/parts/${part.id}/adjustments`, token, { reason: "opening", ...opening });
  return part as { id: string; partNo: string; name: string };
}

export async function onHand(app: App, token: string, partId: string): Promise<number> {
  return (await call(app, "GET", `/api/parts/${partId}`, token)).body.part.onHand;
}

/** Receives one part from a supplier on a goods receipt (the supplier's bill for parts). */
export async function receiveFrom(app: App, token: string, supplierId: string, net: number, vat: number, supplierInvoiceDate: string) {
  const part = await createPart(app, token, { partNo: `P-${Math.random().toString(36).slice(2, 8)}` });
  const po = (await call(app, "POST", "/api/purchase-orders", token, { supplierId, lines: [{ partId: part.id, description: "Part", qty: 1, unitCostFils: net }] })).body.purchaseOrder;
  await call(app, "PATCH", `/api/purchase-orders/${po.id}`, token, { status: "sent" });
  const r = await call(app, "POST", `/api/purchase-orders/${po.id}/receive`, token, {
    supplierInvoiceNo: `INV-${Math.random().toString(36).slice(2, 6)}`, supplierInvoiceDate, vatFils: vat, lines: [{ poLineId: po.lines[0].id, qty: 1, unitCostFils: net }],
  });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.purchaseOrder.receipts.at(-1) as { id: string };
}

/** An employee as the payroll tests create one (paid by bank, with a MOHRE person ID). */
export const EMPLOYEE = {
  name: "Ravi Kumar", job: "Mechanic", nationality: "India", joinDate: "2024-01-01", basicFils: 300000, housingFils: 100000, transportFils: 50000,
  payMethod: "bank", iban: "AE070331234567890123456", routingCode: "803320101", personId: "10012345678901",
};
