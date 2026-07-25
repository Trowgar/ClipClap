import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rule that decides WHICH delivery rows the poller may act on lives in
 * packages/shared/src/services/telegram-delivery.service.ts, and the bug this
 * suite exists to catch - a job that heals after a failed attempt is billed and
 * never delivered - is a property of the poller and that rule TOGETHER.
 *
 * So this suite runs the real service and fakes only the prisma client:
 * findMany INTERPRETS whatever `where` the service builds against an in-memory
 * row instead of restating the rule, and the mark* helpers write their real
 * status literals onto that row, which the next findMany then re-reads. A
 * wrong enum literal, a dropped OR branch or a missing `include` therefore
 * turns THIS suite red - which a hand-written copy of the predicate could not
 * do.
 */

const mocks = vi.hoisted(() => ({
  presign: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../../../../packages/shared/src/lib/r2", () => ({
  getPresignedDownloadUrl: mocks.presign,
  getPresignedUploadUrl: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    telegramDelivery: {
      create: vi.fn(),
      findMany: (args: FindManyArgs) => store.findMany(args),
      update: (args: UpdateArgs) => store.update(args),
    },
  },
}));

import { deliverReadyTelegramJobs } from "../handlers";
import { t } from "../i18n";

type DeliveryStatus = "PENDING" | "DELIVERED" | "FAILED" | "FAILURE_NOTIFIED";
type JobStatus = "DONE" | "FAILED" | "CUTTING";

interface FakeClip {
  id: string;
  title: string;
  description: string | null;
  storageKey: string;
  lowQuality: boolean;
  score: number | null;
  startTime: number;
}

interface FakeJob {
  id: string;
  status: JobStatus;
  error: string | null;
  noClipsReason: string | null;
  clips: FakeClip[];
}

interface FakeRow {
  id: string;
  jobId: string;
  userId: string;
  chatId: string;
  status: DeliveryStatus;
  error: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

type Scalar = string | { in: string[] };
interface RowWhere {
  status?: Scalar;
  job?: { status?: Scalar };
  OR?: RowWhere[];
}
interface FindManyArgs {
  where: RowWhere;
  include?: { job?: { include?: { clips?: unknown } } };
  orderBy?: unknown;
  take?: number;
}
interface UpdateArgs {
  where: { id: string };
  data: Partial<FakeRow> & { status?: DeliveryStatus };
}

// Deliberately strict: anything the service asks for that this fake does not
// understand is a loud failure, never a silent match.
function matchScalar(value: string, cond: Scalar): boolean {
  if (typeof cond === "string") return value === cond;
  if (cond && Array.isArray(cond.in)) return cond.in.includes(value);
  throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
}

function matchWhere(row: FakeRow, job: FakeJob, where: RowWhere): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") {
      return (cond as RowWhere[]).some((w) => matchWhere(row, job, w));
    }
    if (key === "status") return matchScalar(row.status, cond as Scalar);
    if (key === "job") {
      return Object.entries(cond as Record<string, Scalar>).every(
        ([jobKey, jobCond]) => {
          if (jobKey !== "status") {
            throw new Error(`fake prisma: unsupported job filter ${jobKey}`);
          }
          return matchScalar(job.status, jobCond);
        }
      );
    }
    throw new Error(`fake prisma: unsupported delivery filter ${key}`);
  });
}

function createStore(job: FakeJob) {
  const row: FakeRow = {
    id: "delivery1",
    jobId: job.id,
    userId: "user1",
    chatId: "555",
    status: "PENDING",
    error: null,
    deliveredAt: null,
    createdAt: new Date("2026-07-24T10:00:00Z"),
  };

  return {
    row,
    job,
    findMany(args: FindManyArgs) {
      const matched = matchWhere(row, job, args.where) ? [row] : [];
      return Promise.resolve(
        matched.slice(0, args.take ?? matched.length).map((r) => {
          if (!args.include?.job) return { ...r };
          const included = args.include.job.include?.clips
            ? { ...job, clips: [...job.clips] }
            : { ...job, clips: undefined };
          return { ...r, job: included };
        })
      );
    },
    update(args: UpdateArgs) {
      if (args.where.id !== row.id) {
        throw new Error(`fake prisma: no delivery ${args.where.id}`);
      }
      Object.assign(row, args.data);
      return Promise.resolve({ ...row });
    },
  };
}

let store: ReturnType<typeof createStore>;

function makeClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendVideo: vi.fn().mockResolvedValue(undefined),
  };
}

const clip = (id: string): FakeClip => ({
  id,
  title: `clip ${id}`,
  description: null,
  storageKey: `clips/${id}.mp4`,
  lowQuality: false,
  score: 1,
  startTime: 0,
});

