import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  jobService,
  prisma,
  getPlanLimits,
  canSubmitJob,
  recordFunnelEvent,
  uploadRejectedEvent,
  estimatedFreeCostUsd,
  probeVideoUrl,
  FUNNEL_EVENTS,
  type FreeChargeInput,
} from "@clipclap/shared";
import type { User } from "@prisma/client";

export const dynamic = "force-dynamic";

/** How long the submit response is willing to wait on yt-dlp.
 *
 *  A real probe of a real video measured ~1.7s, so this is roughly a five times
 *  margin over the observed case rather than a guess. It is not wrapped in a
 *  withTimeout helper: probeVideoUrl already bounds ITSELF - it kills the child
 *  process on its own timer and passes execFile a hard timeout underneath that -
 *  so the promise it returns cannot hang. Racing a bounded promise against a
 *  second timer would only add a way for the two to disagree. This is the
 *  deliberate difference from the mail send in the register route, which had no
 *  timeout of its own and genuinely needed one bolted on. */
const PROBE_TIMEOUT_MS = 8000;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const body = await req.json();
  const { url, sourceKey, originalFilename, subtitles, sourceDurationSec } = body;

  if (!url && !sourceKey) {
    return NextResponse.json(
      { error: "Provide a video URL or upload a file first" },
      { status: 400 }
    );
  }

  await recordFunnelEvent("web", userId, FUNNEL_EVENTS.VIDEO_SUBMITTED);

  // How long is this video, really?
  //
  // The body used to answer that, which meant the submitter answered it. On a
  // URL submission the field is not even sent, so every pasted link was gated
  // as zero minutes.
  //
  // A URL is measured HERE, before a Job row exists, because `yt-dlp
  // --simulate` reads the metadata without fetching a byte. Without that a
  // three-hour VOD is downloaded in full and only then refused - our bandwidth,
  // our egress, and a cheap way for one person to make us fetch unlimited
  // video on demand.
  //
  // An upload is NOT measured here, and that is not an oversight. The client
  // has already PUT the file to R2 through a presigned URL by the time this
  // route runs, so the bytes are spent either way and there is nothing left to
  // save; measuring it would mean pulling the file back OUT of R2 into the web
  // container to learn something the download stage - which has it on disk and
  // has ffprobe - learns for free. That re-check is what actually protects the
  // OpenAI spend, because money leaves the account at TRANSCRIBE, one stage
  // after DOWNLOAD. Until then the client's number is carried as provisional
  // and nothing but this account's own allowance rests on it.
  let durationSec: number | undefined =
    typeof sourceDurationSec === "number" && sourceDurationSec > 0
      ? sourceDurationSec
      : undefined;

  if (url) {
    const probe = await probeVideoUrl(String(url), PROBE_TIMEOUT_MS);

    if (!probe.ok && probe.reason === "probe-unavailable") {
      // yt-dlp is missing from this container. That is an operational fault,
      // and it must NOT be dressed up as a bad link: telling the user to check
      // a URL that is perfectly fine sends them away doing work that cannot
      // help, and files the incident under "user error" where nobody looks.
      // source-probe has already logged the greppable line.
      console.error(
        `[jobs] URL probe unavailable for user ${userId} - refusing the ` +
          `submission rather than gating on an unmeasured source`
      );
      return NextResponse.json(
        {
          error:
            "We could not check that video just now. This one is on us - please try again in a minute.",
        },
        { status: 500 }
      );
    }

    if (!probe.ok) {
      await recordFunnelEvent("web", userId, uploadRejectedEvent("PROBE_FAILED"));
      return NextResponse.json(
        {
          error:
            "We could not read that link. Make sure it points at a single public video and try again.",
        },
        { status: 400 }
      );
    }

    // The probe's number, not the body's. This is the whole point of the block.
    //
    // Rounded, and that is load-bearing rather than tidy: Job.sourceDurationSec
    // is an Int column and yt-dlp returns a float for plenty of real extractors
    // (archive.org answers 596.46 for a ten-minute item), so handing it through
    // raw makes prisma.job.create throw "Expected Int, provided Float" and turns
    // a perfectly good link into a 500. Rounding once here also keeps the three
    // things that must agree - what we gate on, what we store, and what we
    // charge - reading from a single number.
    durationSec = Math.round(probe.durationSec);
  }

  const durationMinutes =
    typeof durationSec === "number" && durationSec > 0
      ? Math.ceil(durationSec / 60)
      : 0;

  // All limit checks are independent reads - run them in one round trip
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const [user, submission, jobsToday] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    canSubmitJob(userId, durationMinutes),
    prisma.job.count({ where: { userId, createdAt: { gte: dayStart } } }),
  ]);

  // No flat refusal for NONE any more: a never-subscribed account has a free
  // allowance, and canSubmitJob is the single place that decides whether this
  // particular submission fits inside it.
  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");

  // Skipped for the free tier, and only for the free tier.
  //
  // checkFreeTrial already checks length, against the same 60 minutes this line
  // would read, and it says something better: it names the free allowance and
  // points at Starter's 180-minute cap, which is the one sentence in a refusal
  // that gives someone a reason to pay. This check firing first replaced that
  // with "Trim before uploading" and filed the refusal under `too_long`, so
  // `upload_rejected_free_too_long` read as permanently zero and the funnel
  // could not show how often length is what stops people.
  //
  // Not reordered wholesale, deliberately. Running the submission check first
  // for everyone would reclassify a paid account over its plan's source cap
  // from TOO_LONG to QUOTA, and TOO_LONG is the truer answer there - a 200
  // minute source is refused for its length whatever minutes are left.
  if (!isOnFreeTier(user) && durationMinutes > limits.maxSourceDurationMinutes) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("TOO_LONG"));
    return NextResponse.json(
      {
        error: `Source exceeds max duration (${limits.maxSourceDurationMinutes} min). Trim before uploading.`,
      },
      { status: 400 }
    );
  }

  if (!submission.allowed) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent(submission.code));
    return NextResponse.json({ error: submission.reason }, { status: 402 });
  }

  if (jobsToday >= limits.maxJobsPerDay) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("DAILY_LIMIT"));
    return NextResponse.json(
      {
        error: `Daily job limit reached (${limits.maxJobsPerDay}). Try again tomorrow or upgrade.`,
      },
      { status: 429 }
    );
  }
  // The concurrency limit is NOT checked here any more, and the count that used
  // to sit beside jobsToday above is gone with it.
  //
  // Counting in flight jobs in this route and creating the job three statements
  // later is a read-then-write with no serialisation: six simultaneous uploads
  // on one free account all read zero, all passed this check, and all created -
  // six jobs and six reservations against a limit of one, reproduced against
  // prod. Moving the check inside createJob's transaction, under a per-user
  // advisory lock, is what makes it hold. Doing it in BOTH places would not be
  // belt and braces; it would be a second definition of the limit that can
  // disagree with the one that decides.
  // WRAPPED, because this call can fail for reasons that are not refusals and
  // an uncaught one here is worse than it looks. It reaches the browser as a
  // bare 500 with no copy, and - the part that hid it for a day - it writes NO
  // `upload_rejected_*` row, because every one of those is written by a branch
  // that returns rather than throws. A submission that dies in here is
  // therefore invisible on /admin: the funnel shows `video_submitted` and then
  // nothing, which reads exactly like a user who changed their mind.
  //
  // Reproduced: holding the account's advisory lock in psql made this throw
  // PrismaClientKnownRequestError P2028 after 22.7 seconds.
  let created: Awaited<ReturnType<typeof jobService.createJob>>;
  try {
    created = await jobService.createJob({
      userId,
      sourceUrl: url || undefined,
      sourceKey: sourceKey || undefined,
      originalFilename: originalFilename || undefined,
      subtitles: subtitles !== false,
      sourceDurationSec: durationSec,
      freeCharge: freeChargeFor(user, durationSec),
    });
  } catch (error) {
    console.error(`[jobs] createJob threw for user ${userId}:`, error);
    await recordFunnelEvent("web", userId, uploadRejectedEvent("SUBMIT_FAILED"));
    return NextResponse.json(
      {
        error:
          "We could not start that job. This one is on us - please try again in a minute.",
      },
      { status: 500 }
    );
  }

  if (created.status === "concurrent_limit") {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("CONCURRENT"));
    return NextResponse.json(
      {
        error: `You have ${created.inFlight} active jobs (limit: ${created.limit}). Wait for one to finish.`,
      },
      { status: 429 }
    );
  }

  // Contention on this account's own submit lock. 429 rather than 500 because
  // nothing is broken and retrying is the correct next action - which is also
  // what the copy says, without inventing a count we do not have.
  if (created.status === "busy") {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("BUSY"));
    return NextResponse.json(
      {
        error:
          "Another submission from your account is still going through. Give it a moment and try again.",
      },
      { status: 429 }
    );
  }

  return NextResponse.json(created.job, { status: 201 });
}

