import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live progress board: one message, sent as the upload acknowledgement and
 * then edited in place as Job.status walks the pipeline.
 *
 * The wait it covers is not hypothetical. Measured over the production job_steps
 * table, a job takes between 153 and 780 seconds from creation to its last
 * finished step - median 384 - and before this the chat received two messages in
 * the first seconds and then nothing at all for the whole of it.
 *
 * Like delivery.test.ts, this runs the REAL shared service against a fake prisma
 * so the pickup rule itself is under test: getInFlightTelegramDeliveries has to
 * exclude terminal jobs, exclude rows with no board, and exclude rows that have
 * already reported an outcome. A hand-written copy of that predicate here could
 * not catch a change to it.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  deliveryUpdate: vi.fn(),
}));

interface Row {
  id: string;
  chatId: string;
  userId: string;
  status: "PENDING" | "DELIVERED" | "FAILED" | "FAILURE_NOTIFIED";
  progressMessageId: number | null;
  progressStatus: string | null;
  job: { status: string };
  createdAt: Date;
}

let rows: Row[] = [];

/** Interprets the service's own `where`, rather than restating it. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  if (where.status && row.status !== where.status) return false;
  const pid = where.progressMessageId as { not?: null } | undefined;
  if (pid && "not" in pid && row.progressMessageId === null) return false;
  const job = where.job as { status?: { notIn?: string[] } } | undefined;
  const notIn = job?.status?.notIn;
  if (notIn && notIn.includes(row.job.status)) return false;
  return true;
}

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    telegramDelivery: {
      findMany: (args: { where: Record<string, unknown>; take?: number }) =>
        Promise.resolve(
          rows.filter((r) => matches(r, args.where)).slice(0, args.take ?? 20)
        ),
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
        mocks.deliveryUpdate(args);
        const row = rows.find((r) => r.id === args.where.id);
        if (row && typeof args.data.progressStatus === "string") {
          row.progressStatus = args.data.progressStatus;
        }
        return Promise.resolve(row);
      },
      create: vi.fn(),
    },
  },
}));

import {
  renderProgressBoard,
  updateTelegramProgressBoards,
} from "../handlers";
import { t } from "../i18n";

function client() {
  return {
    editMessageText: vi.fn(async () => ({})),
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
  };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "d1",
    chatId: "4242",
    userId: "u1",
    status: "PENDING",
    progressMessageId: 77,
    progressStatus: null,
    job: { status: "TRANSCRIBING" },
    createdAt: new Date("2026-07-30T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  mocks.userFindUnique.mockResolvedValue({ telegramLocale: "en" });
});

describe("renderProgressBoard", () => {
  const en = t("en");

  it("marks the running stage, ticks the ones behind it and leaves the rest blank", () => {
    const board = renderProgressBoard(en, "ANALYZING");

    expect(board).toContain(`✅ ${en.progressStepDownload}`);
    expect(board).toContain(`✅ ${en.progressStepTranscribe}`);
    expect(board).toContain(`⏳ ${en.progressStepAnalyze}`);
    expect(board).toContain(`◽ ${en.progressStepRender}`);
  });

  // PENDING is "accepted, nothing started" - no stage may claim to be running,
  // or the first thing the user reads is a lie about a worker that has not
  // picked the job up yet.
  it("shows nothing running while the job is still queued", () => {
    const board = renderProgressBoard(en, "PENDING");

    expect(board).not.toContain("⏳");
    expect(board).not.toContain("✅");
    expect(board).toContain(en.progressQueuedNote);
  });

  it("ticks every stage once the job is terminal", () => {
    for (const status of ["DONE", "FAILED"] as const) {
      const board = renderProgressBoard(en, status);
      expect(board).not.toContain("◽");
      expect(board).not.toContain("⏳");
      expect(board).toContain(en.progressDoneTitle);
    }
  });

  // The stage order is the order of the pipeline. A board that lists rendering
  // before transcription would be read as a bug in the product.
  it("keeps the stages in pipeline order", () => {
    const board = renderProgressBoard(en, "PENDING");
    const at = (s: string) => board.indexOf(s);

    expect(at(en.progressStepDownload)).toBeLessThan(
      at(en.progressStepTranscribe)
    );
    expect(at(en.progressStepTranscribe)).toBeLessThan(
      at(en.progressStepAnalyze)
    );
    expect(at(en.progressStepAnalyze)).toBeLessThan(at(en.progressStepRender));
  });

  it("renders in the reader's own language", () => {
    const ru = t("ru");
    expect(renderProgressBoard(ru, "ANALYZING")).toContain(
      ru.progressStepAnalyze
    );
    expect(renderProgressBoard(ru, "ANALYZING")).not.toContain(
      en.progressStepAnalyze
    );
  });
});

describe("updateTelegramProgressBoards", () => {
  it("edits the board to the stage the job is actually on", async () => {
    rows = [row({ progressStatus: "DOWNLOADING", job: { status: "ANALYZING" } })];
    const c = client();

    await updateTelegramProgressBoards(c as never);

    expect(c.editMessageText).toHaveBeenCalledWith(
      "4242",
      77,
      renderProgressBoard(t("en"), "ANALYZING")
    );
    expect(mocks.deliveryUpdate).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { progressStatus: "ANALYZING" },
    });
  });

  // The guard that keeps a ten-second loop from re-sending identical text for
  // the six minutes a job takes. Without it every poll is an edit.
  it("does not touch a board that already shows the current stage", async () => {
    rows = [
      row({ progressStatus: "TRANSCRIBING", job: { status: "TRANSCRIBING" } }),
    ];
    const c = client();

    await updateTelegramProgressBoards(c as never);

    expect(c.editMessageText).not.toHaveBeenCalled();
    expect(mocks.deliveryUpdate).not.toHaveBeenCalled();
  });

  // Terminal jobs belong to the delivery pass, which draws the last frame ONLY
  // after the clips are in the chat. An "all finished" board above an empty chat
  // is the promise-we-cannot-keep bug the delivery loop already guards against.
  it("leaves a finished or failed job alone", async () => {
    rows = [
      row({ id: "done", job: { status: "DONE" } }),
      row({ id: "failed", job: { status: "FAILED" } }),
    ];
    const c = client();

    await updateTelegramProgressBoards(c as never);

    expect(c.editMessageText).not.toHaveBeenCalled();
  });

  it("skips a row that has no board", async () => {
    rows = [row({ progressMessageId: null })];
    const c = client();

    await updateTelegramProgressBoards(c as never);

    expect(c.editMessageText).not.toHaveBeenCalled();
  });

  // A row that already reported its outcome has nothing left to narrate.
  it("skips a row that is no longer pending", async () => {
    rows = [row({ status: "DELIVERED" }), row({ id: "d2", status: "FAILED" })];
    const c = client();

    await updateTelegramProgressBoards(c as never);

    expect(c.editMessageText).not.toHaveBeenCalled();
  });

  // Telegram refuses an edit whose text is byte-identical. It can only happen
  // when a previous edit landed and its bookkeeping write did not, so it means
  // the board is already right - and the write is what is owed.
  it("treats an unmodified-edit refusal as the board already being right", async () => {
    rows = [row({ progressStatus: "DOWNLOADING", job: { status: "ANALYZING" } })];
    const c = client();
    c.editMessageText = vi.fn(async () => {
      throw new Error("Bad Request: message is not modified");
    }) as never;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await updateTelegramProgressBoards(c as never);

    expect(mocks.deliveryUpdate).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { progressStatus: "ANALYZING" },
    });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  // A board is a courtesy. A throw escaping this function would stall the same
  // ten-second loop that delivers finished clips, so a cosmetic failure would
  // start costing people their videos.
  it("never throws when the edit fails, and carries on with the next row", async () => {
    rows = [
      row({ id: "bad", progressStatus: "PENDING", job: { status: "ANALYZING" } }),
      row({
        id: "good",
        chatId: "999",
        progressMessageId: 88,
        progressStatus: "PENDING",
        job: { status: "CUTTING" },
      }),
    ];
    const c = client();
    c.editMessageText = vi
      .fn()
      .mockRejectedValueOnce(new Error("chat not found"))
      .mockResolvedValue({}) as never;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      updateTelegramProgressBoards(c as never)
    ).resolves.toBeUndefined();

    expect(c.editMessageText).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
