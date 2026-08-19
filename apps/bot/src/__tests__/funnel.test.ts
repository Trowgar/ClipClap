import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bot's first screen was a hole in the funnel.
 *
 * handleStart showed the two-button screen to a stranger and returned without
 * writing anything, so an account only appeared once someone pressed a button.
 * That is why we know 95 people created an account and 3 ever ran a job, but
 * cannot say how many opened the bot and walked away.
 *
 * These tests drive the real handleUpdate over a faked prisma and assert the
 * two halves of the funnel are recorded - and, more importantly, that the
 * recording is subordinate to the reply: the message goes out first, and a
 * failing write is invisible to the user.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  userCreate: vi.fn(),
  accountFindUnique: vi.fn(),
  accountCreate: vi.fn(),
  linkTokenCreate: vi.fn(),
  funnelUpsert: vi.fn(),
  refusalCreate: vi.fn(),
  jobCount: vi.fn(),
  jobFindMany: vi.fn(),
  freeUsageGroupBy: vi.fn(),
  freeUsageAggregate: vi.fn(),
  probeVideoUrl: vi.fn(),
  createJob: vi.fn(),
  createTelegramDelivery: vi.fn(),
}));

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
      create: mocks.userCreate,
    },
    account: {
      findUnique: mocks.accountFindUnique,
      create: mocks.accountCreate,
    },
    telegramLinkToken: { create: mocks.linkTokenCreate },
    funnelEvent: { upsert: mocks.funnelUpsert },
    uploadRefusal: { create: mocks.refusalCreate },
    job: { count: mocks.jobCount, findMany: mocks.jobFindMany },
    freeUsage: {
      groupBy: mocks.freeUsageGroupBy,
      aggregate: mocks.freeUsageAggregate,
    },
  },
}));

vi.mock("../url-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../url-probe")>();
  return {
    ...actual,
    probeVideoUrl: mocks.probeVideoUrl,
  };
});

// Only overridden by the queue tests below - every other test in this file
// gets refused before it would ever reach createJob or createTelegramDelivery,
// so leaving these unmocked-by-default cannot change what they assert.
vi.mock("../../../../packages/shared/src/services/job.service", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../packages/shared/src/services/job.service")
  >();
  return { ...actual, createJob: mocks.createJob };
});

vi.mock(
  "../../../../packages/shared/src/services/telegram-delivery.service",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../../../packages/shared/src/services/telegram-delivery.service")
    >();
    return { ...actual, createTelegramDelivery: mocks.createTelegramDelivery };
  }
);

import {
  FUNNEL_EVENTS,
  getPlanLimits,
  uploadRejectedEvent,
} from "@clipclap/shared";
import { blockedKeyboard, getSubmissionBlocker, handleUpdate } from "../handlers";
import { t } from "../i18n";

const CONFIG = { appUrl: "https://clipclap.io" };
const FROM = { id: 4242, is_bot: false, first_name: "Ann", language_code: "ru" };
const CHAT = { id: 4242, type: "private" as const };

/** Records the order of every call so "the reply came first" is testable. */
function harness() {
  const order: string[] = [];
  mocks.funnelUpsert.mockImplementation(async () => {
    order.push("telemetry");
    return {};
  });
  const client = {
    sendMessage: vi.fn(async () => {
      order.push("sendMessage");
      return { message_id: 1 };
    }),
    editMessageText: vi.fn(async () => {
      order.push("editMessageText");
      return {};
    }),
    answerCallbackQuery: vi.fn(async () => undefined),
    setChatMenuButton: vi.fn(async () => {
      order.push("setChatMenuButton");
      return {};
    }),
    sendVideo: vi.fn(async () => {
      order.push("sendVideo");
      return {};
    }),
  };
  return { client, order };
}

function startUpdate() {
  return {
    update_id: 1,
    message: { message_id: 1, chat: CHAT, from: FROM, text: "/start" },
  };
}

function eventsRecorded() {
  return mocks.funnelUpsert.mock.calls.map(
    (c) => c[0].where.surface_subjectId_event.event
  );
}