const poll = (client: ReturnType<typeof makeClient>) =>
  deliverReadyTelegramJobs(client as never, "https://clipclap.io");

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
    store = createStore({
      id: "job1",
      status: "FAILED",
      error: "R2 upload failed",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();

    await poll(client);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      "555",
      t("en").processingFailed(null)
    );
    expect(store.row.status).toBe("FAILURE_NOTIFIED");

    // still failing, still retrying: nothing new may be said
    await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    // attempt 2 heals the job
    store.job.status = "DONE";
    store.job.error = null;
    store.job.clips = [clip("c1"), clip("c2")];

    await poll(client);

    expect(client.sendVideo).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenLastCalledWith("555", t("en").done(2));
    expect(store.row.status).toBe("DELIVERED");

    // and it is terminal - no second copy of the clips on the next poll
    await poll(client);
    expect(client.sendVideo).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("delivers the honest empty answer when a healed job produced no clips", async () => {
    store = createStore({
      id: "job1",
      status: "FAILED",
      error: "R2 upload failed",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();

    await poll(client);
    store.job.status = "DONE";
    store.job.error = null;
    store.job.noClipsReason = "NO_VIABLE_MOMENTS";

    await poll(client);

    expect(client.sendMessage).toHaveBeenLastCalledWith(
      "555",
      t("en").doneNoClips("NO_VIABLE_MOMENTS")
    );
    expect(store.row.status).toBe("DELIVERED");
  });

  it("notifies a permanently failed job exactly once, however often it polls", async () => {
    store = createStore({
      id: "job1",
      status: "FAILED",
      error: "[UNSUPPORTED_INPUT] audio-only file",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();

    for (let i = 0; i < 5; i++) await poll(client);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      "555",
      t("en").processingFailed("UNSUPPORTED_INPUT")
    );
    expect(client.sendVideo).not.toHaveBeenCalled();
    expect(store.row.status).toBe("FAILURE_NOTIFIED");
  });

  it("keeps the row re-pickable when the locale lookup throws before anything is sent", async () => {
    // getUserLocale is a DB read, and it is the FIRST thing the loop does. A
    // connection blip there used to close the row terminally with nothing sent
    // at all: the job then heals, usage bills it, and the clips are lost.
    store = createStore({
      id: "job1",
      status: "DONE",
      error: null,
      noClipsReason: null,
      clips: [clip("c1")],
    });
    const client = makeClient();
    mocks.userFindUnique.mockRejectedValueOnce(new Error("connection reset"));

    await poll(client);

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.sendVideo).not.toHaveBeenCalled();
    expect(store.row.status).toBe("PENDING");

    await poll(client);

    expect(client.sendVideo).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("DELIVERED");
  });

  it("keeps the row re-pickable when the failure notice itself cannot be sent", async () => {
    // Telegram 429s routinely. A rate-limited failure notice must not close the
    // row: the job may still heal, and a closed row is billed and undelivered.
    store = createStore({
      id: "job1",
      status: "FAILED",
      error: "R2 upload failed",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();
    client.sendMessage.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await poll(client);

    expect(store.row.status).toBe("PENDING");

    // the job heals before the notice ever lands - the clips still get through
    store.job.status = "DONE";
    store.job.error = null;
    store.job.clips = [clip("c1")];

    await poll(client);

    expect(client.sendVideo).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("DELIVERED");
  });

  it("says nothing and stays re-pickable when the clip URLs cannot be signed", async () => {
    // Every URL is signed BEFORE the chat sees a word, so an R2 outage costs
    // nothing: no half-kept promise in the chat, no spam every 10 seconds, and
    // the clips are still deliverable when R2 comes back.
    store = createStore({
      id: "job1",
      status: "DONE",
      error: null,
      noClipsReason: null,
      clips: [clip("c1"), clip("c2")],
    });
    const client = makeClient();
    mocks.presign.mockRejectedValue(new Error("R2 down"));

    await poll(client);
    await poll(client);

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.sendVideo).not.toHaveBeenCalled();
    expect(store.row.status).toBe("PENDING");

    mocks.presign.mockImplementation(async (key: string) => `https://r2/${key}`);
    await poll(client);

    expect(client.sendVideo).toHaveBeenCalledTimes(2);
    expect(store.row.status).toBe("DELIVERED");
  });

  it("does not re-run a delivery once a video is already in the chat", async () => {
    // The one irreversible act. Re-picking here would put a second copy of the
    // clips the user already has into the chat, so this - and only this - is
    // terminal.
    store = createStore({
      id: "job1",
      status: "DONE",
      error: null,
      noClipsReason: null,
      clips: [clip("c1"), clip("c2")],
    });
    const client = makeClient();
    client.sendVideo
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("Bad Request: failed to get HTTP URL content"));

    await poll(client);
    await poll(client);

    expect(client.sendVideo).toHaveBeenCalledTimes(2);
    expect(store.row.status).toBe("FAILED");
    expect(store.row.error).toContain("failed to get HTTP URL content");
  });
});
