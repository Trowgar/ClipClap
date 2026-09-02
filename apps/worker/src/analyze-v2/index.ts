import OpenAI from "openai";
import type { TranscriptionResult } from "@clipclap/shared";
import { loadAnalyzeConfig, type AnalyzeConfig } from "./config";
import { runQualityLane } from "./quality-lane";
import { buildSentenceGraph } from "./sentence-graph";
import { resolveMode } from "./mode";
import { runScanner } from "./scanner";
import {
  criticBudget,
  mergeCandidates,
  partitionCriticCandidates,
  sourceSeconds,
  type CriticCandidatePartition,
} from "./candidates";
import { AnalyzeTechnicalError } from "./critic";
import { detectTeaserRegion, isInTeaserRegion } from "./teaser";
import { newUsage } from "./llm";
import { dominantScript } from "./language";
import {
  nominateVisualCandidates,
  type VisualRecallNomination,
  type VisualRecallTelemetry,
} from "./visual-candidates";
import type {
  MergedCandidate,
  V2Highlight,
  V2Result,
} from "./types";

const DEGENERATE_MIN_WORDS = 5;
const DEGENERATE_MIN_SPEECH_SEC = 4;
const TINY_MAX_WORDS = 24;

export interface AnalyzeV2Options {
  client?: OpenAI;
  cfg?: AnalyzeConfig;
  transcriptPartial?: boolean;
  /** The job row's source duration, used by analysis-mode resolution. */
  sourceDurationSec?: number;
  /** The job's source URL, mirroring sourceDurationSec above: powers ONLY
   *  resolveAnalysisMode's hostname rules (spec 2026-08-19-stream-analyze-
   *  mode, S1) and nothing else. stages/analyze.ts threads job.sourceUrl in;
   *  eval scripts pass nothing, so the corpus never sees the URL-based rules
   *  fire (density fallback can still apply to an eval transcript that
   *  supplies sourceDurationSec, same as production). */
  sourceUrl?: string;
  /** Per-second motion signal persisted by TRANSCRIBE. Missing or malformed
   *  data keeps the transcript-first path intact in visual shadow/on modes. */
  motionEnvelope?: number[];
  /** Test hook - forwarded to scanner/critic. */
  retryDelayMs?: number;
  /** Test-only injection point for safe-end telemetry serialization faults.
   * It is applied solely to the detached audit result before its local JSON
   * preflight; it cannot affect clips, finalizer input, or persistence. */
  safeEndAuditTelemetryTestHook?: (telemetry: unknown) => unknown;
}

export interface VisualRecallEvaluation {
  candidates: ReturnType<typeof nominateVisualCandidates>["candidates"];
  nominations: VisualRecallNomination[];
  telemetry: Record<string, unknown>;
}

function countCandidateTypes(candidates: readonly { type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) counts[candidate.type] = (counts[candidate.type] ?? 0) + 1;
  return counts;
}

function visualRecallTelemetry(
  mode: "shadow" | "on",
  visual: {
    candidates: readonly { type: string }[];
    telemetry: VisualRecallTelemetry;
    nominations: VisualRecallNomination[];
  },
): Record<string, unknown> {
  const missing = visual.telemetry.envelopeLength === 0;
  return {
    mode,
    ...visual.telemetry,
    ...(missing ? { reason: "no_motion_envelope" } : {}),
    unionCandidates: 0,
    mergedByType: {},
    criticByType: {},
    nominations: visual.nominations,
  };
}

/** Pure, model-free visual recall evaluation shared by ANALYZE and stage-level
 * observation paths (song/music handling). It intentionally builds its own
 * sentence graph so callers can use it without entering the model pipeline. */
export function evaluateVisualRecall(
  transcription: TranscriptionResult,
  cfg: AnalyzeConfig,
  motionEnvelope: unknown,
): VisualRecallEvaluation | undefined {
  if (cfg.visualRecallMode === "off") return undefined;
  const nodes = buildSentenceGraph(transcription.segments, cfg);
  const visual = nominateVisualCandidates(nodes, motionEnvelope, cfg);
  return {
    candidates: visual.candidates,
    nominations: visual.nominations,
    telemetry: visualRecallTelemetry(cfg.visualRecallMode, visual),
  };
}