/** The refusal ledger rows written, as {code, detail}. */
function refusalsRecorded() {
  return mocks.refusalCreate.mock.calls.map((c) => ({
    code: c[0].data.code as string,
    detail: c[0].data.detail as Record<string, unknown>,
  }));
}

describe("first-screen telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.funnelUpsert.mockResolvedValue({});
    mocks.userCreate.mockResolvedValue({ id: "u1", telegramId: "4242" });
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.accountCreate.mockResolvedValue({});
    mocks.linkTokenCreate.mockResolvedValue({});
    mocks.userFindUniqueOrThrow.mockResolvedValue({ id: "u1", plan: "NONE" });
    mocks.jobCount.mockResolvedValue(0);
    mocks.jobFindMany.mockResolvedValue([]);
    // freeUsage is deliberately NOT stubbed in this block. These tests assert
    // the exact welcome copy, and a working freeBudgetStatus would append the
    // "free runs are paused" note to it - which is the truth in prod today and
    // a different test's subject.
    mocks.probeVideoUrl.mockReset();
  });

  it("records that a stranger reached the first screen", async () => {
    const { client } = harness();

    await handleUpdate(client as never, startUpdate() as never, CONFIG);

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeFirstScreen,
      expect.anything()
    );
    expect(eventsRecorded()).toEqual([FUNNEL_EVENTS.FIRST_SCREEN]);
    const arg = mocks.funnelUpsert.mock.calls[0][0];
    expect(arg.where.surface_subjectId_event.surface).toBe("bot");
    expect(arg.where.surface_subjectId_event.subjectId).toBe("4242");
    // The locale is worth one column: 34 of 95 users have none set and the
    // wall they hit is written in two languages only.
    expect(arg.create.locale).toBe("ru");
  });

  it("sends the reply BEFORE writing telemetry", async () => {
    const { client, order } = harness();

    await handleUpdate(client as never, startUpdate() as never, CONFIG);

    expect(order).toEqual(["sendMessage", "telemetry"]);
  });

  it("still replies when the telemetry write rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = harness();
    mocks.funnelUpsert.mockRejectedValue(new Error("db is down"));

    await expect(
      handleUpdate(client as never, startUpdate() as never, CONFIG)
    ).resolves.toBeUndefined();

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeFirstScreen,
      expect.anything()
    );
    expect(err).toHaveBeenCalled();
  });

  it("still replies when the telemetry write throws synchronously", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = harness();
    mocks.funnelUpsert.mockImplementation(() => {
      throw new TypeError("no such model");
    });

    await expect(
      handleUpdate(client as never, startUpdate() as never, CONFIG)
    ).resolves.toBeUndefined();

    expect(client.sendMessage).toHaveBeenCalled();
  });

  it("does not record a first screen for someone who already has an account", async () => {
    const { client } = harness();
    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      telegramLocale: "ru",
      supportOpen: false,
      plan: "NONE",
    });

    await handleUpdate(client as never, startUpdate() as never, CONFIG);

    expect(eventsRecorded()).not.toContain(FUNNEL_EVENTS.FIRST_SCREEN);
  });

  // Replaces "records going past the screen, by which door". There are no doors
  // any more: the two-button first screen is gone, so `first_screen_new_account`
  // can never be written again and `first_screen_link_account` moved to the one
  // place a link is now started from - handleLink, behind /link and the Settings
  // button. Asserted through /link because that is the path a real user takes.
  it("records a link attempt started from inside the bot", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      telegramLocale: "ru",
      supportOpen: false,
      plan: "NONE",
    });
    const { client } = harness();

    await handleUpdate(
      client as never,
      {
        update_id: 2,
        message: { message_id: 7, chat: CHAT, from: FROM, text: "/link" },
      } as never,
      CONFIG
    );

    expect(eventsRecorded()).toContain(FUNNEL_EVENTS.LINK_ACCOUNT);
  });

  it("does not let a telemetry failure break a button press", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = harness();
    mocks.funnelUpsert.mockRejectedValue(new Error("db is down"));

    await expect(
      handleUpdate(
        client as never,
        {
          update_id: 3,
          message: { message_id: 7, chat: CHAT, from: FROM, text: "/link" },
        } as never,
        CONFIG
      )
    ).resolves.toBeUndefined();

    expect(client.sendMessage).toHaveBeenCalled();
  });
});

