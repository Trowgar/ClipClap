import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const gate = vi.hoisted(() => vi.fn().mockResolvedValue({
  allowed: false, code: "FREE_EXHAUSTED", reason: "test stop",
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "qa" } }) }));
vi.mock("@clipclap/shared", () => ({
  jobService: { findDuplicateJob: async () => null },
  prisma: {
    user: { findUniqueOrThrow: async () => ({ plan: "NONE", subscriptionStatus: "NONE" }) },
    job: { count: async () => 0 },
  },
  getPlanLimits: () => ({ maxSourceDurationMinutes: 40 }),
  canSubmitJob: gate,
  recordFunnelEvent: async () => {},
  recordUploadRefusal: async () => {},
  refusalHost: () => null,
  isBelowSourceFloor: () => false,
  SOURCE_FLOOR: {},
  urlSourceFingerprint: () => "url:qa",
  estimatedFreeCostUsd: () => 0,
  probeVideoUrl: async () => ({ ok: true, durationSec: 1742 }),
  FUNNEL_EVENTS: { VIDEO_SUBMITTED: "video_submitted" },
}));
import { POST } from "../../app/api/jobs/route";

it("passes measured seconds to the balance gate without rounding up a minute", async () => {
  await POST(new NextRequest("https://example.test/api/jobs", {
    method: "POST", body: JSON.stringify({ url: "https://example.test/video" }),
  }));
  expect(gate).toHaveBeenCalledWith("qa", 1742 / 60);
});
