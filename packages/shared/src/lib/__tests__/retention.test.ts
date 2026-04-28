import { describe, it, expect } from "vitest";
import { computeClipExpiresAt } from "../retention";

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

  it("returns 24h for NONE plan (defensive — orphaned clips)", () => {
    const expires = computeClipExpiresAt("NONE", null, now);
    const hours = (expires.getTime() - now.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(24);
  });

  it("propagates the underlying error for invalid plan/cycle combos", () => {
    // PLUS has no WEEKLY cycle in PLAN_LIMITS — getPlanLimits throws and
    // computeClipExpiresAt should not silently swallow it. Caller is
    // responsible for not constructing invalid combinations.
    expect(() => computeClipExpiresAt("PLUS", "WEEKLY", now)).toThrow(/no weekly/i);
  });
});
