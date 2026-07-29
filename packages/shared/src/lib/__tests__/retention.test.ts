import { describe, it, expect } from "vitest";
import {
  computeClipExpiresAt,
  SOURCE_ARTIFACT_RETENTION_DAYS,
  REDUNDANT_SOURCE_GRACE_HOURS,
  sourceArtifactCutoff,
  redundantSourceCutoff,
} from "../retention";
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

  // NONE clips are whatever the NONE plan says, no special case. Asserted
  // against the config rather than against a literal, so re-tuning the free
  // retention window is a one-place change - it is 3 days as of 2026-07-29.
  it("uses the NONE plan's retention for free-run clips", () => {
    const expires = computeClipExpiresAt("NONE", null, now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(getPlanLimits("NONE").retentionDays);
  });

  it("propagates the underlying error for invalid plan/cycle combos", () => {
    // PLUS has no WEEKLY cycle in PLAN_LIMITS - getPlanLimits throws and
    // computeClipExpiresAt should not silently swallow it. Caller is
    // responsible for not constructing invalid combinations.
    expect(() => computeClipExpiresAt("PLUS", "WEEKLY", now)).toThrow(/no weekly/i);
  });
});

describe("source artifact windows", () => {
  const now = new Date("2026-04-08T00:00:00Z");

  it("keeps the edit window at 7 days for every plan", () => {
    expect(SOURCE_ARTIFACT_RETENTION_DAYS).toBe(7);
    expect(sourceArtifactCutoff(now)).toEqual(new Date("2026-04-01T00:00:00Z"));
  });

  it("gives a terminal job 24 hours before its redundant copies go", () => {
    expect(REDUNDANT_SOURCE_GRACE_HOURS).toBe(24);
    expect(redundantSourceCutoff(now)).toEqual(new Date("2026-04-07T00:00:00Z"));
  });
});