export async function analyzeHighlightsV2(
  transcription: TranscriptionResult,
  options: AnalyzeV2Options = {}
): Promise<V2Result> {
  const cfg = options.cfg ?? loadAnalyzeConfig();
  const client =
    options.client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const usage = newUsage();
  const partial = options.transcriptPartial ?? false;

  const wordCount = transcription.segments.reduce(
    (sum, s) => sum + (s.words?.length ?? 0),
    0
  );
  const nodes = buildSentenceGraph(transcription.segments, cfg);
  const speechSec = nodes
    .filter((n) => n.hasWords)
    .reduce((sum, n) => sum + (n.end - n.start), 0);
  const visualEvaluation = evaluateVisualRecall(
    transcription,
    cfg,
    options.motionEnvelope ?? [],
  );

  // 0. degenerate guard - zero LLM cost
  if (
    wordCount < DEGENERATE_MIN_WORDS ||
    speechSec < DEGENERATE_MIN_SPEECH_SEC ||
    nodes.every((n) => !n.hasWords)
  ) {
    const visualRecall = visualEvaluation?.telemetry;
    if (visualRecall) visualRecall.unionCandidates = 0;
    return {
      highlights: [],
      noClipsReason: "NO_USABLE_SPEECH",
      telemetry: {
        wordCount,
        speechSec,
        path: "degenerate",
        ...(visualRecall ? { visualRecall } : {}),
      },
      usage,
    };
  }

  // Legacy transcripts (pre-V2) carry no language; fall back to the transcript's
  // dominant script so a Russian video does not get English-prompted copy.
  const languageIso =
    transcription.language ?? scriptFallbackIso(transcription.text);

  // Mode resolution (spec 2026-08-19-stream-analyze-mode, S1): ONCE per job,
  // after speechSec is computed, before the scanner - every stage this task
  // threads it into (scanner, merge, candidate selection, critic) reads this
  // SAME value. cfg.streamModeEnabled is checked again inside resolveMode
  // itself; the flag gate lives there so this call site cannot forget it.
  // The degenerate-guard return above ran before this line and therefore
  // never carries `analysisMode` - only telemetry built after this point
  // does (not-a-key discipline, same as arcAudit).
  //
  // `segments: transcription.segments` (spec 2026-08-25-mid-rescue-and-
  // stream-resolver-v2, part 2): the v2 density fallback needs the RAW
  // segments to compute medianSegmentSec/reliableSegmentShare, which the
  // pre-v2 speechSec/durationSec path never needed - passed unconditionally
  // so the diagnostic telemetry has it too, even on a job that never reaches
  // the density branch (host/live/standard). A SINGLE resolveMode call
  // (review nit: this used to be two separate calls - resolveAnalysisMode
  // then computeModeResolution - each independently re-running the same
  // segment scan and host-rule parse) returns both the mode decision and its
  // telemetry from one resolution, so they can never disagree AND the work
  // is done once per job, not twice.
  const modeInput = {
    sourceUrl: options.sourceUrl,
    durationSec: options.sourceDurationSec,
    speechSec,
    segments: transcription.segments,
  };
  const { mode, modeResolution } = resolveMode(modeInput, cfg);
  let candidates: MergedCandidate[];
  // Retained only for the later outcome-recovery lane. It is deliberately not
  // part of telemetry or the returned result while V4 is inactive.
  let unjudgedCriticCandidates: MergedCandidate[] = [];
  let scannerTelemetry: Record<string, unknown> = {};
  let visualTelemetry: Record<string, unknown> | undefined = visualEvaluation?.telemetry;
  const visualMode = cfg.visualRecallMode;

  if (wordCount <= TINY_MAX_WORDS) {
    // tiny path: the whole transcript is one candidate, no scanner
    const tinyCandidate = {
      id: "c0",
      startNode: 0,
      endNode: nodes.length - 1,
      payoffNode: nodes.length - 1,
      interest: 0.5,
      type: "other",
      windowIndex: 0,
    };
    const visual = visualEvaluation;
    if (visual && visualTelemetry && (visualMode === "shadow" || visualMode === "on")) {
      visualTelemetry.unionCandidates = visualMode === "on" ? visual.candidates.length : 0;
      const tinyMerged = visualMode === "on"
        ? mergeCandidates([tinyCandidate, ...visual.candidates], nodes, cfg, mode)
        : [tinyCandidate];
      visualTelemetry.mergedByType = countCandidateTypes(tinyMerged);
      visualTelemetry.criticByType = countCandidateTypes(tinyMerged);
      candidates = tinyMerged;
    } else {
      candidates = [
        {
          ...tinyCandidate,
          id: "c0",
        },
      ];
    }
    scannerTelemetry = { path: "tiny" };
  } else {
    const scan = await runScanner(
      client,
      usage,
      nodes,
      cfg,
      { retryDelayMs: options.retryDelayMs },
      mode
    );

    // A dead window costs recall (runScanner's contract); EVERY window dead is
    // the analysis models being unavailable, which is a technical failure, not
    // "this video has no good moments". The distinction is the user's quota:
    // a DONE 0-clip job burns their minutes (usage sums every job that is not
    // FAILED), while a FAILED one leaves the quota untouched and BullMQ retries
    // it. Never ship silent emptiness we never actually judged.
    const { windowsTotal, windowsFailed } = scan.telemetry;
    if (windowsTotal > 0 && windowsFailed === windowsTotal) {
      throw new AnalyzeTechnicalError(
        `scanner failed on all ${windowsTotal} windows (${windowsFailed}/${windowsTotal} windows) - analysis models unavailable`
      );
    }

    const visual = visualEvaluation;
    if (visual && visualTelemetry && (visualMode === "shadow" || visualMode === "on")) {
      visualTelemetry.unionCandidates = visualMode === "on" ? visual.candidates.length : 0;
    }
    const rawCandidates = visualMode === "on" && visual
      ? [...scan.candidates, ...visual.candidates]
      : scan.candidates;
    const merged = mergeCandidates(rawCandidates, nodes, cfg, mode);
    if (visualTelemetry) visualTelemetry.mergedByType = countCandidateTypes(merged);
    // Intro montage fragments quote later speech verbatim and are truncated by
    // the source editor, so every clean-start/clean-end guard passes on them.
    // Dropping them HERE - before stratified selection, not after the critic -
    // is what makes it worth doing: perWindowMinCandidates guarantees the first
    // window a share of the critic budget, so a montage would otherwise be
    // guaranteed to spend it on bait (spec 2026-07-24 §1.1, §4.1).
    //
    // The montage is detected ONCE, as a region of the video, and candidates
    // are dropped by where they start - see teaser.ts for why per-candidate
    // similarity was measured unable to do this job.
    //
    // The region is published whether or not it fired, because a filter that
    // deletes candidates leaving no trace makes its own false positives
    // unfalsifiable: nobody ever reports the clip that was never made. A region
    // that ended at 90s on a 10-minute video is a bug you can SEE in a job
    // record. Seconds travel with each dropped id for the same reason - in a
    // production log "c2" alone says nothing, and the first question about a
    // drop is always "what did we cut?".
    const region = detectTeaserRegion(nodes, cfg);
    const teaserDrops: Array<{ id: string; startSec: number; endSec: number }> = [];
    const withoutTeasers = merged.filter((c) => {
      if (!isInTeaserRegion(region, nodes[c.startNode].start)) return true;
      teaserDrops.push({
        id: c.id,
        startSec: Math.round(nodes[c.startNode].start * 10) / 10,
        endSec: Math.round(nodes[c.endNode].end * 10) / 10,
      });
      return false;
    });
    const criticPartition: CriticCandidatePartition = partitionCriticCandidates(
      withoutTeasers,
      nodes,
      cfg,
      mode
    );
    candidates = criticPartition.selected;
    unjudgedCriticCandidates = criticPartition.unselected;
    if (visualTelemetry) visualTelemetry.criticByType = countCandidateTypes(candidates);
    scannerTelemetry = {
      path: "full",
      ...scan.telemetry,
      rawCandidates: scan.candidates.length,
      mergedCandidates: merged.length,
      teaserRegion: region
        ? {
            endSec: Math.round(region.endSec * 10) / 10,
            hits: region.hits,
            firstHitStartSec: Math.round(region.firstHitStartSec * 10) / 10,
            lastHitEndSec: Math.round(region.lastHitEndSec * 10) / 10,
            originSpreadSec: Math.round(region.originSpreadSec),
          }
        : null,
      teaserDrops,
      criticCandidates: candidates.length,
      // The critic budget and what it left on the table. A candidate the strict
      // model never saw is an invisible loss - it looks exactly like a candidate
      // the critic rejected - and the two numbers that explain one are the
      // budget and the size of the pool it was applied to. `criticUnjudgedPool`
      // is deliberately the residual of BOTH rationing rules (the budget K and
      // the per-region diversity cap), because the point of publishing it is to
      // show that something was rationed, not which rule did it. A job record
      // with a large residual is the signal to raise CRITIC_MAX_CANDIDATES.
      criticBudgetK: criticBudget(nodes, cfg),
      criticUnjudgedPool: withoutTeasers.length - candidates.length,
      // Both of them, always, and never only one: these two numbers differ by
      // roughly 2x on a talking-head source (1649 vs 2768 on podcast-answer-arc)
      // and confusing them is what produced the budget defect above.
      // `speechSec` is the audio we can CUT on, `sourceSec` the audio that
      // carries speech at all.
      speechSec: Math.round(speechSec),
      sourceSec: Math.round(sourceSeconds(nodes)),
    };
  }

  // candidates must not span a transcript hole (spec §9) - a clip cut across
  // audio we never heard cannot be verified
  const missingRanges = transcription.missingRanges ?? [];
  let holeDrops = 0;
  if (missingRanges.length > 0) {
    const before = candidates.length;
    candidates = candidates.filter((c) => {
      const startSec = nodes[c.startNode].start;
      const endSec = nodes[c.endNode].end;
      return !missingRanges.some((r) => startSec < r.end && endSec > r.start);
    });
    holeDrops = before - candidates.length;
  }

  if (candidates.length === 0) {
    // Nothing left to judge AND the audio we lost is why: every moment the
    // scanner found straddled a transcript hole and was removed unheard. That
    // is the same unjudged emptiness the scanner and critic guards above catch,
    // so the same quota rule applies - a DONE 0-clip job burns the user's
    // minutes (usage sums every job that is not FAILED) while FAILED leaves the
    // quota untouched and BullMQ retries.
    if (holeDrops > 0) throw unheardAudioError(holeDrops, missingRanges);
    return {
      highlights: [],
      // No hole removed anything: the scanner looked at the audio we heard and
      // found nothing. That is a content answer, and the transcribe stage has
      // already ruled this coverage shippable (TRANSCRIPT_MIN_COVERAGE), so we
      // say so honestly rather than failing a job a retry could never change.
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      telemetry: {
        ...scannerTelemetry,
        keptVerdicts: 0,
        holeDrops,
        // Not-a-key discipline, same as arcAudit: present only when the flag
        // is on. This return runs AFTER mode resolution above, unlike the
        // degenerate guard earlier in this function. modeResolution mirrors
        // analysisMode's own discipline (spec part 2 observability note) -
        // resolveMode already returns modeResolution: undefined when
        // cfg.streamModeEnabled is false, so the explicit cfg check here
        // only keeps this identical in shape to the analysisMode line, it
        // does not change which jobs get the key.
        ...(cfg.streamModeEnabled ? { analysisMode: mode, modeResolution } : {}),
        ...(visualTelemetry ? { visualRecall: visualTelemetry } : {}),
      },
      usage,
    };
  }

  const quality = await runQualityLane({
    lane: "primary",
    candidates,
    nodes,
    languageIso,
    cfg,
    usage,
    client,
    retryDelayMs: options.retryDelayMs,
    analysisMode: mode,
    modeResolution,
    missingRanges,
    transcription,
    sourceDurationSec: options.sourceDurationSec,
    safeEndAuditTelemetryTestHook: options.safeEndAuditTelemetryTestHook,
  });
  const highlights = quality.highlights;
  const telemetry = {
    ...scannerTelemetry,
    ...quality.telemetry,
    ...(visualTelemetry ? { visualRecall: visualTelemetry } : {}),
  };


  if (highlights.length === 0) {
    // Zero clips is only an ANSWER if every candidate actually got answered.
    // The critic's contract is one verdict per candidate id - it has keep:false
    // for "not worth clipping", so a candidate that comes back with no verdict
    // at all was not judged, it was skipped. With survivors that is mere recall
    // loss and we ship what we have; with nothing left it becomes the whole
    // answer, and "no viable moments" would assert something about moments no
    // model ever looked at.
    // Same quota rule as the guards above: DONE with 0 clips burns the user's
    // minutes (usage sums every job that is not FAILED) while FAILED leaves the
    // quota untouched and BullMQ retries - and unlike a cached transcript, a
    // re-run genuinely re-rolls the critic, so the retry can heal this.
    //
    // Deliberately measured as candidates-without-a-verdict, NOT as gate/snap
    // drops: a clip that cannot be snapped to clean boundaries or whose copy is
    // not grounded WAS judged, and our own quality bar rejecting it is the
    // engine working as designed (spec §7-§8). Those keep shipping content
    // reasons. Hole-dropped candidates are excluded too - `candidates` is
    // already post-hole - because a re-run reads the same cached transcript and
    // 4c3fc05 settled that case as content.
    //
    // The sum below is exactly "candidates that never produced a real verdict",
    // and the three terms are the three, mutually exclusive, ways that happens
    // (critic.ts):
    //   - truncatedDrops: dropTruncated() gave up on a batch and put its ids in
    //     accountedDropIds.
    //   - refusalDrops:   dropRefused() did the same.
    //   - omittedDrops:   every remaining candidate with no verdict, computed as
    //     `candidates - verdictIds - accountedDropIds`. Because it subtracts
    //     accountedDropIds it can never re-count the first two, and because it
    //     subtracts verdict IDS (not rows) it DOES already include a candidate
    //     whose only row died in the invariant filter.
    // No candidate lands in two of them: accountedDropIds is filled only by the
    // two terminal drop paths, each of which returns immediately, and the
    // per-batch id guard stops another batch's row from ever answering for a
    // dropped id.
    //
    // invariantDrops is deliberately NOT added. It counts ROWS, not candidates:
    // a hallucinated foreign id belongs to no candidate at all, and a duplicate
    // row belongs to a candidate that already has its verdict. Adding it would
    // invent unjudged candidates that do not exist. (The comment 2bb036b left
    // here claimed malformed rows were the difference between this sum and
    // `candidates.length - verdicts.length`. They are not - a candidate whose
    // row was malformed is counted by both, since it has no verdict id.)
    //
    // Why not `candidates.length - verdicts.length`, which today yields the same
    // number: it only does so as long as candidate ids stay unique and every
    // verdict maps back to an input candidate. It measures the population by
    // accident rather than by name, and it cannot say WHY anything went
    // unjudged, so the error message below could not either. The sum reconciles
    // against telemetry the critic already publishes and each term has its own
    // test.
    //
    // Truncated and refused candidates ARE counted, reversing 2bb036b. Both
    // reasons were "content-shaped anomaly of the candidate, reproduces on a
    // re-run, so failing burns three BullMQ attempts for nothing":
    //   - Truncation does not reliably reproduce. critic.ts's own measurement
    //     note records per-call variance the same order as the budget headroom
    //     (a live run measured 2184 completion tokens at 6/6000, below the 2857
    //     seen at 6/5000), so a candidate that truncates at the margin can
    //     complete on the next roll. a4590ce made this rare, not impossible.
    //   - A refusal may well be the model reacting to the material rather than a
    //     fault, and it may indeed repeat. It is still not a judgement: the
    //     critic said nothing about whether that moment is worth clipping, so
    //     "no viable moments" cannot speak for it. The choice is between a
    //     wasted retry ending in FAILED (free to the user) and billing them for
    //     a claim about material we declined to read.
    // The asymmetry decides it: over-failing costs three cheap retries and a
    // diagnosable error; under-failing takes the user's minutes for an answer
    // that was never obtained. Note the guard needs zero survivors AND a missing
    // candidate, so a video whose moments really were judged still ships its
    // honest "no".
    //
    // ONE error class for all three reasons, and no promotion of any subset to
    // an unrecoverable failure. 6434d4d tried the opposite - refusals being the
    // whole unjudged population raised a distinct error that cancelled the
    // remaining BullMQ attempts - and it was wrong in both directions:
    //   - The predicate was `unjudged === refusalDrops`, i.e. "refusals are the
    //     whole UNJUDGED population", not the whole population. 39 candidates
    //     judged keep:false and 1 refused satisfied it, and the user was told we
    //     could not read their video when 39/40 of it had been read and found
    //     weak - with no attempts left to prove otherwise.
    //   - refusalDrops does not even mean "the model refused this material
    //     twice". critic.ts's catch-all also lands there when the primary model
    //     died with a hard error and the FALLBACK model refused once (see the
    //     note on dropRefused) - an upstream outage, permanently condemning a
    //     good video.
    // Both are the same mistake: asserting something about the cause from a
    // counter that does not carry it. So we assert nothing. Every unjudged
    // population fails the same way, keeps all three attempts, and bills the
    // user nothing - three retries of a cheap failure cost far less than one
    // wrong claim that someone's video is unusable, and the retry can genuinely
    // rescue a refusal too, because the scanner is itself a model call and the
    // next attempt does not present the same candidate windows.
    const t = quality.telemetry as {
      omittedDrops: number;
      truncatedDrops: number;
      refusalDrops: number;
      invariantDrops: number;
    };
    const unjudged = t.omittedDrops + t.truncatedDrops + t.refusalDrops;
    if (unjudged > 0) {
      throw new AnalyzeTechnicalError(
        `no clip survived and ${unjudged} of ${candidates.length} candidate(s) never got a verdict ` +
          `(omitted ${t.omittedDrops}, refused ${t.refusalDrops}, truncated ${t.truncatedDrops}, ` +
          `invariant ${t.invariantDrops}) - the empty result is not a complete answer`
      );
    }

    // Every candidate survived the holes, every one came back with a real
    // verdict, and the emptiness is therefore a judgement - keep:false, or our
    // own evidence/snap/selection bar - made on audio we really heard. Never
    // technical: PARTIAL_TRANSCRIPT tells the user both halves (we lost some
    // audio, and the rest held no strong moments).
    return {
      highlights: [],
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      telemetry,
      usage,
    };
  }

  return { highlights, telemetry, usage };
}

