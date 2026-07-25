import { describe, it, expect } from "vitest";
import { computeClipExpiresAt } from "../retention";
import { getPlanLimits } from "../../config/plans";

describe("computeClipExpiresAt", () => {
  const now = new Date("2026-04-01T00:00:00Z");

  it("returns 7 days for STARTER monthly", () => {
    const expires = computeClipExpiresAt("STARTER", "MONTHLY", now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(7);
  });

  it("returns 7 days for STARTER weekly (same retention as monthly)", () => {
    const expires = computeClipExpiresAt("STARTER", "WEEKLY", now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(7);
  });

  it("returns 30 days for PLUS monthly", () => {
    const expires = computeClipExpiresAt("PLUS", "MONTHLY", now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(30);
  });

  it("returns 90 days for MAX monthly", () => {
    const expires = computeClipExpiresAt("MAX", "MONTHLY", now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(90);
  });

  it("falls back to MONTHLY when cycle is null", () => {
    const expires = computeClipExpiresAt("PLUS", null, now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(30);
  });

  // NONE clips are real output now - the free run produces them - so they get
  // the NONE plan's retention like every other plan, not a 24h orphan sweep.
  // A free user needs long enough to watch what we made and show someone.
  it("uses the NONE plan's retention for free-run clips", () => {
    const expires = computeClipExpiresAt("NONE", null, now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(getPlanLimits("NONE").retentionDays);
    expect(days).toBeGreaterThan(1);
  });

  it("propagates the underlying error for invalid plan/cycle combos", () => {
    // PLUS has no WEEKLY cycle in PLAN_LIMITS - getPlanLimits throws and
    // computeClipExpiresAt should not silently swallow it. Caller is
    // responsible for not constructing invalid combinations.
    expect(() => computeClipExpiresAt("PLUS", "WEEKLY", now)).toThrow(/no weekly/i);
  });
});
