import { planLayoutCounts } from "./plan";
import type { CutRecoveryTelemetry } from "./cut-recovery";
import type { CropPlan, SourceProfile } from "./types";

export interface ReframeCheck {
  shotCount: number;
  detectMs: number;
  /** Derived from the counter so the two can never drift apart. */
  layouts?: ReturnType<typeof planLayoutCounts>;
  profile?: SourceProfile;
  fallbackReason?: string;
  /** Present iff cut recovery ran for this highlight (flag on, detection ok). */
  cutRecovery?: CutRecoveryTelemetry;
}

export interface ReframeCheckInput {
  plan: CropPlan | null;
  shotCount: number;
  detectMs: number;
  fallbackReason?: string;
  cutRecovery?: CutRecoveryTelemetry;
}

/** Pure: what the render stage records about one reframe attempt. */
export function buildReframeCheck(input: ReframeCheckInput): ReframeCheck {
  return {
    shotCount: input.shotCount,
    detectMs: input.detectMs,
    ...(input.plan ? { layouts: planLayoutCounts(input.plan) } : {}),
    ...(input.plan?.profile ? { profile: input.plan.profile } : {}),
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
    ...(input.cutRecovery ? { cutRecovery: input.cutRecovery } : {}),
  };
}

/**
 * The plan was built but ffmpeg rejected it. The layout counts describe a
 * picture that was never produced, so they are dropped - but the profile
 * describes the SOURCE and stays, since that is what the encode failure is
 * evidence about.
 */
export function markEncodeFailed(check: ReframeCheck): ReframeCheck {
  const { layouts: _dropped, ...rest } = check;
  return { ...rest, fallbackReason: "encode_failed" };
}