describe("app-open and video-submitted telemetry", () => {
  const EXISTING_USER = {
    id: "u1",
    telegramId: "4242",
    telegramLocale: "ru",
    supportOpen: false,
    plan: "NONE",
    billingCycle: null,
    subtitlesEnabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    mocks.userFindUnique.mockResolvedValue(EXISTING_USER);
    mocks.funnelUpsert.mockResolvedValue({});
    mocks.userCreate.mockResolvedValue(EXISTING_USER);
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.accountCreate.mockResolvedValue({});
    mocks.linkTokenCreate.mockResolvedValue({});
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
    });
    mocks.jobCount.mockResolvedValue(0);
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.freeUsageGroupBy.mockResolvedValue([]);
    mocks.freeUsageAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: 0 },
    });
    mocks.probeVideoUrl.mockReset();
  });

  function menuUpdate() {
    return {
      update_id: 10,
      message: { message_id: 10, chat: CHAT, from: FROM, text: "/menu" },
    };
  }

  function videoUrlUpdate(url: string) {
    return {
      update_id: 11,
      message: { message_id: 11, chat: CHAT, from: FROM, text: url },
    };
  }

  it("records app_opened when /menu shows the main menu", async () => {
    const { client } = harness();

    await handleUpdate(client as never, menuUpdate() as never, CONFIG);

    // menuTitle, not welcomeBack: /menu is navigation. Greeting somebody who
    // never left reads as the bot having lost the thread of the conversation.
    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").menuTitle,
      expect.anything()
    );
    const appOpened = eventsRecorded().filter(
      (e) => e === FUNNEL_EVENTS.APP_OPENED
    );
    expect(appOpened).toHaveLength(1);
  });

  // The path a real user tripped over: Settings, then ⬅️ Menu, and the bot said
  // "Welcome back! Send a video and I'll generate clips." to somebody who had
  // never left - and told them to send a video while the keyboard's own first
  // full-width button says exactly that.
  it("returns to the menu from settings without greeting the user again", async () => {
    const { client } = harness();

    await handleUpdate(
      client as never,
      {
        update_id: 14,
        message: {
          message_id: 14,
          chat: CHAT,
          from: FROM,
          text: t("ru").settingsBackBtn,
        },
      } as never,
      CONFIG
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").menuTitle,
      expect.anything()
    );
    expect(client.sendMessage).not.toHaveBeenCalledWith(
      CHAT.id,
      t("ru").welcomeBack,
      expect.anything()
    );
  });

  // A stranger's /start now carries the main-menu keyboard, which used to be the
  // one thing that meant "the app was opened". It must NOT count as one: they
  // typed /start and are reading a pitch. Counting it would make app_opened
  // ~= first_screen on the bot and quietly redefine "people using the product"
  // as "people who saw the door". Same distinction the language switch draws.
  it("does not claim an app-open for a stranger who only saw the welcome screen", async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    const { client } = harness();

    await handleUpdate(
      client as never,
      {
        update_id: 12,
        message: { message_id: 7, chat: CHAT, from: FROM, text: "/start" },
      } as never,
      CONFIG
    );

    expect(eventsRecorded()).toEqual([FUNNEL_EVENTS.FIRST_SCREEN]);
    // And no row is created either - lazy creation is what keeps `signed_up`
    // meaning "did something" rather than "pressed START".
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("records app_opened exactly once (not twice) for a returning user's /start", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      telegramId: "4242",
      telegramLocale: "ru",
      supportOpen: false,
      plan: "NONE",
    });
    const { client } = harness();

    await handleUpdate(
      client as never,
      {
        update_id: 13,
        message: { message_id: 8, chat: CHAT, from: FROM, text: "/start" },
      } as never,
      CONFIG
    );

    const appOpened = eventsRecorded().filter(
      (e) => e === FUNNEL_EVENTS.APP_OPENED
    );
    expect(appOpened).toHaveLength(1);
  });

  it("records video_submitted for a URL whose probe fails", async () => {
    mocks.probeVideoUrl.mockResolvedValue({ ok: false, reason: "yt-dlp-error" });
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=dead-link") as never,
      CONFIG
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").urlAccessFailed
    );
    expect(eventsRecorded()).toContain(FUNNEL_EVENTS.VIDEO_SUBMITTED);
  });

  it("records upload_rejected_too_long for a free-tier user whose source is too long", async () => {
    // Derived from the config, never a literal. This used to send 600 seconds,
    // which was "too long" only because every NONE limit was 0; the moment the
    // free numbers came back on 2026-07-29 a ten-minute video was perfectly
    // legal and the test was asserting a rejection that no longer happened.
    const overCap =
      (getPlanLimits("NONE").maxSourceDurationMinutes + 1) * 60;
    mocks.probeVideoUrl.mockResolvedValue({
      ok: true,
      durationSec: overCap,
      title: "A video over the free cap",
    });
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=long-video") as never,
      CONFIG
    );

    expect(eventsRecorded()).toContain(
      uploadRejectedEvent("FREE_SOURCE_TOO_LONG")
    );
    expect(refusalsRecorded()).toEqual([
      {
        code: "FREE_SOURCE_TOO_LONG",
        detail: {
          durationSec: overCap,
          maxMinutes: getPlanLimits("NONE").maxSourceDurationMinutes,
        },
      },
    ]);
  });
});

