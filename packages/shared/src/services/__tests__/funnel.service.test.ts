import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two properties matter and are both tested here:
 *  - it counts PEOPLE, not presses (one row per surface+subject+event), so
 *    count(*) is the answer and the table stays the size of the audience;
 *  - it never throws. Telemetry that can break a stranger's first interaction
 *    with the product is worse than no telemetry.
 */

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: { funnelEvent: { upsert: mocks.upsert } },
}));

import {
  FUNNEL_EVENTS,
  recordFunnelEvent,
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
    expect(FUNNEL_EVENTS.NEW_ACCOUNT).toBe("first_screen_new_account");
    expect(FUNNEL_EVENTS.LINK_ACCOUNT).toBe("first_screen_link_account");
    expect(FUNNEL_EVENTS.APP_OPENED).toBe("app_opened");
    expect(FUNNEL_EVENTS.VIDEO_SUBMITTED).toBe("video_submitted");
  });

  it("maps every canSubmitJob code to a rejection event", () => {
    expect(uploadRejectedEvent("FREE_TRIAL_USED")).toBe("upload_rejected_trial_used");
    expect(uploadRejectedEvent("FREE_TRIAL_ATTEMPTS")).toBe("upload_rejected_trial_attempts");
    expect(uploadRejectedEvent("FREE_SOURCE_TOO_LONG")).toBe("upload_rejected_free_too_long");
    expect(uploadRejectedEvent("QUOTA")).toBe("upload_rejected_quota");
    expect(uploadRejectedEvent("LIFECYCLE")).toBe("upload_rejected_lifecycle");
    // Route-level refusals that never reach canSubmitJob
    expect(uploadRejectedEvent("TOO_LONG")).toBe("upload_rejected_too_long");
    expect(uploadRejectedEvent("DAILY_LIMIT")).toBe("upload_rejected_daily_limit");
    expect(uploadRejectedEvent("CONCURRENT")).toBe("upload_rejected_concurrent");
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
