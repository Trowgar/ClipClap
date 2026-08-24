import {
  getStageQueue,
  isBotCheckFailure,
  jobStepService,
  prisma,
  uploadFile,
} from "@clipclap/shared";
import { DelayedError } from "bullmq";
import { unlink } from "fs/promises";
import { downloadVideo } from "../processors/download";
import { normalizeSource } from "../processors/normalize";
import {
  FreeAllowanceExceededError,
  SourceTooLargeError,
  SourceUnavailableError,
  UnsupportedInputError,
} from "../processors/errors";
import { recheckSourceDuration } from "./source-recheck";
import { safeTagJobError } from "./job-error";
import type { DownloadStagePayload } from "./types";
import {
  sourceArtifactKey as buildSourceArtifactKey,
  normalizedArtifactKey as buildNormalizedArtifactKey,
} from "./artifact-keys";

/** The flap-wait ladder. YouTube throttles the pinned WARP exit in episodes
 *  that pass on their own - measured 25 minutes to a few hours - so a 403 or
 *  bot check on a URL download is weather, not a verdict. Three waits, ~2.2h
 *  total, cover every observed episode; after that the failure is real enough
 *  to tell the user. Delays consume NO BullMQ attempt (moveToDelayed +
 *  DelayedError), so the ordinary 3-attempt budget still guards ordinary
 *  failures. Kill switch: DOWNLOAD_FLAP_WAIT=off. */
const FLAP_WAIT_DELAYS_MS = [10 * 60 * 1000, 30 * 60 * 1000, 90 * 60 * 1000];

function flapWaitEnabled(): boolean {
  return process.env.DOWNLOAD_FLAP_WAIT !== "off";
}

/** A failure class that passes on its own: YouTube's bot check or a bare 403
 *  from the media CDN. Only meaningful for URL sources - an uploaded file
 *  cannot be weather. */
function isFlapFailure(message: string): boolean {
  return isBotCheckFailure(message) || /HTTP Error 403/i.test(message);
}

/** The slice of BullMQ's `Job` the flap-wait path needs, not the full class -
 *  so a test can hand in a plain object instead of constructing a real Job.
 *  The real `Job` the worker processor passes in satisfies this structurally. */
