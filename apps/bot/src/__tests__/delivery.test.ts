import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPending: vi.fn(),
  markSent: vi.fn(),
  markFailed: vi.fn(),
  markFailureNotified: vi.fn(),
  presign: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    telegramDeliveryService: {
      getPendingTelegramDeliveries: mocks.getPending,
    },
    markTelegramDeliverySent: mocks.markSent,
    markTelegramDeliveryFailed: mocks.markFailed,
    markTelegramDeliveryFailureNotified: mocks.markFailureNotified,
    getPresignedDownloadUrl: mocks.presign,
    prisma: { user: { findUnique: mocks.userFindUnique } },
  };
});

import { deliverReadyTelegramJobs } from "../handlers";
import { t } from "../i18n";

type DeliveryStatus = "PENDING" | "DELIVERED" | "FAILED" | "FAILURE_NOTIFIED";

interface FakeJob {
  status: "DONE" | "FAILED" | "CUTTING";
  error: string | null;
  noClipsReason: string | null;
  clips: Array<{
    id: string;
    title: string;
    description: string | null;
    storageKey: string;
    lowQuality: boolean;
  }>;
}

// One in-memory delivery row + its job, driven through the same pickup contract
// the service encodes in its `where`: PENDING rows once the job is DONE/FAILED,
// plus FAILURE_NOTIFIED rows once the job has healed to DONE. DELIVERED and
// FAILED are terminal and are never handed back.
function makeStore(job: FakeJob) {
  const row = {
    id: "delivery1",
    userId: "user1",
    chatId: "555",
    status: "PENDING" as DeliveryStatus,
  };

  mocks.getPending.mockImplementation(async () => {
    const pickable =
      (row.status === "PENDING" &&
        (job.status === "DONE" || job.status === "FAILED")) ||
      (row.status === "FAILURE_NOTIFIED" && job.status === "DONE");
    return pickable ? [{ ...row, job }] : [];
  });
  mocks.markSent.mockImplementation(async () => {
    row.status = "DELIVERED";
  });
  mocks.markFailed.mockImplementation(async () => {
    row.status = "FAILED";
  });
  mocks.markFailureNotified.mockImplementation(async () => {
    row.status = "FAILURE_NOTIFIED";
  });

  return { row, job };
}

function makeClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendVideo: vi.fn().mockResolvedValue(undefined),
  };
}

const clip = (id: string) => ({
  id,
  title: `clip ${id}`,
  description: null,
  storageKey: `clips/${id}.mp4`,
  lowQuality: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ telegramLocale: "en" });
  mocks.presign.mockImplementation(async (key: string) => `https://r2/${key}`);
});

describe("deliverReadyTelegramJobs", () => {
  it("delivers the clips when a job heals after a failed attempt", async () => {
    // Attempt 1 dies on something transient (an R2 5xx in the download stage),
    // and markJobFailed writes FAILED on EVERY attempt - so the poller sees a
    // FAILED job while BullMQ still has retries left. Attempt 2 heals, the job
    // goes DONE and usage.service bills it. The clips MUST reach the chat.
    const store = makeStore({
      status: "FAILED",
      error: "R2 upload failed",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();

    await deliverReadyTelegramJobs(client as never, "https://clipclap.io");

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      "555",
      t("en").processingFailed(null)
    );
    expect(mocks.markFailureNotified).toHaveBeenCalledTimes(1);
    expect(mocks.markFailed).not.toHaveBeenCalled();

    // still failing, still retrying: nothing new may be said
    await deliverReadyTelegramJobs(client as never, "https://clipclap.io");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    // attempt 2 heals the job
    store.job.status = "DONE";
    store.job.error = null;
    store.job.clips = [clip("c1"), clip("c2")];

    await deliverReadyTelegramJobs(client as never, "https://clipclap.io");

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenLastCalledWith("555", t("en").done(2));
    expect(client.sendVideo).toHaveBeenCalledTimes(2);
    expect(mocks.markSent).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("DELIVERED");

    // and it is terminal - no second copy of the clips on the next poll
    await deliverReadyTelegramJobs(client as never, "https://clipclap.io");
    expect(client.sendVideo).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("delivers the honest empty answer when a healed job produced no clips", async () => {
    const store = makeStore({
      status: "FAILED",
      error: "R2 upload failed",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();

    await deliverReadyTelegramJobs(client as never, "https://clipclap.io");
    store.job.status = "DONE";
    store.job.error = null;
    store.job.noClipsReason = "NO_VIABLE_MOMENTS";

    await deliverReadyTelegramJobs(client as never, "https://clipclap.io");

    expect(client.sendMessage).toHaveBeenLastCalledWith(
      "555",
      t("en").doneNoClips("NO_VIABLE_MOMENTS")
    );
    expect(store.row.status).toBe("DELIVERED");
  });

  it("notifies a permanently failed job exactly once, however often it polls", async () => {
    const store = makeStore({
      status: "FAILED",
      error: "[UNSUPPORTED_INPUT] audio-only file",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();

    for (let i = 0; i < 5; i++) {
      await deliverReadyTelegramJobs(client as never, "https://clipclap.io");
    }

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      "555",
      t("en").processingFailed("UNSUPPORTED_INPUT")
    );
    expect(client.sendVideo).not.toHaveBeenCalled();
    expect(mocks.markSent).not.toHaveBeenCalled();
    expect(store.row.status).toBe("FAILURE_NOTIFIED");
  });

  it("does not re-run a delivery that threw mid-send", async () => {
    // A crash inside the send loop stays terminal FAILED: re-picking it would
    // re-send the clips already in the chat, and a permanently broken send
    // (a missing object, a chat the bot was kicked from) would spam every poll.
    const store = makeStore({
      status: "DONE",
      error: null,
      noClipsReason: null,
      clips: [clip("c1")],
    });
    const client = makeClient();
    mocks.presign.mockRejectedValue(new Error("R2 down"));

    await deliverReadyTelegramJobs(client as never, "https://clipclap.io");
    await deliverReadyTelegramJobs(client as never, "https://clipclap.io");

    expect(mocks.markFailed).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("FAILED");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendVideo).not.toHaveBeenCalled();
  });
});