/**
 * The refusals the bot used to swallow.
 *
 * On 2026-07-29 an organic user submitted four links in ten seconds and the
 * funnel recorded four `video_submitted` rows and NOTHING else. The reason was
 * not the free-tier gate at all: every one of those links failed the yt-dlp
 * probe, and handleVideoUrl returned at `!probe.ok` - before the account was
 * even created and long before getSubmissionBlocker could record anything. The
 * `PROBE_FAILED` code existed in the shared enum and only the web route ever
 * emitted it.
 *
 * The two limit branches below were the second half of the same hole: they
 * return a dictionary string with no recordRejection beside them, so a bot user
 * who hits the daily or concurrent cap is invisible where a web user is not.
 */
describe("refusals the bot used to swallow", () => {
  const EXISTING_USER = {
    id: "u1",
    telegramId: "4242",
    telegramLocale: "ru",
    supportOpen: false,
    plan: "NONE",
    billingCycle: null,
    subtitlesEnabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    // The owner's switch, opened on this test process only. Without it every
    // free submission is refused with FREE_BUDGET_CLOSED and the two limit
    // branches under test are unreachable.
    process.env.FREE_TIER_MONTHLY_BUDGET_USD = "50";
    mocks.userFindUnique.mockResolvedValue(EXISTING_USER);
    mocks.funnelUpsert.mockResolvedValue({});
    mocks.userCreate.mockResolvedValue(EXISTING_USER);
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.accountCreate.mockResolvedValue({});
    // subscriptionStatus NONE as well as plan NONE: canSubmitJob routes into
    // checkFreeTrial only when BOTH say the account never had a plan.
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      id: "u1",
      telegramId: "4242",
      plan: "NONE",
      subscriptionStatus: "NONE",
      billingCycle: null,
    });
    mocks.freeUsageGroupBy.mockResolvedValue([]);
    mocks.freeUsageAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: 0 },
    });
    mocks.jobCount.mockResolvedValue(0);
    mocks.jobFindMany.mockResolvedValue([]);
    mocks.probeVideoUrl.mockReset();
  });

  afterEach(() => {
    delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
  });

  function videoUrlUpdate(url: string) {
    return {
      update_id: 21,
      message: { message_id: 21, chat: CHAT, from: FROM, text: url },
    };
  }

  it("records upload_rejected_probe_failed for a link it cannot read", async () => {
    mocks.probeVideoUrl.mockResolvedValue({
      ok: false,
      reason: "yt-dlp-error",
      error: "ERROR: [generic] dead-link: Unsupported URL",
      rotation: { rotated: false, reason: "pinned", previousIp: "1.1.1.1", ip: "1.1.1.1" },
    });
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=dead-link") as never,
      CONFIG
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").urlAccessFailed
    );
    expect(eventsRecorded()).toContain(uploadRejectedEvent("PROBE_FAILED"));
    // The ledger row is the part that was missing for four weeks: WHAT was
    // sent and WHY it failed, not just that it did.
    expect(refusalsRecorded()).toEqual([
      {
        code: "PROBE_FAILED",
        detail: {
          source: "url",
          url: "https://example.com/watch?v=dead-link",
          host: "example.com",
          reason: "yt-dlp-error",
          error: "ERROR: [generic] dead-link: Unsupported URL",
          rotation: { rotated: false, reason: "pinned", previousIp: "1.1.1.1", ip: "1.1.1.1" },
        },
      },
    ]);
  });

  it("does not blame the user when yt-dlp is missing from the container", async () => {
    mocks.probeVideoUrl.mockResolvedValue({
      ok: false,
      reason: "probe-unavailable",
    });
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=fine-link") as never,
      CONFIG
    );

    // Our fault, not theirs: it must not land in the funnel as a refusal the
    // submitter could have avoided.
    expect(eventsRecorded()).not.toContain(uploadRejectedEvent("PROBE_FAILED"));
  });

  // The engine floor. 14 of the first 57 outside jobs were under a minute and
  // gave one clip between them; the refusal now happens at the probe, in
  // words that say what works, and it lands in the ledger with the number.
  it("refuses a source under the floor as TOO_SHORT, before any balance check", async () => {
    mocks.probeVideoUrl.mockResolvedValue({
      ok: true,
      durationSec: 40,
      title: "A TikTok someone forwarded",
    });
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=forty-seconds") as never,
      CONFIG
    );

    // With the Plans button under it - every refusal carries one now.
    expect(client.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("ru").blocked(t("ru").sourceTooShort),
      { replyMarkup: blockedKeyboard(t("ru")) }
    );
    expect(blockedKeyboard(t("ru")).inline_keyboard[0][0]).toEqual({
      text: t("ru").menuPlans,
      callback_data: "plans:open",
    });
    expect(eventsRecorded()).toContain(uploadRejectedEvent("TOO_SHORT"));
    expect(refusalsRecorded()).toEqual([
      { code: "TOO_SHORT", detail: { durationSec: 40, minSec: 60 } },
    ]);
    // Nothing further was consulted: no free-tier ledger read, no job.
    expect(mocks.freeUsageGroupBy).not.toHaveBeenCalled();
    expect(mocks.freeUsageAggregate).not.toHaveBeenCalled();
  });

  // A document without metadata is not a 30-second video: an unknown
  // duration walks past the floor untouched (and past the length cap, as
  // before). Asserted on the blocker directly - the URL path would go on to
  // create a job, which this suite does not mock.
  it("does not judge a source whose duration is unknown", async () => {
    const subject = { telegramId: FROM.id, locale: "ru" };
    await expect(
      getSubmissionBlocker("u1", t("ru"), undefined, subject)
    ).resolves.toBeNull();
    await expect(
      getSubmissionBlocker("u1", t("ru"), 0, subject)
    ).resolves.toBeNull();
    expect(eventsRecorded()).not.toContain(uploadRejectedEvent("TOO_SHORT"));
    expect(refusalsRecorded()).toEqual([]);
  });

  // A resent source. The link is spelled differently each time (youtu.be with
  // a share token vs the watch URL) and must still be recognised as the same
  // job; the ledger names the prior job so the repeat is countable.
  it("refuses a link whose job is still running, without touching the balance", async () => {
    mocks.probeVideoUrl.mockResolvedValue({ ok: true, durationSec: 900, title: "Same talk" });
    mocks.jobFindMany.mockResolvedValue([
      { id: "j-running", status: "TRANSCRIBING", createdAt: new Date(), clips: [] },
    ]);
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://youtu.be/dQw4w9WgXcQ?si=share-token") as never,
      CONFIG
    );

    // Looked up by THIS user and the canonical key, not the raw string.
    expect(mocks.jobFindMany.mock.calls[0][0].where).toEqual({
      userId: "u1",
      sourceFingerprint: "url:https://youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(client.sendMessage).toHaveBeenCalledWith(CHAT.id, t("ru").duplicateActive);
    expect(client.sendVideo).not.toHaveBeenCalled();
    expect(eventsRecorded()).toContain(uploadRejectedEvent("DUPLICATE"));
    expect(refusalsRecorded()).toEqual([
      {
        code: "DUPLICATE",
        detail: {
          source: "url",
          url: "https://youtu.be/dQw4w9WgXcQ?si=share-token",
          durationSec: 900,
          fingerprint: "url:https://youtube.com/watch?v=dQw4w9WgXcQ",
          priorJobId: "j-running",
          priorStatus: "TRANSCRIBING",
        },
      },
    ]);
    // No balance was consulted and no job was created.
    expect(mocks.freeUsageGroupBy).not.toHaveBeenCalled();
  });

  it("hands back a finished job's clips from Telegram's cache instead of re-running", async () => {
    mocks.probeVideoUrl.mockResolvedValue({ ok: true, durationSec: 900, title: "Same talk" });
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "j-done",
        status: "DONE",
        createdAt: new Date(),
        clips: [
          { id: "c1", title: "Clip one", telegramFileId: "file-1", storageKey: "k1" },
          { id: "c2", title: "Clip two", telegramFileId: null, storageKey: "k2" },
          { id: "c3", title: "Clip three", telegramFileId: "file-3", storageKey: "k3" },
        ],
      },
    ]);
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s") as never,
      CONFIG
    );

    // Two of three clips ever reached the chat; those two come back by id.
    expect(client.sendMessage).toHaveBeenCalledWith(CHAT.id, t("ru").duplicateDone(2));
    expect(client.sendVideo).toHaveBeenCalledTimes(2);
    expect(client.sendVideo).toHaveBeenNthCalledWith(1, CHAT.id, "file-1", "Clip one");
    expect(client.sendVideo).toHaveBeenNthCalledWith(2, CHAT.id, "file-3", "Clip three");
    expect(refusalsRecorded()[0]).toMatchObject({
      code: "DUPLICATE",
      detail: { priorJobId: "j-done", priorStatus: "DONE", resent: 2 },
    });
    expect(mocks.freeUsageGroupBy).not.toHaveBeenCalled();
  });

  // The legitimate retry: after a FAILED run the same link goes through the
  // ordinary path (here: on to the blocker, which reads the balance).
  it("lets the same link through after a failed job", async () => {
    mocks.probeVideoUrl.mockResolvedValue({ ok: true, durationSec: 900, title: "Same talk" });
    mocks.jobFindMany.mockResolvedValue([
      { id: "j-failed", status: "FAILED", createdAt: new Date(), clips: [] },
    ]);
    // Refuse at the blocker on the free ledger, so the test does not need the
    // job-creation transaction: what matters is that the duplicate gate let it
    // pass to the ordinary path.
    delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://youtu.be/dQw4w9WgXcQ") as never,
      CONFIG
    );

    expect(eventsRecorded()).not.toContain(uploadRejectedEvent("DUPLICATE"));
    expect(client.sendVideo).not.toHaveBeenCalled();
    expect(eventsRecorded()).toContain(uploadRejectedEvent("FREE_BUDGET_CLOSED"));
  });

  it("records upload_rejected_daily_limit", async () => {
    mocks.probeVideoUrl.mockResolvedValue({
      ok: true,
      durationSec: 120,
      title: "A short video",
    });
    // jobsToday, read first inside getSubmissionBlocker.
    mocks.jobCount.mockResolvedValue(getPlanLimits("NONE").maxJobsPerDay);
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=one-too-many") as never,
      CONFIG
    );

    expect(eventsRecorded()).toContain(uploadRejectedEvent("DAILY_LIMIT"));
    expect(refusalsRecorded()).toEqual([
      {
        code: "DAILY_LIMIT",
        detail: {
          durationSec: 120,
          jobsToday: getPlanLimits("NONE").maxJobsPerDay,
          limit: getPlanLimits("NONE").maxJobsPerDay,
        },
      },
    ]);
  });

  it("records upload_rejected_concurrent", async () => {
    mocks.probeVideoUrl.mockResolvedValue({
      ok: true,
      durationSec: 120,
      title: "A short video",
    });
    // Same mock serves both counts: today's jobs first, then in-flight ones.
    mocks.jobCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(getPlanLimits("NONE").concurrentJobsLimit);
    const { client } = harness();

    await handleUpdate(
      client as never,
      videoUrlUpdate("https://example.com/watch?v=second-at-once") as never,
      CONFIG
    );

    expect(eventsRecorded()).toContain(uploadRejectedEvent("CONCURRENT"));
    expect(refusalsRecorded()).toEqual([
      {
        code: "CONCURRENT",
        detail: {
          durationSec: 120,
          inFlight: getPlanLimits("NONE").concurrentJobsLimit,
          limit: getPlanLimits("NONE").concurrentJobsLimit,
        },
      },
    ]);
  });

  it("accepts a second video into the queue: says the position, keeps the delivery row, counts video_queued", async () => {
    process.env.SUBMISSION_QUEUE = "on";
    try {
      mocks.probeVideoUrl.mockResolvedValue({
        ok: true,
        durationSec: 900,
        title: "A talk",
      });
      mocks.createJob.mockResolvedValue({
        status: "queued",
        job: { id: "jq1", userId: "u1" },
        position: 2,
      });
      mocks.createTelegramDelivery.mockResolvedValue({});
      const { client } = harness();

      await handleUpdate(
        client as never,
        videoUrlUpdate("https://example.com/watch?v=second-in-line") as never,
        CONFIG
      );

      expect(client.sendMessage).toHaveBeenCalledWith(
        CHAT.id,
        t("ru").queuedBehind(2)
      );
      expect(mocks.createTelegramDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "jq1" })
      );
      expect(eventsRecorded()).toContain(FUNNEL_EVENTS.VIDEO_QUEUED);
      expect(refusalsRecorded()).toEqual([]);
    } finally {
      delete process.env.SUBMISSION_QUEUE;
    }
  });

  // I6 from the quality review: with the queue on, the advisory pre-check
  // used to refuse a second video before createJob ever got a chance to queue
  // it instead - making the queue unreachable from the only surface with real
  // traffic. getSubmissionBlocker is called directly here, exactly as "does
  // not judge a source whose duration is unknown" does above, because the
  // point under test is the blocker's own decision, not the reply it produces.
  it("the advisory pre-check steps aside when the queue is on", async () => {
    const subject = { telegramId: FROM.id, locale: "ru" };

    process.env.SUBMISSION_QUEUE = "on";
    try {
      // jobsToday only - the in-flight count must not even be taken while the
      // queue is on, so there is nothing for a second resolved value to serve.
      mocks.jobCount.mockResolvedValueOnce(0);

      await expect(
        getSubmissionBlocker("u1", t("ru"), 900, subject)
      ).resolves.toBeNull();

      expect(mocks.jobCount).toHaveBeenCalledTimes(1);
      expect(eventsRecorded()).not.toContain(uploadRejectedEvent("CONCURRENT"));
      expect(refusalsRecorded()).toEqual([]);
    } finally {
      delete process.env.SUBMISSION_QUEUE;
    }

    // Flag off reproduces the old refusal exactly, and the count it refuses
    // on must define "in-flight" the same way createJob does: enqueuedAt not
    // null, or the two would disagree right at the boundary this exists to
    // guard.
    mocks.jobCount
      .mockResolvedValueOnce(0) // jobsToday
      .mockResolvedValueOnce(1); // inFlight

    await expect(
      getSubmissionBlocker("u1", t("ru"), 900, subject)
    ).resolves.toBe(t("ru").planConcurrentLimit(1, 1));

    expect(eventsRecorded()).toContain(uploadRejectedEvent("CONCURRENT"));
    // Calls so far: [0] flag-on jobsToday, [1] flag-off jobsToday,
    // [2] flag-off inFlight - the one under test here.
    const inFlightCall = mocks.jobCount.mock.calls[2][0];
    expect(inFlightCall.where.enqueuedAt).toEqual({ not: null });
  });
});