interface FlapWaitJob {
  data: unknown;
  updateData(data: unknown): Promise<void>;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

export async function runDownloadStage(
  payload: DownloadStagePayload,
  bullJob?: FlapWaitJob,
  token?: string
): Promise<void> {
  let localPath: string | undefined;
  let tempNormalizedPath: string | undefined;
  // The pre-trim download, kept only so the finally can delete it. A free
  // account whose allowance is shorter than its source has the file cut in
  // recheckSourceDuration, and the cut is written beside the original rather
  // than over it - so without this the untrimmed file would be left on disk for
  // nothing to collect.
  let tempUntrimmedPath: string | undefined;

  try {
    await jobStepService.startJobStep(payload.jobId, "DOWNLOAD", payload);
    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "DOWNLOADING", processingStartedAt: new Date() },
    });

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: payload.jobId },
    });
    localPath = await downloadVideo(
      job.sourceUrl ?? undefined,
      job.sourceKey ?? undefined
    );

    // Measure the file and settle the free reservation against it, before the
    // R2 upload and long before TRANSCRIBE. Deliberately the first thing that
    // happens to a downloaded file: a job that is about to be refused should
    // not first be copied into object storage, normalized by ffmpeg and left
    // for the retention sweep to collect.
    const settledPath = await recheckSourceDuration({
      jobId: payload.jobId,
      userId: payload.userId,
      localPath,
    });
    // Everything downstream - the R2 copy, normalize, transcribe - has to work
    // on the file the ledger was settled against, not the one that was
    // downloaded. They are the same path unless the source was trimmed to fit a
    // free allowance.
    if (settledPath !== localPath) {
      tempUntrimmedPath = localPath;
      localPath = settledPath;
    }

    const sourceArtifactKey = buildSourceArtifactKey(payload.userId, payload.jobId);
    await uploadFile(sourceArtifactKey, localPath, "video/mp4");

    // A/V timeline normalization (idempotent: BullMQ retries skip when done)
    let normalizedArtifactKey = job.normalizedArtifactKey;
    let normalizeAction = "cached";
    if (!normalizedArtifactKey) {
      const outcome = await normalizeSource(localPath);
      normalizeAction = outcome.action;
      if (outcome.action === "none") {
        normalizedArtifactKey = sourceArtifactKey;
      } else {
        normalizedArtifactKey = buildNormalizedArtifactKey(payload.userId, payload.jobId);
        await uploadFile(normalizedArtifactKey, outcome.path, "video/mp4");
        tempNormalizedPath = outcome.path;
      }
    }

    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "DOWNLOADING", sourceArtifactKey, normalizedArtifactKey },
    });
    await jobStepService.completeJobStep(payload.jobId, "DOWNLOAD", {
      sourceArtifactKey,
      normalizedArtifactKey,
      normalizeAction,
    });
    await getStageQueue("transcribe").add("transcribe", payload);
  } catch (error) {
    // A 403 or bot check on a URL download is weather, not a verdict - see
    // FLAP_WAIT_DELAYS_MS above. SourceUnavailableError is only ever thrown
    // from the URL branch of downloadVideo (processors/download.ts) - the R2
    // branch (downloadFromR2) has no yt-dlp in it and cannot produce this
    // error class - so a SourceUnavailableError whose message matches
    // isFlapFailure IS a URL flap. No separate read of payload.sourceUrl is
    // needed (payload only carries jobId/userId; the stage loads the job row
    // itself, above), and an uploaded file can never reach this branch.
    if (
      error instanceof SourceUnavailableError &&
      isFlapFailure(error.message) &&
      bullJob &&
      token &&
      flapWaitEnabled()
    ) {
      const flapWaits = ((bullJob.data as { flapWaits?: number }).flapWaits ?? 0);
      if (flapWaits < FLAP_WAIT_DELAYS_MS.length) {
        const delay = FLAP_WAIT_DELAYS_MS[flapWaits];
        // Park, do not fail: no failJobStep, no FAILED write, no attempt spent.
        // The job keeps DOWNLOADING and its concurrency slot - the user's later
        // videos queue behind it, which is the serialisation the queue promises.
        //
        // The pair below talks to BullMQ/Redis and can itself fail (lock lost,
        // Redis hiccup - a lock-token mismatch throws out of the Lua script).
        // That failure must never escape past failJobStep/markJobFailed below:
        // on the LAST BullMQ attempt this catch is the only place anything
        // still runs, so a park that fails here and throws its own error would
        // skip the FAILED write entirely and strand the Prisma row in
        // DOWNLOADING forever - unbilled, uncleared, never delivered, exactly
        // what job-error-guard.test.ts exists to catch for every OTHER error
        // path in this stage. A failed park must degrade to an ordinary
        // failed attempt, never to a stranded row: on a park failure we do
        // NOT throw here, so control falls through - past both `if`s below -
        // to the existing failJobStep/markJobFailed/throw at the bottom of
        // this catch, with the ORIGINAL flap error (not the park failure),
        // so the user sees the real diagnosis and BullMQ still spends a
        // normal attempt on a normal retry.
        let parked = false;
        try {
          await bullJob.updateData({ ...(bullJob.data as object), flapWaits: flapWaits + 1 });
          // The underlying error rides along, truncated: diagnosing the
          // 2026-08-18 outage meant reproducing failures by hand with yt-dlp
          // because this line used to say only "exit flap", never why. These
          // messages can carry a multi-kilobyte yt-dlp dump, hence the cap.
          console.warn(
            `[download] ${payload.jobId}: exit flap (${flapWaits + 1}/${FLAP_WAIT_DELAYS_MS.length}), parking for ${Math.round(delay / 60000)}min - ${error.message.slice(0, 200)}`
          );
          await bullJob.moveToDelayed(Date.now() + delay, token);
          parked = true;
        } catch (parkError) {
          console.error(
            `[download] ${payload.jobId}: failed to park the flap wait, falling through to the normal failure path`,
            parkError
          );
        }
        if (parked) {
          // DelayedError is thrown only here, only on this path, so it can
          // never be a different failure that we are accidentally
          // swallowing into the markJobFailed path below - nothing else in
          // this stage throws one.
          throw new DelayedError();
        }
        // Park failed: fall through to the real FAILED path below, same as
        // the exhausted-ladder case, with the original flap error intact.
      }
      // Waits exhausted (or the park itself failed): fall through below.
    }

    await jobStepService.failJobStep(payload.jobId, "DOWNLOAD", error);
    await markJobFailed(payload.jobId, error);
    throw error;
  } finally {
    if (localPath) await unlink(localPath).catch(() => {});
    if (tempNormalizedPath) await unlink(tempNormalizedPath).catch(() => {});
    if (tempUntrimmedPath) await unlink(tempUntrimmedPath).catch(() => {});
  }
}

async function markJobFailed(jobId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Same rule as the analyze stage: the boundary that stores a user-visible
  // failure tags it, and the raw diagnostics stay in the message behind the
  // code. The two coded cases are the download failures a BullMQ retry can
  // never fix, because every attempt re-reads the identical file or re-fetches
  // the identical URL - so the copy has to hand the user something to do
  // instead of promising a rescue that is not coming. Everything else (R2,
  // ffmpeg, disk) stays untagged and renders as the generic message.
  //
  // SourceTooLargeError is a sibling of SourceUnavailableError, not a subclass,
  // so this chain cannot silently mis-file it - but keep it first anyway, so
  // that turning it into a subclass later fails loudly in the stage test rather
  // than quietly downgrading an over-the-cap VOD to the hedged copy.
  //
  // FreeAllowanceExceededError is the fourth sibling and the only one whose
  // copy may claim the minutes are intact - the re-check refunds before it
  // throws, so that claim is a fact by the time this line runs.
  const tagged =
    error instanceof UnsupportedInputError
      ? safeTagJobError("UNSUPPORTED_INPUT", message)
      : error instanceof SourceTooLargeError
        ? safeTagJobError("SOURCE_TOO_LARGE", message)
        : error instanceof SourceUnavailableError
          ? safeTagJobError("SOURCE_UNAVAILABLE", message)
          : error instanceof FreeAllowanceExceededError
            ? safeTagJobError("FREE_ALLOWANCE_EXCEEDED", message)
            : message;
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "FAILED", error: tagged },
  });
}
