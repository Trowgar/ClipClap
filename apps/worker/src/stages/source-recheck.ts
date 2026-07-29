import {
  findFreeCharge,
  freeBalanceSeconds,
  prisma,
  probeLocalFile,
  refundFailedJob,
  reviseFreeChargeSeconds,
} from "@clipclap/shared";
import { FreeAllowanceExceededError } from "../processors/errors";

export interface SourceRecheckInput {
  jobId: string;
  userId: string;
  /** The file on local disk, already downloaded, not yet transcribed. */
  localPath: string;
}

/**
 * Measures the downloaded file and settles the free reservation against it.
 *
 * WHERE THIS SITS AND WHY IT CANNOT SIT ANYWHERE ELSE.
 *
 * The submit gate can only judge what the submitter told it. A pasted URL is
 * probed there with yt-dlp, but an UPLOAD is already sitting in R2 by the time
 * the route runs - the browser PUTs it to a presigned URL first - so refusing
 * it there would refuse a file we had already paid to store, and the route
 * therefore reserves it at zero seconds and defers the question. This is where
 * the question comes due. Money leaves the account at TRANSCRIBE, one stage
 * later; the file is on local disk here and nowhere earlier. So this is
 * simultaneously the first point at which the true duration is knowable and the
 * last at which knowing it is still worth anything.
 *
 * EVERY job is probed, URL and upload alike, and the answer is written to
 * Job.sourceDurationSec whatever the plan. Two reasons. The downloaded file is
 * the ground truth and the yt-dlp metadata is a claim about it: a live or DVR
 * URL reports one length and yields another, and format selection can hand back
 * a different cut of the same video. And sourceDurationSec is not only the free
 * tier's business - buildJobCostTelemetry multiplies it into every cost figure
 * in /admin, and the client-side probe in upload-zone.tsx returns null for any
 * codec the browser cannot decode, which is exactly the HEVC/AV1/MKV sources
 * this audience uploads. Re-probing a URL job costs one ffprobe on a local
 * file - tens of milliseconds - against a stage that has just spent minutes
 * downloading.
 *
 * The re-check that can FAIL a job is likewise not restricted to uploads, and
 * it needs no upload/URL branch to be fair to a URL job. See the headroom
 * arithmetic below: a job is measured against the balance with its OWN
 * reservation added back, so a URL whose metadata was honest passes trivially
 * (it was already found to fit), and only a real discrepancy large enough to
 * overrun what is left can fail. Trusting yt-dlp's metadata at submit and never
 * checking it again is what would leave the hole - a stream that reports 60
 * seconds and downloads six hours is charged for one minute and transcribed for
 * six hours.
 *
 * @throws FreeAllowanceExceededError when the measured duration does not fit.
 */