/**
 * Is this account running on the free allowance?
 *
 * ONE definition, used by both the checks that care, because they have to agree:
 * the route hands length refusals to checkFreeTrial for exactly the accounts it
 * writes a ledger row for. Two copies of this condition would eventually drift
 * and leave an account gated on one basis and charged on another.
 *
 * The plan/status PAIR is checked, never the derived subscription phase, and it
 * is the same pair canSubmitJob uses to route into checkFreeTrial. `plan ===
 * "NONE"` alone is not enough: a canceled ex-subscriber whose plan was reset
 * back to NONE keeps a non-NONE subscriptionStatus, and treating them as free
 * here would put a paid customer's job into the free ledger, where the monthly
 * budget would count it as free spend and trueUpFreeCost would later rewrite a
 * row that was never the free tier's.
 */
function isOnFreeTier(user: Pick<User, "plan" | "subscriptionStatus">): boolean {
  return user.plan === "NONE" && user.subscriptionStatus === "NONE";
}

/** The reservation to write with the Job row, or undefined for a paying
 *  account. */
function freeChargeFor(
  user: Pick<User, "plan" | "subscriptionStatus">,
  durationSec: number | undefined
): FreeChargeInput | undefined {
  if (!isOnFreeTier(user)) return undefined;

  // Rounded, not ceiled: this is the ledger's record of what was measured, and
  // the gate above has already decided the submission fits. An upload arrives
  // with 0 here - unknown until the download stage measures it - and a
  // zero-second CHARGE row is the right thing to write, because it is the row
  // the download-stage re-check will find and correct. No row at all would
  // leave nothing to correct.
  //
  // The SECONDS are zero; the USD are not. estimatedFreeCostUsd floors an
  // unknown length at the flat per-run charge, so an upload holds a real
  // reservation against the monthly ceiling from the moment it is submitted.
  // It used to hold 0.00, which is the same as holding nothing.
  const seconds = durationSec && durationSec > 0 ? Math.round(durationSec) : 0;

  return { seconds, estimatedCostUsd: estimatedFreeCostUsd(seconds) };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobs = await jobService.getUserJobs(session.user.id);
  return NextResponse.json(jobs);
}