/** Every candidate the scanner found was thrown away for crossing a transcript
 *  hole, so nothing was ever judged and the audio we lost is the reason. That
 *  is the branch's established technical shape ("nothing was judged"), not a
 *  verdict about the video - the same rule the scanner and critic guards apply.
 *
 *  Deliberately NOT triggered by mere partialness. A partial transcript whose
 *  surviving candidates the critic actually judged and rejected is a content
 *  answer about audio we really heard: the transcribe stage has already ruled
 *  that coverage >= TRANSCRIPT_MIN_COVERAGE is good enough to ship clips from,
 *  and PARTIAL_TRANSCRIPT is the user-facing copy for exactly that outcome.
 *  Failing it instead would burn three attempts on a cached transcript that
 *  cannot change and replace translated copy with this engineer prose. */
function unheardAudioError(
  holeDrops: number,
  missingRanges: Array<{ start: number; end: number }>
): AnalyzeTechnicalError {
  const lostSec = Math.round(
    missingRanges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0)
  );
  return new AnalyzeTechnicalError(
    `all ${holeDrops} candidate(s) crossed audio we never heard ` +
      `(${missingRanges.length} missing range(s), ~${lostSec}s lost) - nothing was judged`
  );
}

/** Coarse last-resort language guess for legacy transcripts without a language.
 * New V2 transcripts carry the Whisper-detected ISO code and never hit this. */
function scriptFallbackIso(text: string): string {
  const sample = text.slice(0, 2000);
  switch (dominantScript(sample)) {
    case "cyrillic": return "ru";
    case "arabic": return "ar";
    case "cjk": return "zh";
    default: return "en";
  }
}