/**
 * Who can SEE the analytics entry, which is a separate question from who can
 * read the data behind it. The data is gated by initData at /api/admin/enter;
 * the button is gated here.
 */
describe("admin analytics button visibility", () => {
  const EXISTING_USER = {
    id: "u1",
    telegramId: "4242",
    telegramLocale: "ru",
    supportOpen: false,
    plan: "NONE",
    billingCycle: null,
    subtitlesEnabled: false,
  };

  const GROUP = { id: -100500, type: "supergroup" as const };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPPORT_CHAT_ID;
    process.env.REFERRAL_ADMIN_TELEGRAM_IDS = "4242";
    mocks.userFindUnique.mockResolvedValue(EXISTING_USER);
    mocks.funnelUpsert.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
  });

  function menuIn(chat: { id: number; type: string }) {
    return {
      update_id: 20,
      message: { message_id: 20, chat, from: FROM, text: "/menu" },
    };
  }

  function menuButtonCalls(client: {
    setChatMenuButton: { mock: { calls: unknown[][] } };
  }) {
    return client.setChatMenuButton.mock.calls as [
      number | string,
      { type: string; text?: string; web_app?: { url: string } },
    ][];
  }

  function keyboardText(client: { sendMessage: { mock: { calls: unknown[][] } } }) {
    const opts = client.sendMessage.mock.calls[0][2] as {
      replyMarkup?: { keyboard: { text: string }[][] };
    };
    return (opts.replyMarkup?.keyboard ?? []).flat().map((b) => b.text);
  }

  it("gives an admin in a private chat the Mini App on the menu button", async () => {
    const { client } = harness();

    await handleUpdate(client as never, menuIn(CHAT) as never, CONFIG);

    const calls = menuButtonCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(CHAT.id);
    expect(calls[0][1].type).toBe("web_app");
    expect(calls[0][1].text).toBe("Analytics");
    expect(calls[0][1].web_app?.url).toContain("/admin?v=");
  });

  it("keeps the analytics entry off the reply keyboard", async () => {
    // A reply-keyboard web_app button receives no signed launch data from
    // Telegram, so the Mini App behind it can never authenticate. The entry
    // point belongs on the menu button, and nowhere else.
    const { client } = harness();

    await handleUpdate(client as never, menuIn(CHAT) as never, CONFIG);

    expect(keyboardText(client)).not.toContain("Analytics");
  });

  it("sets nothing in a group even when the sender is the admin", async () => {
    // The menu button belongs to the CHAT, not the sender: setting it in a
    // group would hand every member the entry point. They could not read the
    // data - the page re-checks - but it is not theirs to see either.
    const { client } = harness();

    await handleUpdate(client as never, menuIn(GROUP) as never, CONFIG);

    expect(menuButtonCalls(client)).toHaveLength(0);
  });

  it("sets nothing for a non-admin in their own private chat", async () => {
    process.env.REFERRAL_ADMIN_TELEGRAM_IDS = "999";
    const { client } = harness();

    await handleUpdate(client as never, menuIn(CHAT) as never, CONFIG);

    expect(menuButtonCalls(client)).toHaveLength(0);
  });
});
