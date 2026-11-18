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

export interface LicenceView {
  state: LicencePayload["state"];
  endsAt: string | null;
  graceEndsAt: string | null;
  checkedAt: string | null;
  /** Writes are refused: past grace, 30 days without hearing from the cloud, or no valid token. */
  readOnly: boolean;
  /** Why, when readOnly. */
  reason: "expired" | "not_checked" | "invalid" | null;
}

/** A PC must hear from the cloud at least this often. */
export const LICENCE_CHECK_DAYS = 30;
const DAY = 86_400_000;

/** What a PC's stored licence token allows now. A token that doesn't verify counts as read-only. */
export function licenceView(token: string | null | undefined, publicKeyPem: string, now: number): LicenceView {
  const p = verifyLicence(publicKeyPem, token);
  if (!p) return { state: "read_only", endsAt: null, graceEndsAt: null, checkedAt: null, readOnly: true, reason: "invalid" };
  const expired = p.state === "read_only" || now >= Date.parse(p.graceEndsAt);
  const stale = now - Date.parse(p.checkedAt) > LICENCE_CHECK_DAYS * DAY;
  return {
    state: expired ? "read_only" : p.state,
    endsAt: p.endsAt,
    graceEndsAt: p.graceEndsAt,
    checkedAt: p.checkedAt,
    readOnly: expired || stale,
    reason: expired ? "expired" : stale ? "not_checked" : null,
  };
}
