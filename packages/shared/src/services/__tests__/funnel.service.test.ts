import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Two properties matter and are both tested here:
 *  - it counts PEOPLE, not presses (one row per surface+subject+event), so
 *    count(*) is the answer and the table stays the size of the audience;
 *  - it never throws. Telemetry that can break a stranger's first interaction
 *    with the product is worse than no telemetry.
 */

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), create: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    funnelEvent: { upsert: mocks.upsert },
    uploadRefusal: { create: mocks.create },
  },
}));

import {
  FUNNEL_EVENTS,
  recordFunnelEvent,
  recordUploadRefusal,
  refusalHost,
  uploadRejectedEvent,
} from "../funnel.service";

describe("recordFunnelEvent", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({});
    vi.restoreAllMocks();
  });

  it("keys the row on surface + subject + event", async () => {
    await recordFunnelEvent("bot", "42", FUNNEL_EVENTS.FIRST_SCREEN, "ru");

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const arg = mocks.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      surface_subjectId_event: {
        surface: "bot",
        subjectId: "42",
        event: "start_first_screen",
      },
    });
    expect(arg.create).toMatchObject({
      surface: "bot",
      subjectId: "42",
      event: "start_first_screen",
      locale: "ru",
    });
  });

  it("separates the same id on different surfaces", async () => {
    await recordFunnelEvent("web", "42", FUNNEL_EVENTS.APP_OPENED);
    expect(mocks.upsert.mock.calls[0][0].create.surface).toBe("web");
  });

  it("counts a repeat on the existing row instead of adding another", async () => {
    await recordFunnelEvent("bot", "42", FUNNEL_EVENTS.VIDEO_SUBMITTED);
    const arg = mocks.upsert.mock.calls[0][0];
    expect(arg.update.occurrences).toEqual({ increment: 1 });
    expect(arg.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it("accepts a missing locale", async () => {
    await recordFunnelEvent("bot", "42", FUNNEL_EVENTS.FIRST_SCREEN);
    expect(mocks.upsert.mock.calls[0][0].create.locale).toBeNull();
  });

  it("keeps the existing step names stable and adds the shared ones", () => {
    expect(FUNNEL_EVENTS.FIRST_SCREEN).toBe("start_first_screen");
    // Deliberately still the old literal. The button that used to emit it lived
    // on the removed two-button first screen; /link and the Settings entry emit
    // it now. Renaming it would split one question's history across two names.
    expect(FUNNEL_EVENTS.LINK_ACCOUNT).toBe("first_screen_link_account");
    expect(FUNNEL_EVENTS.EARN_ADVERTISERS).toBe("earn_advertisers_tapped");
    expect(FUNNEL_EVENTS.APP_OPENED).toBe("app_opened");
    expect(FUNNEL_EVENTS.VIDEO_SUBMITTED).toBe("video_submitted");
  });

  it("maps every canSubmitJob code to a rejection event", () => {
    expect(uploadRejectedEvent("FREE_NOT_ANCHORED")).toBe("upload_rejected_free_not_anchored");
    expect(uploadRejectedEvent("FREE_EXHAUSTED")).toBe("upload_rejected_free_exhausted");
    expect(uploadRejectedEvent("FREE_SOURCE_TOO_LONG")).toBe("upload_rejected_free_too_long");
    expect(uploadRejectedEvent("FREE_BUDGET_CLOSED")).toBe("upload_rejected_free_budget_closed");
    expect(uploadRejectedEvent("QUOTA")).toBe("upload_rejected_quota");
    expect(uploadRejectedEvent("LIFECYCLE")).toBe("upload_rejected_lifecycle");
    // Route-level refusals that never reach canSubmitJob
    expect(uploadRejectedEvent("TOO_LONG")).toBe("upload_rejected_too_long");
    expect(uploadRejectedEvent("TOO_SHORT")).toBe("upload_rejected_too_short");
    expect(uploadRejectedEvent("DUPLICATE")).toBe("upload_rejected_duplicate");
    expect(uploadRejectedEvent("DAILY_LIMIT")).toBe("upload_rejected_daily_limit");
    expect(uploadRejectedEvent("CONCURRENT")).toBe("upload_rejected_concurrent");
    expect(uploadRejectedEvent("PROBE_FAILED")).toBe("upload_rejected_probe_failed");
  });

  // The gate stopped emitting FREE_TRIAL_USED / FREE_TRIAL_ATTEMPTS when it
  // moved onto the ledger, but funnel_events already holds rows under their
  // suffixes. Nothing in this module may start producing those strings again
  // under a different meaning - a reader summing "trial_used" must be able to
  // trust that every such row came from the old jobs-counting gate.
  it("no longer emits the retired trial suffixes under any current code", () => {
    const retired = ["upload_rejected_trial_used", "upload_rejected_trial_attempts"];
    const current = (
      [
        "FREE_NOT_ANCHORED",
        "FREE_EXHAUSTED",
        "FREE_SOURCE_TOO_LONG",
        "FREE_BUDGET_CLOSED",
        "QUOTA",
        "LIFECYCLE",
        "TOO_LONG",
        "TOO_SHORT",
        "DUPLICATE",
        "DAILY_LIMIT",
        "CONCURRENT",
        "PROBE_FAILED",
      ] as const
    ).map(uploadRejectedEvent);

    for (const gone of retired) expect(current).not.toContain(gone);
    // and every live code still maps to a distinct event
    expect(new Set(current).size).toBe(current.length);
  });

  it("resolves instead of throwing when the write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockRejectedValue(new Error("db is down"));

    await expect(
      recordFunnelEvent("bot", "42", FUNNEL_EVENTS.FIRST_SCREEN, "ru")
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it("resolves when the client has no such model at all", async () => {
    // Guards the deploy window: the Prisma client is regenerated per container,
    // so funnelEvent may be undefined on an instance not regenerated yet.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    await expect(
      recordFunnelEvent("bot", "42", FUNNEL_EVENTS.FIRST_SCREEN)
    ).resolves.toBeUndefined();
  });
});

describe("recordUploadRefusal", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({});
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({});
    vi.restoreAllMocks();
  });

  // Both halves, and the funnel half is exactly what recordFunnelEvent writes:
  // the people-count on /admin must not change shape because a ledger row is
  // now written beside it.
  it("writes the funnel step AND one ledger row with the detail", async () => {
    await recordUploadRefusal(
      "bot",
      42,
      "PROBE_FAILED",
      { url: "https://youtu.be/x", host: "youtu.be", reason: "yt-dlp-error" },
      "id"
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0][0].where).toEqual({
      surface_subjectId_event: {
        surface: "bot",
        subjectId: "42",
        event: "upload_rejected_probe_failed",
      },
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0]).toEqual({
      data: {
        surface: "bot",
        subjectId: "42",
        code: "PROBE_FAILED",
        detail: {
          url: "https://youtu.be/x",
          host: "youtu.be",
          reason: "yt-dlp-error",
        },
        locale: "id",
      },
    });
  });

  // Callers pass optional fields freely; Prisma's Json input rejects
  // `undefined` values, so they must be gone before the write.
  it("drops undefined detail fields before writing", async () => {
    await recordUploadRefusal("web", "u1", "FREE_EXHAUSTED", {
      durationSec: 600,
      remainingSec: undefined,
      lifetimeSec: 3600,
    });
    expect(mocks.create.mock.calls[0][0].data.detail).toEqual({
      durationSec: 600,
      lifetimeSec: 3600,
    });
  });

  it("writes an explicit JSON null when there is no detail", async () => {
    await recordUploadRefusal("web", "u1", "BUSY");
    const data = mocks.create.mock.calls[0][0].data;
    // Prisma.JsonNull is a sentinel object; the property must be present and
    // must be that sentinel, not undefined (which Prisma would reject) and
    // not a plain empty object (which would store `{}`).
    expect(data.detail).toBe(Prisma.JsonNull);
    expect(data.locale).toBeNull();
  });

  // The two halves are guarded separately: a client that predates the
  // upload_refusals migration must still record the funnel step it always did,
  // and neither failure may reach the caller.
  it("still records the funnel step when the ledger write fails, and never throws", async () => {
    mocks.create.mockRejectedValue(new Error("relation does not exist"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordUploadRefusal("bot", 7, "CONCURRENT", { inFlight: 1, limit: 1 })
    ).resolves.toBeUndefined();

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("resolves when the client has no such model at all", async () => {
    const original = mocks.create.getMockImplementation();
    // Simulate `prisma.uploadRefusal` being undefined: the property access
    // throws synchronously inside the try.
    mocks.create.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'create')");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordUploadRefusal("web", "u1", "QUOTA")
    ).resolves.toBeUndefined();
    if (original) mocks.create.mockImplementation(original);
  });
});

describe("refusalHost", () => {
  it.each([
    ["https://www.youtube.com/watch?v=1", "youtube.com"],
    ["https://YOUTU.BE/abc", "youtu.be"],
    ["https://vt.tiktok.com/ZS/", "vt.tiktok.com"],
  ])("%s -> %s", (url, host) => {
    expect(refusalHost(url)).toBe(host);
  });

  it("returns null for junk and empties", () => {
    expect(refusalHost("not a url")).toBeNull();
    expect(refusalHost("")).toBeNull();
    expect(refusalHost(null)).toBeNull();
    expect(refusalHost(undefined)).toBeNull();
  });
});
