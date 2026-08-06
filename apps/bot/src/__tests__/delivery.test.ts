import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rule that decides WHICH delivery rows the poller may act on lives in
 * packages/shared/src/services/telegram-delivery.service.ts, and the bug this
 * suite exists to catch - a job that heals after a failed attempt is billed and
 * never delivered - is a property of the poller and that rule TOGETHER.
 *
 * So this suite runs the real service and fakes only the prisma client:
 * findMany INTERPRETS whatever `where` the service builds against in-memory
 * rows instead of restating the rule, and applies the service's real `orderBy`
 * and `take` to the result. The mark* helpers write their real status literals
 * and attempt arithmetic onto those rows, which the next findMany then
 * re-reads. A wrong enum literal, a dropped OR branch, a missing `include`, a
 * widened `take` or a lost terminal transition therefore turns THIS suite red -
 * which a hand-written copy of the predicate could not do.
 */

const mocks = vi.hoisted(() => ({
  presign: vi.fn(),
  objectSize: vi.fn(),
  downloadToFile: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../../../../packages/shared/src/lib/r2", () => ({
  getPresignedDownloadUrl: mocks.presign,
  getPresignedUploadUrl: vi.fn(),
  getObjectSize: mocks.objectSize,
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

// The clip now travels as an uploaded file, so the poller's R2 dependency is
// "measure it, then pull it to /tmp" rather than "sign a URL". The fake path
// carries the storage key so a test can still say WHICH clip a send was for.
vi.mock("../clip-file", () => ({ downloadToFile: mocks.downloadToFile }));

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    clip: { update: (args: ClipUpdateArgs) => store.updateClip(args) },
    telegramDelivery: {
      create: vi.fn(),
      findMany: (args: FindManyArgs) => store.findMany(args),
      update: (args: UpdateArgs) => store.update(args),
    },
  },
}));

