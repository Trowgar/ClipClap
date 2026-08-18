import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE UPLOADED OBJECT MUST NOT OUTLIVE A SUBMISSION THAT NEVER BECAME A JOB.
 *
 * handleVideo puts the file in R2 before it knows whether a Job row can be
 * created, and the cleanup used to hang off one specific return value -
 * `concurrent_limit`. Every other way out leaked the object. That was not
 * theoretical: holding the account's advisory lock in psql made createJob THROW
 * P2028, and the megabytes stayed in the bucket with nothing able to collect
 * them - the retention sweep works from job rows, and there was no job row.
 *
 * These tests drive the real handleUpdate with a video message and assert the
 * cleanup on all three shapes of failure, not on the one that was noticed.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  userCreate: vi.fn(),
  accountFindUnique: vi.fn(),
  accountCreate: vi.fn(),
  funnelUpsert: vi.fn(),
  jobCount: vi.fn(),
  jobAggregate: vi.fn(),
  freeUsageGroupBy: vi.fn(),
  freeUsageAggregate: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
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
    funnelEvent: { upsert: mocks.funnelUpsert },
    uploadRefusal: { create: vi.fn().mockResolvedValue({}) },
    job: { count: mocks.jobCount, aggregate: mocks.jobAggregate },
    freeUsage: {
      groupBy: mocks.freeUsageGroupBy,
      aggregate: mocks.freeUsageAggregate,
    },
  },
}));

vi.mock("../../../../packages/shared/src/lib/r2", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../packages/shared/src/lib/r2")
  >();
  return { ...actual, uploadFile: mocks.uploadFile, deleteFile: mocks.deleteFile };
});

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

import { uploadRejectedEvent } from "@clipclap/shared";
import { handleUpdate } from "../handlers";
import { t } from "../i18n";

const CONFIG = { appUrl: "https://clipclap.io" };
const FROM = { id: 4242, is_bot: false, first_name: "Ann", language_code: "en" };
const CHAT = { id: 4242, type: "private" as const };

function videoUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      chat: CHAT,
      from: FROM,
      video: {
        file_id: "file-1",
        file_unique_id: "uniq-1",
        duration: 120,
        file_name: "vod.mp4",
        mime_type: "video/mp4",
        file_size: 1024,
      },
    },
  };
}

function client() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 11 })),
    editMessageText: vi.fn(async () => ({})),
    answerCallbackQuery: vi.fn(async () => undefined),
    setChatMenuButton: vi.fn(async () => ({})),
    downloadFile: vi.fn(async () => undefined),
  };
}

function eventsRecorded() {
  return mocks.funnelUpsert.mock.calls.map(
    (c) => c[0].where.surface_subjectId_event.event
  );
}

/** The key handleVideo built and handed to uploadFile. */
function uploadedKey(): string {
  expect(mocks.uploadFile).toHaveBeenCalledOnce();
  return mocks.uploadFile.mock.calls[0][0] as string;
}

describe("handleVideo cleans up the object it uploaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.FREE_TIER_MONTHLY_BUDGET_USD;
    const user = {
      id: "u1",
      telegramId: "4242",
      telegramLocale: "en",
      supportOpen: false,
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      subtitlesEnabled: true,
      currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
      topUpMinutes: 0,
      minutesUsed: 0,
    };
    mocks.userFindUnique.mockResolvedValue(user);
    mocks.userFindUniqueOrThrow.mockResolvedValue(user);
    mocks.accountFindUnique.mockResolvedValue({ userId: "u1" });
    mocks.funnelUpsert.mockResolvedValue({});
    mocks.jobCount.mockResolvedValue(0);
    mocks.jobAggregate.mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    mocks.freeUsageGroupBy.mockResolvedValue([]);
    mocks.freeUsageAggregate.mockResolvedValue({ _sum: { estimatedCostUsd: 0 } });
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.createTelegramDelivery.mockResolvedValue({});
  });

  it("deletes it when createJob THROWS - the case that leaked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createJob.mockRejectedValue(new Error("Transaction already closed"));

    await expect(
      handleUpdate(client() as never, videoUpdate() as never, CONFIG)
    ).rejects.toThrow();

    expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedKey());
  });

  it("deletes it on the busy refusal, a status that did not exist when the cleanup was written", async () => {
    mocks.createJob.mockResolvedValue({ status: "busy" });
    const c = client();

    await handleUpdate(c as never, videoUpdate() as never, CONFIG);

    expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedKey());
    // Said, and counted. An uncaught throw did neither.
    expect(c.sendMessage).toHaveBeenCalledWith(
      CHAT.id,
      t("en").blocked(t("en").submitBusy)
    );
    expect(eventsRecorded()).toContain(uploadRejectedEvent("BUSY"));
  });

  it("still deletes it on the concurrency refusal", async () => {
    mocks.createJob.mockResolvedValue({
      status: "concurrent_limit",
      inFlight: 1,
      limit: 1,
    });

    await handleUpdate(client() as never, videoUpdate() as never, CONFIG);

    expect(mocks.deleteFile).toHaveBeenCalledWith(uploadedKey());
    expect(eventsRecorded()).toContain(uploadRejectedEvent("CONCURRENT"));
  });

  it("keeps the object once a job owns it", async () => {
    mocks.createJob.mockResolvedValue({
      status: "created",
      job: { id: "job1", userId: "u1" },
    });

    await handleUpdate(client() as never, videoUpdate() as never, CONFIG);

    // Deleting here would break the run that is starting - this is the source
    // the download stage is about to fetch.
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("does not turn an R2 failure into the user's problem", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createJob.mockResolvedValue({ status: "busy" });
    mocks.deleteFile.mockRejectedValue(new Error("r2 down"));

    await expect(
      handleUpdate(client() as never, videoUpdate() as never, CONFIG)
    ).resolves.toBeUndefined();

    expect(err).toHaveBeenCalled();
  });
});
