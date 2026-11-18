/** Fleetfix Cloud: licence rules and garage IDs, shared by the cloud server and the screens. */

export const TRIAL_DAYS = 60;
export const GRACE_DAYS = 14;
export const SETUP_CODE_DAYS = 14;
export const GARAGE_HEADER = "x-ffgp-garage";
export const SETUP_CODE_HEADER = "x-ffgp-setup-code";

const GARAGE_CODE = /^[a-z0-9][a-z0-9-]{2,39}$/;

/** "  AlQuoz-Auto " → "alquoz-auto"; null if it isn't a valid garage ID. */
export function normalizeGarageCode(input: string): string | null {
  const code = input.trim().toLowerCase();
  return GARAGE_CODE.test(code) ? code : null;
}

export type GarageStatus = "trial" | "active" | "paused";
export type LicenceStateName = "trial" | "active" | "grace" | "read_only";

export interface LicenceInput {
  status: GarageStatus;
  trialEndsAt: string;
  /** ISO date YYYY-MM-DD; the subscription runs to the end of that day, Dubai time. */
  paidUntil: string | null;
  pausedAt: string | null;
}

const DAY = 86_400_000;

export function licenceState(g: LicenceInput, now: Date): { state: LicenceStateName; endsAt: string; graceEndsAt: string } {
  let end: Date;
  if (g.status === "paused" && g.pausedAt) end = new Date(g.pausedAt);
  else if (g.status === "active" && g.paidUntil) end = new Date(`${g.paidUntil}T23:59:59+04:00`);
  else end = new Date(g.trialEndsAt);
  const graceEnd = new Date(end.getTime() + GRACE_DAYS * DAY);
  const t = now.getTime();
  const state: LicenceStateName = t < end.getTime() ? (g.status === "trial" ? "trial" : "active") : t < graceEnd.getTime() ? "grace" : "read_only";
  return { state, endsAt: end.toISOString(), graceEndsAt: graceEnd.toISOString() };
}