import { MAX_TELEGRAM_DELIVERY_ATTEMPTS } from "@clipclap/shared";
import { deliverReadyTelegramJobs } from "../handlers";
import { TelegramApiError } from "../telegram-client";
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
  // Per-clip delivery state. A clip that is already in the chat carries a file
  // id, which is what lets a re-picked row send only what is still owed.
  telegramFileId: string | null;
  telegramSendError: string | null;
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
  attempts: number;
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
  orderBy?: Record<string, "asc" | "desc">;
  take?: number;
}
type NumberWrite = number | { increment: number };
interface UpdateArgs {
  where: { id: string };
  data: Partial<Omit<FakeRow, "attempts">> & {
    status?: DeliveryStatus;
    attempts?: NumberWrite;
  };
}
interface ClipUpdateArgs {
  where: { id: string };
  data: { telegramFileId?: string; telegramSendError?: string };
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

interface Entry {
  row: FakeRow;
  job: FakeJob;
}

interface SeedRow {
  job: FakeJob;
  chatId?: string;
  userId?: string;
  createdAt?: Date;
  progressMessageId?: number | null;
}

const EPOCH = new Date("2026-07-24T10:00:00Z").getTime();

// The poller carries in-process state keyed by delivery id (what it has
// already said but not yet managed to write down), so every store hands out a
// fresh namespace of ids and no test can inherit another's memo.
let storeSeq = 0;

function createStore(...seeds: (FakeJob | SeedRow)[]) {
  const ns = `s${++storeSeq}`;
  const entries: Entry[] = seeds.map((seed, index) => {
    const spec: SeedRow = "job" in seed ? (seed as SeedRow) : { job: seed as FakeJob };
    return {
      job: spec.job,
      row: {
        id: `${ns}-delivery${index + 1}`,
        jobId: spec.job.id,
        userId: spec.userId ?? `user${index + 1}`,
        chatId: spec.chatId ?? String(500 + index),
        status: "PENDING",
        attempts: 0,
        error: null,
        deliveredAt: null,
        // Every seeded row has a live progress board, because that is the normal
        // case: the submit path sends one before it creates the delivery. Pass
        // null explicitly to cover a row whose acknowledgement send failed, or
        // one written before the column existed.
        //
        // `in`, not `??`: null IS the case under test, and `??` would helpfully
        // replace it with the default and quietly test nothing.
        progressMessageId:
          "progressMessageId" in spec ? spec.progressMessageId! : 900 + index,
        progressStatus: null,
        createdAt: spec.createdAt ?? new Date(EPOCH + index * 1000),
      },
    };
  });

  // Set by a test to make every status write fail, the way a saturated
  // connection pool does.
  let writesThrow = false;
  let writeCalls = 0;

  return {
    entries,
    get row() {
      return entries[0].row;
    },
    get job() {
      return entries[0].job;
    },
    rowAt(index: number) {
      const found = entries[index];
      if (!found) throw new Error(`no such row at ${index}`);
      return found.row;
    },
    breakWrites(broken: boolean) {
      writesThrow = broken;
    },
    get writeCalls() {
      return writeCalls;
    },
    findMany(args: FindManyArgs) {
      const matched = entries.filter((e) => matchWhere(e.row, e.job, args.where));
      const order = args.orderBy ?? {};
      const keys = Object.keys(order);
      if (keys.length !== 1 || keys[0] !== "createdAt") {
        throw new Error(`fake prisma: unsupported orderBy ${JSON.stringify(order)}`);
      }
      const dir = order.createdAt === "desc" ? -1 : 1;
      matched.sort(
        (a, b) => dir * (a.row.createdAt.getTime() - b.row.createdAt.getTime())
      );
      return Promise.resolve(
        matched.slice(0, args.take ?? matched.length).map(({ row, job }) => {
          if (!args.include?.job) return { ...row };
          // Clips are COPIED, not aliased. Prisma hands back detached rows, so
          // a clip.update during the pass must not retro-edit the object the
          // poller is already holding - aliasing them would let the summary
          // count the same delivery twice.
          const included = args.include.job.include?.clips
            ? { ...job, clips: job.clips.map((c) => ({ ...c })) }
            : { ...job, clips: undefined };
          return { ...row, job: included };
        })
      );
    },
    updateClip(args: ClipUpdateArgs) {
      // Deliberately NOT gated on breakWrites: the pool failure those tests
      // model is about the delivery row's status write, and letting it swallow
      // the per-clip write too would hide whether the clip state is recorded.
      for (const entry of entries) {
        const found = entry.job.clips.find((c) => c.id === args.where.id);
        if (found) {
          Object.assign(found, args.data);
          return Promise.resolve({ ...found });
        }
      }
      throw new Error(`fake prisma: no clip ${args.where.id}`);
    },
    update(args: UpdateArgs) {
      writeCalls++;
      if (writesThrow) {
        return Promise.reject(new Error("Timed out fetching a connection"));
      }
      const entry = entries.find((e) => e.row.id === args.where.id);
      if (!entry) {
        throw new Error(`fake prisma: no delivery ${args.where.id}`);
      }
      const { attempts, ...rest } = args.data;
      Object.assign(entry.row, rest);
      if (attempts !== undefined) {
        entry.row.attempts =
          typeof attempts === "number"
            ? attempts
            : entry.row.attempts + attempts.increment;
      }
      return Promise.resolve({ ...entry.row });
    },
  };
}

let store: ReturnType<typeof createStore>;

function makeClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    // (chatId, filePath, caption) - the file path is `/tmp/<storageKey>` here,
    // so `calls[i][1]` still names the clip the way the signed URL used to.
    sendVideoUpload: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
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
  telegramFileId: null,
  telegramSendError: null,
});

const doneJob = (id: string, clips: FakeClip[]): FakeJob => ({
  id,
  status: "DONE",
  error: null,
  noClipsReason: null,
  clips,
});

