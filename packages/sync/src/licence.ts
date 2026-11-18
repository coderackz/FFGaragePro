import { createPublicKey, verify } from "node:crypto";

/** What the cloud signs about a garage's licence each time a PC syncs. */
export interface LicencePayload {
  garageId: string;
  garageCode: string;
  state: "trial" | "active" | "grace" | "read_only";
  endsAt: string;
  graceEndsAt: string;
  /** When the cloud said so: a PC that hasn't heard from the cloud for 30 days goes read-only. */
  checkedAt: string;
}

/** The token's payload if the cloud's key signed it, else null (a tampered or foreign token). */
export function verifyLicence(publicKeyPem: string, token: string | null | undefined): LicencePayload | null {
  if (!token) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = verify(null, Buffer.from(body, "base64url"), createPublicKey(publicKeyPem), Buffer.from(sig, "base64url"));
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LicencePayload;
    return typeof payload?.state === "string" && typeof payload.graceEndsAt === "string" && typeof payload.checkedAt === "string" ? payload : null;
  } catch {
    return null;
  }
}
