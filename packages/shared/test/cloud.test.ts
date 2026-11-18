import { describe, expect, it } from "vitest";
import { GRACE_DAYS, licenceState, normalizeGarageCode, TRIAL_DAYS } from "../src/index";

describe("normalizeGarageCode", () => {
  it("trims and lowercases", () => expect(normalizeGarageCode(" AlQuoz-Auto ")).toBe("alquoz-auto"));
  it("rejects short or badly started codes", () => {
    expect(normalizeGarageCode("ab")).toBeNull();
    expect(normalizeGarageCode("-abc")).toBeNull();
    expect(normalizeGarageCode("al quoz")).toBeNull();
  });
});

describe("licenceState", () => {
  const trial = { status: "trial" as const, trialEndsAt: "2026-03-02T00:00:00.000Z", paidUntil: null, pausedAt: null };
  it("uses 60-day trials and 14-day grace", () => {
    expect(TRIAL_DAYS).toBe(60);
    expect(GRACE_DAYS).toBe(14);
  });
  it("trial → grace → read-only", () => {
    expect(licenceState(trial, new Date("2026-03-01T00:00:00Z")).state).toBe("trial");
    const grace = licenceState(trial, new Date("2026-03-10T00:00:00Z"));
    expect(grace.state).toBe("grace");
    expect(grace.graceEndsAt).toBe("2026-03-16T00:00:00.000Z");
    expect(licenceState(trial, new Date("2026-03-17T00:00:00Z")).state).toBe("read_only");
  });
  it("paid until runs to the end of that day in Dubai", () => {
    const paid = { ...trial, status: "active" as const, paidUntil: "2026-06-30" };
    expect(licenceState(paid, new Date("2026-06-30T19:00:00Z")).state).toBe("active");
    expect(licenceState(paid, new Date("2026-06-30T20:30:00Z")).state).toBe("grace");
  });
  it("a paused garage gets grace from the pause", () => {
    const paused = { ...trial, status: "paused" as const, paidUntil: "2027-01-01", pausedAt: "2026-05-01T00:00:00.000Z" };
    expect(licenceState(paused, new Date("2026-05-10T00:00:00Z")).state).toBe("grace");
    expect(licenceState(paused, new Date("2026-05-16T00:00:00Z")).state).toBe("read_only");
  });
});