const poll = (client: ReturnType<typeof makeClient>) =>
  deliverReadyTelegramJobs(client as never, "https://clipclap.io");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ telegramLocale: "en" });
  mocks.presign.mockImplementation(async (key: string) => `https://r2/${key}`);
  mocks.objectSize.mockResolvedValue(1_000_000);
  mocks.downloadToFile.mockImplementation(async (key: string) => `/tmp/${key}`);
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
      "500",
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

    expect(client.sendVideoUpload).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenLastCalledWith("500", t("en").done(2));
    expect(store.row.status).toBe("DELIVERED");

    // and it is terminal - no second copy of the clips on the next poll
    await poll(client);
    expect(client.sendVideoUpload).toHaveBeenCalledTimes(2);
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
      "500",
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
      "500",
      t("en").processingFailed("UNSUPPORTED_INPUT")
    );
    expect(client.sendVideoUpload).not.toHaveBeenCalled();
    expect(store.row.status).toBe("FAILURE_NOTIFIED");
  });

  it("keeps the row re-pickable when the locale lookup throws before anything is sent", async () => {
    // getUserLocale is a DB read, and it is the FIRST thing the loop does. A
    // connection blip there used to close the row terminally with nothing sent
    // at all: the job then heals, usage bills it, and the clips are lost.
    store = createStore(doneJob("job1", [clip("c1")]));
    const client = makeClient();
    mocks.userFindUnique.mockRejectedValueOnce(new Error("connection reset"));

    await poll(client);

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.sendVideoUpload).not.toHaveBeenCalled();
    expect(store.row.status).toBe("PENDING");

    await poll(client);

    expect(client.sendVideoUpload).toHaveBeenCalledTimes(1);
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

    expect(client.sendVideoUpload).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("DELIVERED");
  });

  it("says nothing and stays re-pickable when the clips cannot be fetched from R2", async () => {
    // The clip is no longer handed to Telegram as a signed URL, it is pulled to
    // a temp file and uploaded - so the R2 outage this covers now lands on the
    // download. The guarantee is unchanged: no word in the chat, no summary to
    // half-keep, and the clips are still deliverable when R2 comes back.
    store = createStore(doneJob("job1", [clip("c1"), clip("c2")]));
    const client = makeClient();
    mocks.downloadToFile.mockRejectedValue(new Error("R2 down"));

    await poll(client);
    await poll(client);

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.sendVideoUpload).not.toHaveBeenCalled();
    expect(store.row.status).toBe("PENDING");

    mocks.downloadToFile.mockImplementation(async (key: string) => `/tmp/${key}`);
    await poll(client);

    expect(client.sendVideoUpload).toHaveBeenCalledTimes(2);
    expect(store.row.status).toBe("DELIVERED");
  });

  // THE MEASURED BUG. A user got 1 of 12: clip 2 was 20,557,490 bytes, over the
  // 20 MB URL-fetch ceiling, its send threw, and the row was declared terminal
  // on the spot - so clips 3-12, every one of them deliverable, were never
  // attempted again. The old assertion here ("a video is in the chat, so the row
  // is terminal") WAS that behaviour. It was written to stop a second copy of an
  // already-sent clip, and telegramFileId now carries that guard per clip, so
  // the row can be re-picked without the duplicate it was protecting against.
  it("retries only the clips still owed, and never re-sends one already in the chat", async () => {
    store = createStore(doneJob("job1", [clip("c1"), clip("c2")]));
    const client = makeClient();
    const sentTo = (key: string) =>
      client.sendVideoUpload.mock.calls.filter((c) =>
        String(c[1]).endsWith(key)
      );
    client.sendVideoUpload.mockImplementation(async (_chat, path: string) => {
      if (path.endsWith("c2.mp4")) {
        throw new TelegramApiError(
          "Bad Request: failed to get HTTP URL content",
          "sendVideo"
        );
      }
      return "FID-c1";
    });

    await poll(client);

    // c1 landed, c2 did not - and the row is NOT closed over it
    expect(store.row.status).toBe("PENDING");
    expect(store.job.clips[0].telegramFileId).toBe("FID-c1");
    expect(store.job.clips[1].telegramFileId).toBeNull();
    expect(client.sendMessage).not.toHaveBeenCalled();

    await poll(client);

    // the retry touched c2 alone
    expect(sentTo("c1.mp4")).toHaveLength(1);
    expect(sentTo("c2.mp4")).toHaveLength(2);

    client.sendVideoUpload.mockResolvedValue("FID-c2");
    await poll(client);

    expect(sentTo("c1.mp4")).toHaveLength(1);
    expect(store.row.status).toBe("DELIVERED");
    expect(client.sendMessage).toHaveBeenCalledWith("500", t("en").done(2));
  });
});