export async function recheckSourceDuration(
  input: SourceRecheckInput
): Promise<void> {
  // The stale-dist guard, same hazard safeTagJobError exists for. The worker
  // resolves @clipclap/shared to packages/shared/dist, dist is gitignored, and
  // a deploy that restarts a worker before `npm run build -w @clipclap/shared`
  // leaves these brand-new exports as undefined on an otherwise working
  // namespace. Calling one raw would throw a TypeError from the middle of the
  // download stage and fail EVERY job on the box - paying customers included -
  // for a build-order slip that used to cost nothing but error copy. Skipping
  // the measurement instead leaves uploads reserved at zero seconds for the
  // minutes until the rebuild lands, which is the bounded, recoverable failure
  // and is loud in the logs.
  if (typeof probeLocalFile !== "function") {
    console.error(
      `[free-tier] @clipclap/shared is missing probeLocalFile - the worker is ` +
        `running a stale packages/shared/dist. Job ${input.jobId} runs ` +
        `unmeasured; run npm run build -w @clipclap/shared.`
    );
    return;
  }

  const probe = await probeLocalFile(input.localPath);

  if (!probe.ok) {
    // An operational fault, never a verdict about the user. ffprobe missing
    // from the image, ffprobe timing out, a container it cannot parse - none of
    // those are evidence that this video is too long, and refusing a job on
    // absent evidence would refuse a paying customer for our own breakage. The
    // job proceeds on whatever duration the submit path recorded; that is a
    // worse estimate, not a wrong outcome.
    //
    // probe-unavailable is called out separately because it is the one reason
    // that is a deploy fault rather than a file fault, and it is silent: the
    // pipeline keeps working, the ledger quietly stops being corrected, and
    // every upload runs on a zero-second reservation. That must be findable in
    // the logs without anyone knowing to look for it.
    if (probe.reason === "probe-unavailable") {
      console.error(
        `[free-tier] ffprobe is UNAVAILABLE in this container - job ` +
          `${input.jobId} runs unmeasured, and every free upload is now ` +
          `reserved at zero seconds. Fix the worker image.`
      );
    } else {
      console.warn(
        `[free-tier] could not measure ${input.localPath} for job ` +
          `${input.jobId} (${probe.reason}); keeping the submitted duration`
      );
    }
    return;
  }

  // Int? column, float from the probe. Rounded rather than ceiled, to match
  // what the submit path writes into the reservation - a ceil here and a round
  // there would make a corrected row differ from an uncorrected one by a second
  // for no reason anyone could later explain.
  const measuredSeconds = Math.round(probe.durationSec);
  await prisma.job.update({
    where: { id: input.jobId },
    data: { sourceDurationSec: measuredSeconds },
  });

  // The ledger row, not the user's plan, is what says this job is on the free
  // allowance - see findFreeCharge. Null here means a paying account, and there
  // is nothing to check or correct.
  const charge = await findFreeCharge(input.userId, input.jobId);
  if (!charge) return;

  // CHECK FIRST, CORRECT AFTER - not the other way round.
  //
  // The reservation on the ledger is a placeholder: zero for an upload, the
  // metadata figure for a URL. Either way this job's own charge has already
  // been subtracted from the balance, so comparing the measured duration
  // against freeBalanceSeconds alone would double-count it for a URL job and
  // measure an upload against a balance that pretends the upload is free. The
  // headroom this job actually has is the balance with its own reservation
  // added back.
  //
  // The alternative - write the measured seconds into the row and then ask
  // whether the balance went negative - was rejected for two reasons. It leaves
  // a window in which the ledger holds a charge that was never approved: a
  // worker killed between the write and the verdict (a redeploy, an OOM, a
  // stalled-job takeover) leaves the account charged for a job that never ran
  // and no refund written, because the refund only happens on the branch we
  // never reached. Checking first fails the other way - the crash leaves the
  // pessimistic, uncorrected row, which the user's next job or a finalize can
  // still settle. And freeBalanceSeconds clamps at zero, so once an
  // over-length correction is written the overrun is unrecoverable: the balance
  // reads 0 whether the video was one minute over or five hours over, and the
  // diagnostic below could not say by how much.
  const headroomSeconds = (await freeBalanceSeconds(input.userId)) + charge.seconds;

  if (measuredSeconds > headroomSeconds) {
    // Refund BEFORE the throw, so the allowance is back whatever happens to the
    // stage afterwards. The order is safe in both directions: refundFailedJob
    // is idempotent through the unique index, and this verdict is deterministic
    // across all three BullMQ attempts (same file, same probe, same balance),
    // so there is no attempt on which this job could still succeed after being
    // refunded. That is the property that makes refunding here correct and
    // refunding from a generic markJobFailed wrong.
    await refundFailedJob(input.userId, input.jobId);
    throw new FreeAllowanceExceededError(
      `free allowance exceeded: source measured ${measuredSeconds}s, ` +
        `account has ${headroomSeconds}s of free allowance left ` +
        `(reservation of ${charge.seconds}s refunded)`
    );
  }

  // It fits. Now the row can say what will really be processed, in seconds and
  // in dollars, so the monthly ceiling stops counting an upload as free.
  await reviseFreeChargeSeconds(input.userId, input.jobId, measuredSeconds);
}