describe("the pickup window drains", () => {
  // getPendingTelegramDeliveries takes 20 rows, createdAt asc. A row that can
  // never succeed and never leaves PENDING therefore holds a twentieth of the
  // whole bot's delivery capacity for ever - and twenty of them hold all of it.
  // These tests put a healthy, paying user BEHIND the wall of stuck rows and
  // insist the clips still arrive.
  const WALL = 20;

  // The error OBJECT, not just its text: the send loop asks whether Telegram
  // answered at all before it decides a chat is hopeless, and only a
  // TelegramApiError says it did. A bare Error is the no-answer case.
  function buildWall(failure: Error) {
    const seeds: SeedRow[] = [];
    for (let i = 0; i < WALL; i++) {
      seeds.push({
        job: doneJob(`stuck${i}`, [clip(`s${i}`)]),
        chatId: `stuck-chat-${i}`,
        userId: `stuck-user-${i}`,
        createdAt: new Date(EPOCH + i * 1000),
      });
    }
    // The victim queued LAST, so createdAt asc puts them at index 20 - exactly
    // one past the window.
    seeds.push({
      job: doneJob("victim", [clip("v1")]),
      chatId: "victim-chat",
      userId: "victim-user",
      createdAt: new Date(EPOCH + WALL * 1000),
    });
    store = createStore(...seeds);

    const client = makeClient();
    client.sendVideoUpload.mockImplementation(async (chatId: string) => {
      if (chatId.startsWith("stuck-chat-")) throw failure;
    });
    return client;
  }

  it("a wall of never-healing rows does not starve the row behind it", async () => {
    // A generic, transient-LOOKING fault (nothing in the string says it is
    // permanent) that in fact never heals. The only thing that can free the
    // window is a bounded attempt budget.
    const client = buildWall(new Error("connection reset by peer"));

    let pollsUntilDelivered = -1;
    for (let i = 1; i <= 60; i++) {
      await poll(client);
      if (store.rowAt(WALL).status === "DELIVERED") {
        pollsUntilDelivered = i;
        break;
      }
    }

    expect(store.rowAt(WALL).status).toBe("DELIVERED");
    expect(client.sendVideoUpload).toHaveBeenCalledWith(
      "victim-chat",
      expect.anything(),
      expect.anything()
    );
    // 60 polls is 10 minutes. A wall of dead rows must clear in a small
    // multiple of the poll interval, not in a multiple of the user's patience.
    expect(pollsUntilDelivered).toBeGreaterThan(0);
    expect(pollsUntilDelivered).toBeLessThanOrEqual(15);
    // and every stuck row is off the books
    for (let i = 0; i < WALL; i++) {
      expect(store.rowAt(i).status).toBe("FAILED");
    }
  });

  it("a blocked bot is retired at once instead of burning the attempt budget", async () => {
    // 403 will never heal, and every retry is a wasted Telegram call that
    // counts against the bot's global rate limit.
    const client = buildWall(
      new TelegramApiError("Forbidden: bot was blocked by the user", "sendVideo")
    );

    await poll(client);

    for (let i = 0; i < WALL; i++) {
      expect(store.rowAt(i).status).toBe("FAILED");
    }
    expect(client.sendVideoUpload).toHaveBeenCalledTimes(WALL);

    await poll(client);

    expect(store.rowAt(WALL).status).toBe("DELIVERED");
    // no extra calls at the blocked chats
    expect(client.sendVideoUpload).toHaveBeenCalledTimes(WALL + 1);
  });

  it("a healed transient fault does not consume the budget of the next stage", async () => {
    // The failure notice lands after a couple of 429s; the job then heals. The
    // clips delivery must start from a full budget, not from whatever the
    // notice spent.
    store = createStore({
      id: "job1",
      status: "FAILED",
      error: "R2 upload failed",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();
    client.sendMessage
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await poll(client);
    await poll(client);
    expect(store.row.attempts).toBeGreaterThan(0);

    await poll(client);
    expect(store.row.status).toBe("FAILURE_NOTIFIED");
    expect(store.row.attempts).toBe(0);
  });
});

describe("a partial delivery is admitted, not hidden", () => {
  // The report is unchanged - "1 of 3" - but it is no longer the FIRST thing a
  // mid-batch failure does. A refusal on clip 2 used to end the delivery on the
  // spot; now it costs clip 2 alone, clip 3 is still attempted, and the row is
  // only summarised as partial once its retries are spent.
  it("tells the user how many clips arrived once the retries are exhausted", async () => {
    store = createStore(doneJob("job1", [clip("c1"), clip("c2"), clip("c3")]));
    const client = makeClient();
    client.sendVideoUpload.mockImplementation(async (_chat, path: string) => {
      if (path.endsWith("c1.mp4")) return "FID-c1";
      throw new TelegramApiError(
        "Bad Request: failed to get HTTP URL content",
        "sendVideo"
      );
    });

    await poll(client);

    // all three attempted, not one-then-stop; and nothing final is said yet
    expect(client.sendVideoUpload).toHaveBeenCalledTimes(3);
    expect(store.row.status).toBe("PENDING");
    expect(client.sendMessage).not.toHaveBeenCalled();

    for (let i = 1; i < MAX_TELEGRAM_DELIVERY_ATTEMPTS; i++) await poll(client);

    expect(store.row.status).toBe("FAILED");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      "500",
      t("en").donePartial(1, 3)
    );

    // and it stays said exactly once
    await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("still confirms the batch when only the summary send failed", async () => {
    // All three clips are in the chat; only the trailing summary 429'd. The row
    // stays re-pickable and the next poll re-sends nothing but the summary -
    // every clip carries a file id now, so the retry cannot duplicate them. The
    // old code had to say the summary twice inside one pass because a re-pickup
    // would have repeated the videos; it also retired the row to FAILED, which
    // was never true here - nothing was lost but one message.
    store = createStore(doneJob("job1", [clip("c1"), clip("c2"), clip("c3")]));
    const client = makeClient();
    client.sendMessage
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValue(undefined);

    await poll(client);

    expect(client.sendVideoUpload).toHaveBeenCalledTimes(3);
    expect(store.row.status).toBe("PENDING");

    await poll(client);

    // no second copy of anything the user already has
    expect(client.sendVideoUpload).toHaveBeenCalledTimes(3);
    // the retry landed - the confirmation is really in the chat, not merely
    // attempted and lost. A confirmation, not a "1 of 3"-style half-truth.
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenLastCalledWith("500", t("en").done(3));
    expect(store.row.status).toBe("DELIVERED");
  });
});

describe("a delivery that is given up on is not given up on in silence", () => {
  // The measured bug: a row that spent its attempt budget was retired to FAILED
  // with nothing but a console.error. The job is DONE, so usage.service bills
  // it (it sums every job that is not FAILED), the clips are in the database
  // and on R2 - and the chat is told absolutely nothing, for ever, because a
  // FAILED row never re-enters getPendingTelegramDeliveries.
  const APP_URL = "https://clipclap.io";

  it("tells the user where their clips are when the attempt budget runs out", async () => {
    store = createStore(doneJob("job1", [clip("c1")]));
    const client = makeClient();
    client.sendVideoUpload.mockRejectedValue(new Error("connection reset by peer"));

    for (let i = 0; i <= MAX_TELEGRAM_DELIVERY_ATTEMPTS; i++) await poll(client);

    expect(store.row.status).toBe("FAILED");
    expect(store.row.attempts).toBe(MAX_TELEGRAM_DELIVERY_ATTEMPTS);
    expect(client.sendMessage.mock.calls).toEqual([
      ["500", t("en").deliveryGivenUp(APP_URL, 1)],
    ]);
  });

  it("says it exactly once, however long the poller keeps running", async () => {
    store = createStore(doneJob("job1", [clip("c1"), clip("c2")]));
    const client = makeClient();
    client.sendVideoUpload.mockRejectedValue(new Error("connection reset by peer"));

    for (let i = 0; i <= MAX_TELEGRAM_DELIVERY_ATTEMPTS; i++) await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const videoCallsAtRetirement = client.sendVideoUpload.mock.calls.length;

    // 30 more polls - five minutes of them
    for (let i = 0; i < 30; i++) await poll(client);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendVideoUpload.mock.calls.length).toBe(videoCallsAtRetirement);
    expect(store.row.status).toBe("FAILED");
  });

  it("does not speak until the terminal write has actually landed", async () => {
    // The ordering guarantee. The message is sent AFTER the write that retires
    // the row, never before: the transition to FAILED happens at most once, so
    // the send hangs off an event that cannot repeat. Send first and a write
    // that then throws leaves the row PENDING and re-pickable - and the next
    // poll sends the identical message, six times a minute, for as long as the
    // pool is down.
    store = createStore(doneJob("job1", [clip("c1")]));
    const client = makeClient();
    client.sendVideoUpload.mockRejectedValue(new Error("connection reset by peer"));

    for (let i = 0; i < MAX_TELEGRAM_DELIVERY_ATTEMPTS - 1; i++) await poll(client);
    expect(store.row.attempts).toBe(MAX_TELEGRAM_DELIVERY_ATTEMPTS - 1);
    expect(store.row.status).toBe("PENDING");
    expect(client.sendMessage).not.toHaveBeenCalled();

    // the pool saturates exactly on the poll that would have retired the row
    store.breakWrites(true);
    for (let i = 0; i < 5; i++) await poll(client);

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(store.row.status).toBe("PENDING");

    store.breakWrites(false);
    await poll(client);

    expect(store.row.status).toBe("FAILED");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      "500",
      t("en").deliveryGivenUp(APP_URL, 1)
    );

    for (let i = 0; i < 5; i++) await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("stays terminal and keeps the batch alive when that message cannot be sent", async () => {
    // The chat may be exactly what is broken. Resurrecting the row would spend
    // a second budget on the same dead send, and a throw escaping the loop
    // would abandon every row queued behind this one.
    store = createStore(
      { job: doneJob("job1", [clip("a1")]), chatId: "chat-a" },
      { job: doneJob("job2", [clip("b1")]), chatId: "chat-b" }
    );
    const client = makeClient();
    const dead = async (chatId: string) => {
      if (chatId === "chat-a") throw new Error("connection reset by peer");
    };
    client.sendVideoUpload.mockImplementation(dead);
    client.sendMessage.mockImplementation(dead);

    for (let i = 0; i <= MAX_TELEGRAM_DELIVERY_ATTEMPTS; i++) {
      await expect(poll(client)).resolves.toBeUndefined();
    }

    expect(store.rowAt(0).status).toBe("FAILED");
    expect(store.rowAt(1).status).toBe("DELIVERED");
  });

  it("tells the user even when it was the failure notice that never got through", async () => {
    // Same hole on the other branch: the notice 429s until the budget is gone,
    // the row is retired, and the user hears nothing about a video they sent.
    // No clips exist here, so the copy may not claim any.
    store = createStore({
      id: "job1",
      status: "FAILED",
      error: "R2 upload failed",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();
    let sends = 0;
    client.sendMessage.mockImplementation(async () => {
      sends++;
      if (sends <= MAX_TELEGRAM_DELIVERY_ATTEMPTS) {
        throw new Error("429 Too Many Requests");
      }
    });

    for (let i = 0; i <= MAX_TELEGRAM_DELIVERY_ATTEMPTS; i++) await poll(client);

    expect(store.row.status).toBe("FAILED");
    expect(client.sendMessage).toHaveBeenLastCalledWith(
      "500",
      t("en").deliveryGivenUp(APP_URL, 0)
    );

    await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(
      MAX_TELEGRAM_DELIVERY_ATTEMPTS + 1
    );
  });
});

describe("a failed status write never repeats a message", () => {
  it("does not re-send the failure notice when the status write throws", async () => {
    // The notice reached the chat; only the bookkeeping blipped. PENDING + job
    // FAILED is the first branch of the pickup query, so without a guard the
    // next poll sends the identical notice - six times a minute.
    store = createStore({
      id: "job1",
      status: "FAILED",
      error: "R2 upload failed",
      noClipsReason: null,
      clips: [],
    });
    const client = makeClient();
    store.breakWrites(true);

    await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("PENDING");

    // sustained write failure: still exactly one notice in the chat
    for (let i = 0; i < 6; i++) await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    // when the pool recovers the owed write lands, silently
    store.breakWrites(false);
    await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("FAILURE_NOTIFIED");
  });

  it("does not re-send the no-clips answer when the status write throws", async () => {
    store = createStore({
      id: "job1",
      status: "DONE",
      error: null,
      noClipsReason: "NO_VIABLE_MOMENTS",
      clips: [],
    });
    const client = makeClient();
    store.breakWrites(true);

    for (let i = 0; i < 4; i++) await poll(client);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    store.breakWrites(false);
    await poll(client);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("DELIVERED");
  });
});

describe("a failing status write cannot abort the batch", () => {
  it("does not duplicate clips or block the rows behind it", async () => {
    // markTelegramDeliveryFailed was unguarded inside the catch: its throw
    // escaped deliverReadyTelegramJobs, pollDeliveries logged and re-polled,
    // and the row was still PENDING with a video already in the chat - two
    // copies per poll, and every row behind it never even looked at.
    store = createStore(
      { job: doneJob("job1", [clip("a1"), clip("a2")]), chatId: "chat-a" },
      { job: doneJob("job2", [clip("b1")]), chatId: "chat-b" }
    );
    const client = makeClient();
    client.sendVideoUpload.mockImplementation(async (chatId: string, path: string) => {
      if (chatId === "chat-a" && path.endsWith("a2.mp4")) {
        throw new TelegramApiError(
          "Bad Request: failed to get HTTP URL content",
          "sendVideo"
        );
      }
      return "FID";
    });
    store.breakWrites(true);

    await expect(poll(client)).resolves.toBeUndefined();

    // the row BEHIND the throwing one was reached on that very first poll
    const toB = () =>
      client.sendVideoUpload.mock.calls.filter((c) => c[0] === "chat-b");
    expect(toB()).toHaveLength(1);

    const sent = (key: string) =>
      client.sendVideoUpload.mock.calls.filter((c) =>
        String(c[1]).endsWith(key)
      );

    for (let i = 0; i < 3; i++) {
      await expect(poll(client)).resolves.toBeUndefined();
    }

    // No duplicate, though not one delivery-row status write has landed: the
    // guard that stops a re-send is the clip's own file id, written on the clip
    // row, so it survives a pool that cannot record the delivery's status at
    // all. a2 IS retried on every poll, and that is the fix - it never made it
    // into the chat, so it is still owed.
    expect(sent("a1.mp4")).toHaveLength(1);
    expect(toB()).toHaveLength(1);
    expect(sent("a2.mp4").length).toBeGreaterThan(1);
    // and the row that finished says its summary once, not once per poll
    expect(
      client.sendMessage.mock.calls.filter((c) => c[0] === "chat-b")
    ).toEqual([["chat-b", t("en").done(1)]]);
  });
});

/**
 * The progress board is scaffolding, and every terminal path has to take it down.
 *
 * It exists to answer "is this alive?" during a wait that measures 2.5 to 13
 * minutes in production. The moment this job has said its final word, the board
 * is clutter that accumulates one message per run - so it is deleted rather than
 * ticked, which is what an earlier version of this feature got wrong.
 */
describe("the progress board is retired with the job", () => {
  it("deletes the board only AFTER the clips are in the chat", async () => {
    store = createStore({
      job: doneJob("job1", [clip("c1"), clip("c2")]),
      progressMessageId: 900,
    });
    const client = makeClient();
    const order: string[] = [];
    client.sendVideoUpload.mockImplementation(async () => {
      order.push("video");
    });
    client.deleteMessage.mockImplementation(async () => {
      order.push("delete");
    });

    await poll(client);

    expect(client.deleteMessage).toHaveBeenCalledWith("500", 900);
    // Order is the invariant, not a detail: deleting first would leave a user
    // whose R2 signing then failed with no clips AND no sign of life.
    expect(order).toEqual(["video", "video", "delete"]);
  });

  it("deletes the board when the job failed", async () => {
    store = createStore({
      job: {
        id: "job1",
        status: "FAILED",
        error: "boom",
        noClipsReason: null,
        clips: [],
      },
      progressMessageId: 901,
    });
    const client = makeClient();

    await poll(client);

    expect(client.deleteMessage).toHaveBeenCalledWith("500", 901);
  });

  it("deletes the board when there were no clips to send", async () => {
    store = createStore({
      job: {
        id: "job1",
        status: "DONE",
        error: null,
        noClipsReason: "NO_USABLE_SPEECH",
        clips: [],
      },
      progressMessageId: 902,
    });
    const client = makeClient();

    await poll(client);

    expect(client.deleteMessage).toHaveBeenCalledWith("500", 902);
  });

  // Rows written before the column existed, and rows whose acknowledgement send
  // failed, both read back with no board. Nothing may be deleted on their behalf
  // - least of all message id `undefined`.
  it("deletes nothing when the row has no board", async () => {
    store = createStore({
      job: doneJob("job1", [clip("c1")]),
      progressMessageId: null,
    });
    const client = makeClient();

    await poll(client);

    expect(client.deleteMessage).not.toHaveBeenCalled();
    expect(client.sendVideoUpload).toHaveBeenCalledTimes(1);
  });

  // A board that will not delete is litter; a clip that never arrives is the
  // product failing. The row must still settle.
  it("still delivers and settles when the delete fails", async () => {
    store = createStore({
      job: doneJob("job1", [clip("c1")]),
      progressMessageId: 903,
    });
    const client = makeClient();
    client.deleteMessage.mockRejectedValue(new Error("message to delete not found"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(poll(client)).resolves.toBeUndefined();

    expect(client.sendVideoUpload).toHaveBeenCalledTimes(1);
    expect(store.row.status).toBe("DELIVERED");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
