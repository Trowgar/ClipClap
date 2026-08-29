import OpenAI from "openai";
import type { TranscriptionResult } from "@clipclap/shared";
import { loadAnalyzeConfig, type AnalyzeConfig } from "./config";
import { buildSentenceGraph } from "./sentence-graph";
import { resolveMode } from "./mode";
import { runScanner } from "./scanner";
import { criticBudget, mergeCandidates, selectCriticCandidates, sourceSeconds } from "./candidates";
import { AnalyzeTechnicalError, runCritic, repairCopy } from "./critic";
import { snapNodes, compressToFit } from "./snap";
import {
  EVIDENCE_BOUNDARY_SLACK_NODES,
  evidenceGate,
  regroundCopy,
  snippetFallbackCopy,
  lexicalOverlap,
} from "./gates";
import { dominantScript, isoToLanguageName, scriptMismatch } from "./language";
import { selectAndOrder } from "./select";
import { rescueShortSource, type RescueTelemetry } from "./rescue";
import { runArcAudit, isFullyOk, type ArcAuditTelemetry } from "./arc-audit";
import { extendClipStarts, type StartExtensionTelemetry } from "./start-extension";
import { extendClipEnds } from "./end-extension";
import { filterStandaloneClips, type StandaloneFilterTelemetry } from "./standalone-filter";
import {
  applyPostBoundaryHookGate,
  type PostBoundaryHookGateTelemetry,
} from "./post-boundary-hook-gate";
import { finalizeClips } from "./finalize";
import { detectTeaserRegion, isInTeaserRegion } from "./teaser";
import { callJsonSchema, newUsage } from "./llm";
import {
  SAFE_END_AUDIT_SYSTEM,
  safeEndAuditForwardContext,
  safeEndAuditUserPrompt,
} from "./safe-end-audit-prompts";
import { SAFE_END_AUDIT_SCHEMA, readSafeEndAuditRow } from "./safe-end-audit-schema";
import {
  capSafeEndNormalRecords,
  safeEndGeometryReference,
  type SafeEndAuditFailureCode,
  type SafeEndNormalRecord,
} from "./safe-end-audit";
import type {
  ArcFlags,
  MergedCandidate,
  SnappedClip,
  V2Highlight,
  V2Result,
} from "./types";

const DEGENERATE_MIN_WORDS = 5;
const DEGENERATE_MIN_SPEECH_SEC = 4;
const TINY_MAX_WORDS = 24;

interface SafeEndNormalTelemetry {
  evaluated: number;
  safe: number;
  needs_afterbeat: number;
  hard_handoff: number;
  not_evaluable: number;
  audit_failed: number;
  records: SafeEndNormalRecord[];
  truncatedCount: number;
}

interface SafeEndAuditTelemetry {
  normal: SafeEndNormalTelemetry;
}

/** Converts the feature's local telemetry into the exact JSON-safe form that
 * can be merged into ANALYZE output. This deliberately does not surround any
 * shared job-step persistence: only safe-end observation data is fail-open. */
function jsonSafeEndAuditTelemetry(
  telemetry: unknown,
  clips: readonly SnappedClip[]
): SafeEndAuditTelemetry {
  try {
    const serialized = JSON.stringify(telemetry);
    if (typeof serialized !== "string") throw new Error("safe-end telemetry did not serialize");
    return JSON.parse(serialized) as SafeEndAuditTelemetry;
  } catch {
    return { normal: failedSafeEndNormalTelemetry(clips, "construction_error") };
  }
}

function emptySafeEndNormalTelemetry(): SafeEndNormalTelemetry {
  return {
    evaluated: 0,
    safe: 0,
    needs_afterbeat: 0,
    hard_handoff: 0,
    not_evaluable: 0,
    audit_failed: 0,
    records: [],
    truncatedCount: 0,
  };
}

function safeEndFailureCode(
  failure: { kind: "truncated" | "refusal" | "error"; error?: string }
): SafeEndAuditFailureCode {
  if (failure.kind === "refusal") return "model_refusal";
  // OpenAI's SDK calls this `APIConnectionTimeoutError` and uses the exact
  // message "Request timed out."; other transport layers commonly say
  // "timeout". Both are operational timeouts, not feature construction bugs.
  if (failure.kind === "error" && /timeout|timed out/i.test(failure.error ?? "")) {
    return "timeout";
  }
  if (failure.kind === "error") return "construction_error";
  return "malformed_response";
}

function failedSafeEndNormalTelemetry(
  clips: readonly SnappedClip[],
  code: SafeEndAuditFailureCode
): SafeEndNormalTelemetry {
  const telemetry = emptySafeEndNormalTelemetry();
  telemetry.evaluated = clips.length;
  telemetry.audit_failed = clips.length;
  try {
    const records: SafeEndNormalRecord[] = clips.map((clip) => ({
      geometry: safeEndGeometryReference(clip),
      score: clip.verdict.score,
      language: clip.verdict.language,
      ...(clip.verdict.kind ? { kind: clip.verdict.kind } : {}),
      outcome: "audit_failed",
      reason: null,
      failureCode: code,
      extendToNode: null,
    }));
    const capped = capSafeEndNormalRecords(records);
    telemetry.records = capped.records;
    telemetry.truncatedCount = capped.truncatedCount;
  } catch {
    // Even a broken telemetry record must not turn an observation feature into
    // a job failure. The aggregate remains a closed audit_failed result.
    telemetry.truncatedCount = clips.length;
  }
  return telemetry;
}

/**
 * Isolated observation runner. It returns only privacy-safe records, never a
 * flag map or a replacement clip list. Any feature-local failure is converted
 * to a closed row and intentionally cannot interrupt the shared pipeline.
 */
async function runSafeEndNormalAudit(
  client: OpenAI,
  usage: import("./types").LlmUsage,
  clips: SnappedClip[],
  nodes: import("./types").SentenceNode[],
  cfg: AnalyzeConfig,
  options: { retryDelayMs?: number }
): Promise<SafeEndAuditTelemetry> {
  try {
    if (clips.length === 0) return { normal: emptySafeEndNormalTelemetry() };
    const response = await callJsonSchema<{ results?: unknown }>(client, usage, {
      model: cfg.criticModel,
      system: SAFE_END_AUDIT_SYSTEM,
      user: safeEndAuditUserPrompt(clips, nodes),
      schema: SAFE_END_AUDIT_SCHEMA,
      reasoningEffort: cfg.reasoningEffort,
      maxOutputTokens: 800 + 120 * clips.length,
      retryDelayMs: options.retryDelayMs,
    });
    if (!response.ok) return { normal: failedSafeEndNormalTelemetry(clips, safeEndFailureCode(response)) };

    const rawRows = response.data?.results;
    if (!Array.isArray(rawRows)) {
      return { normal: failedSafeEndNormalTelemetry(clips, "malformed_response") };
    }
    const rows = rawRows.map(readSafeEndAuditRow);
    const expectedIds = new Set(clips.map((clip) => clip.verdict.id));
    const seen = new Set<string>();
    if (
      rows.some((row) => row === null || !expectedIds.has(row.id) || seen.has(row.id) || !seen.add(row.id)) ||
      seen.size !== clips.length
    ) {
      return { normal: failedSafeEndNormalTelemetry(clips, "malformed_response") };
    }

    const clipById = new Map(clips.map((clip) => [clip.verdict.id, clip]));
    const telemetry = emptySafeEndNormalTelemetry();
    const records: SafeEndNormalRecord[] = [];
    for (const row of rows) {
      if (!row) return { normal: failedSafeEndNormalTelemetry(clips, "malformed_response") };
      const clip = clipById.get(row.id);
      if (!clip) return { normal: failedSafeEndNormalTelemetry(clips, "malformed_response") };
      if (
        row.outcome === "needs_afterbeat" &&
        !safeEndAuditForwardContext(clip, nodes).some((node) => node.index === row.extendToNode)
      ) {
        return { normal: failedSafeEndNormalTelemetry(clips, "malformed_response") };
      }
      telemetry.evaluated += 1;
      telemetry[row.outcome] += 1;
      records.push({
        geometry: safeEndGeometryReference(clip),
        score: clip.verdict.score,
        language: clip.verdict.language,
        ...(clip.verdict.kind ? { kind: clip.verdict.kind } : {}),
        outcome: row.outcome,
        reason: row.reason,
        extendToNode: row.extendToNode,
      });
    }
    const capped = capSafeEndNormalRecords(records);
    telemetry.records = capped.records;
    telemetry.truncatedCount = capped.truncatedCount;
    return { normal: telemetry };
  } catch {
    // This is deliberately narrower than a JobStep write: this catch protects
    // only feature-local prompt, parsing, and telemetry construction.
    return { normal: failedSafeEndNormalTelemetry(clips, "construction_error") };
  }
}

export interface AnalyzeV2Options {
  client?: OpenAI;
  cfg?: AnalyzeConfig;
  transcriptPartial?: boolean;
  /** The job row's source duration. Powers the short-source rescue's "is this
   *  short" test (spec 2026-08-19-short-source-rescue) and NOTHING else -
   *  callers that omit it (every eval script) get byte-identical behaviour
   *  with the rescue permanently dark, which is what keeps the corpus
   *  comparable across runs. */
  sourceDurationSec?: number;
  /** The job's source URL, mirroring sourceDurationSec above: powers ONLY
   *  resolveAnalysisMode's hostname rules (spec 2026-08-19-stream-analyze-
   *  mode, S1) and nothing else. stages/analyze.ts threads job.sourceUrl in;
   *  eval scripts pass nothing, so the corpus never sees the URL-based rules
   *  fire (density fallback can still apply to an eval transcript that
   *  supplies sourceDurationSec, same as production). */
  sourceUrl?: string;
  /** Test hook - forwarded to scanner/critic. */
  retryDelayMs?: number;
  /** Test-only injection point for safe-end telemetry serialization faults.
   * It is applied solely to the detached audit result before its local JSON
   * preflight; it cannot affect clips, finalizer input, rescue, or persistence. */
  safeEndAuditTelemetryTestHook?: (telemetry: unknown) => unknown;
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

  // 0. degenerate guard - zero LLM cost
  if (
    wordCount < DEGENERATE_MIN_WORDS ||
    speechSec < DEGENERATE_MIN_SPEECH_SEC ||
    nodes.every((n) => !n.hasWords)
  ) {
    return {
      highlights: [],
      noClipsReason: "NO_USABLE_SPEECH",
      telemetry: { wordCount, speechSec, path: "degenerate" },
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
  let scannerTelemetry: Record<string, unknown> = {};

  if (wordCount <= TINY_MAX_WORDS) {
    // tiny path: the whole transcript is one candidate, no scanner
    candidates = [
      {
        id: "c0",
        startNode: 0,
        endNode: nodes.length - 1,
        payoffNode: nodes.length - 1,
        interest: 0.5,
        type: "other",
        windowIndex: 0,
      },
    ];
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

    const merged = mergeCandidates(scan.candidates, nodes, cfg, mode);
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
    candidates = selectCriticCandidates(withoutTeasers, nodes, cfg, mode);
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
      },
      usage,
    };
  }

  const critic = await runCritic(
    client,
    usage,
    nodes,
    candidates,
    languageIso,
    cfg,
    { retryDelayMs: options.retryDelayMs },
    mode
  );

  // A critic that judged the candidates and rejected them returns REAL verdicts
  // with keep:false - that is a content outcome and falls through below. Zero
  // verdicts for a non-empty candidate set means nothing was judged at all: the
  // API answered but every row was empty/unknown/invalid, or every batch was
  // refused. Same quota rule as the scanner guard above: shipping DONE with 0
  // clips burns the user's minutes (usage sums every job that is not FAILED)
  // for output no model ever looked at, while FAILED leaves the quota untouched
  // and BullMQ retries. Never ship unjudged emptiness.
  //
  // One failure class for every reason, refusals included - see the zero-
  // survivor guard far below for why. The counts still travel in the message,
  // so a failed job stays diagnosable without the shape of the hole deciding
  // anything the user hears.
  if (critic.verdicts.length === 0) {
    const t = critic.telemetry;
    throw new AnalyzeTechnicalError(
      `critic produced 0 usable verdicts for ${candidates.length} candidates ` +
        `(omitted ${t.omittedDrops}, refused ${t.refusalDrops}, truncated ${t.truncatedDrops}, ` +
        `invariant ${t.invariantDrops}) - nothing was judged`
    );
  }

  // eligibility: keep + evidence gate + snap + copy language
  const eligible: SnappedClip[] = [];
  let evidenceDrops = 0;
  let evidenceWidened = 0;
  let snapDrops = 0;
  let copyRepairs = 0;
  let snippetFallbacks = 0;
  // Silent copy replacements, at both points where the code stops moving
  // boundaries. Like every other loss in this engine it has to leave a trace in
  // the job record: nobody reports the description they never saw, and this
  // fires precisely when something upstream already went wrong.
  const copyRegrounded: Array<{ id: string; at: "snap" | "shipped"; fields: string[] }> = [];
  /**
   * Ids whose TITLE is, right now, verbatim transcript speech the ENGINE wrote -
   * `snippetFallbackCopy` output, not a model's sentence. See the repair pass
   * after the finalizer for why this is tracked by provenance rather than by the
   * shape of the string.
   *
   * A set, not a flag on the clip, because membership is not monotonic: the
   * finalizer's title rewrite takes a clip back OUT of it, and that removal is
   * the whole reason the pass below costs one call on these fixtures instead of
   * two.
   */
  const snippetTitleIds = new Set<string>();
  /** Ids that have already spent their one repairCopy call, wherever it was
   *  spent. The bound is per CLIP and global, not per site. */
  const copyRepairAttempted = new Set<string>();
  const snippetTitleRepairs: Array<{
    id: string;
    from: string;
    to: string | null;
    outcome: "repaired" | "unusable" | "already_repaired";
  }> = [];
  const gateDropReasons: Record<string, number> = {};
  /**
   * Copy the critic grounded outside its own proposed range, by field. NOT a
   * drop - `regroundCopy` repairs it below - and deliberately a SEPARATE counter
   * from gateDropReasons, which means "this clip is gone" and must keep meaning
   * exactly that. Kept because it is a direct measure of critic-prompt drift: the
   * ca8dfec title rule took it from 2 to 9 across the eval suite in one commit.
   */
  const evidenceOutOfRange: Record<string, number> = {};
  const droppedVerdicts: Array<{ id: string; stage: string; reason: string; score: number }> = [];

  for (const verdict of critic.verdicts) {
    if (!verdict.keep) continue;

    // Evidence just past the chosen boundary is a boundary problem, not a
    // grounding failure: widen the range to contain its own evidence (snap
    // re-validates clean start, invariants and the 90s cap afterwards). Evidence
    // FURTHER out is a copy problem - the gate below reports it and regroundCopy
    // replaces the field - so between them nothing here can cost a clip.
    if (widenRangeToEvidence(verdict, nodes.length - 1)) evidenceWidened += 1;

    const gate = evidenceGate(verdict, nodes);
    if (!gate.ok) {
      evidenceDrops += 1;
      const reason = gate.reason ?? "unknown";
      gateDropReasons[reason] = (gateDropReasons[reason] ?? 0) + 1;
      droppedVerdicts.push({ id: verdict.id, stage: "gate", reason, score: verdict.score });
      continue;
    }
    for (const label of gate.outOfRange ?? []) {
      const key = `${label}_evidence_out_of_range`;
      evidenceOutOfRange[key] = (evidenceOutOfRange[key] ?? 0) + 1;
    }
    const snapped = snapNodes(verdict, nodes, cfg);
    if (!snapped.ok) {
      snapDrops += 1;
      droppedVerdicts.push({ id: verdict.id, stage: "snap", reason: snapped.reason, score: verdict.score });
      continue;
    }

    // The evidence gate above judged the critic's PROPOSED range; snap has just
    // moved the boundaries. Re-checking HERE, and not only after the finalizer,
    // is what lets the judge repair the damage: the finalizer is the one stage
    // that rewrites a title against the whole speech, so a clip whose copy this
    // pass reduces to a verbatim snippet still has a chance of a good one.
    const reground = regroundCopy(snapped.clip, nodes);
    if (reground.regrounded.length > 0) {
      copyRegrounded.push({ id: verdict.id, at: "snap", fields: reground.regrounded });
    }
    if (reground.regrounded.includes("title")) snippetTitleIds.add(verdict.id);
    const clip = reground.clip;

    // The clip's OWN speech - snap's range, not the critic's proposal, because
    // that is the text the viewer hears and the text the copy must match.
    const clipText = nodes
      .slice(clip.finalStartNode, clip.finalEndNode + 1)
      .filter((n) => n.hasWords)
      .map((n) => n.text)
      .join(" ");
    const copy = clip.verdict;
    if (scriptMismatch(`${copy.title} ${copy.description}`, clipText)) {
      copyRepairs += 1;
      copyRepairAttempted.add(verdict.id);
      const repaired = await repairCopy(client, usage, nodes, copy, languageIso, cfg, {
        retryDelayMs: options.retryDelayMs,
      });
      if (repaired && !scriptMismatch(`${repaired.title} ${repaired.description}`, clipText)) {
        copy.title = repaired.title;
        copy.description = repaired.description;
        snippetTitleIds.delete(verdict.id);
      } else {
        snippetFallbacks += 1;
        const snippet = snippetFallbackCopy(nodes, clip.finalStartNode, clip.finalEndNode);
        copy.title = snippet.title;
        copy.description = snippet.description;
        snippetTitleIds.add(verdict.id);
      }
    }
    eligible.push(clip);
  }

  // Selection hands FINALIZE more clips than the job ships. The finalizer is the
  // only component that sees the shipped set AS A SET - it dedups, trims and
  // vetoes - and every veto it lands would otherwise come straight out of the
  // user's clip count. The headroom absorbs them without a second LLM round
  // (spec §3, §9: backfilling from fresh candidates was rejected for that cost).
  const selection = selectAndOrder(eligible, cfg, cfg.softCap + cfg.finalizerHeadroom);

  // ARC AUDIT (spec 2026-08-10, task 2) - runs after selection, before the
  // extension that moves ends and the finalizer that trims starts, so it
  // judges the set exactly as those two stages will receive it. PURE
  // DETECTOR in this task: flags and telemetry only, ZERO boundary moves - see
  // arc-audit.ts. Gated on cfg.arcAuditEnabled here AND inside runArcAudit
  // itself (defence in depth, the same doubling extendClipEnds uses), so a
  // dark run never spends a call and never adds a key: not `arcAudit` in
  // telemetry, not `_arcFlags` on a highlight (below). The dark-stage control
  // in the eval suite depends on that being literally true, not merely
  // zeroed.
  let arcFlags: Map<string, ArcFlags> = new Map();
  let arcAuditTelemetry: ArcAuditTelemetry | undefined;
  if (cfg.arcAuditEnabled) {
    const audit = await runArcAudit(client, usage, selection.selected, nodes, cfg, {
      retryDelayMs: options.retryDelayMs,
    });
    arcFlags = audit.flags;
    arcAuditTelemetry = audit.telemetry;
  }

  // LONG-CLIP POLICY (spec 2026-08-10 §2e, task 5) - the owner's two
  // conditions in code: a clip ships over maxSec only as an EXPLICIT
  // finalizer decision (the LENGTH EXCEPTION line finalizerUserPrompt renders
  // for a clip still marked `overLength` when it reaches that stage) and only
  // on material arcAudit judged clean on all three axes. Runs HERE - after
  // arcAudit, before extendClipStarts - so every later stage sees the
  // resolved set: a BLESSED clip (arc-audit.ts's isFullyOk) travels wide
  // unchanged; everything else is compressed back under maxSec by the SAME
  // walk snapNodes itself would have run at ship time (`compressToFit`,
  // extracted from snap.ts for exactly this reuse), or dropped when even that
  // fails - a drop that shows in `droppedVerdicts` like any other.
  //
  // With ARC_AUDIT off, arcFlags is always the empty map from above, so
  // isFullyOk is always false and every overLength clip is compressed right
  // here - LONG_CLIPS alone degrades to today's unconditional snap-time
  // compression, just deferred one stage. The dependency is deliberate and
  // visible in this `isFullyOk` call, not implied by an empty map (the same
  // discipline extendClipStarts/extendClipEnds use for their own dependency
  // on arcAuditEnabled).
  //
  // KNOWN ASYMMETRY, documented rather than fixed (spec 2026-08-10 task 5
  // hard rules: do not touch NMS semantics): selection.selected already ran
  // NMS at the clip's WIDE size for an overLength clip snap deferred, before
  // this policy has decided blessed/compressed/dropped - the same
  // already-accepted asymmetry start-extension.ts's own NMS collision gate
  // documents for a post-hoc widening. A clip this policy later compresses or
  // drops already occupied its NMS footprint at the wide size while competing
  // for a selection slot.
  let longClipsTelemetry:
    | { overLength: number; blessed: number; compressed: number; dropped: number }
    | undefined;
  let afterLongClipPolicy = selection.selected;
  if (cfg.longClipsEnabled) {
    const t = { overLength: 0, blessed: 0, compressed: 0, dropped: 0 };
    const resolved: SnappedClip[] = [];
    for (const clip of selection.selected) {
      if (!clip.overLength) {
        resolved.push(clip);
        continue;
      }
      t.overLength += 1;
      if (isFullyOk(arcFlags.get(clip.verdict.id))) {
        t.blessed += 1;
        resolved.push(clip);
        continue;
      }
      const compressed = compressToFit(
        { startNode: clip.finalStartNode, endSec: clip.endSec, hookStartNode: clip.verdict.hookStartNode },
        nodes,
        cfg
      );
      if (compressed.ok) {
        t.compressed += 1;
        resolved.push({
          ...clip,
          startSec: compressed.startSec,
          finalStartNode: compressed.startNode,
          overLength: false,
          shortMoment: clip.endSec - compressed.startSec < cfg.targetMinSec,
        });
      } else {
        t.dropped += 1;
        droppedVerdicts.push({
          id: clip.verdict.id,
          stage: "long_clip_policy",
          reason: "too_long",
          score: clip.verdict.score,
        });
      }
    }
    afterLongClipPolicy = resolved;
    longClipsTelemetry = t;
  }

  // START EXTENSION (spec 2026-08-10 task 3) - widen-only, backward-only,
  // fed EXCLUSIVELY by arcAudit's gated entry.fixStartNode pointers. No model
  // call of its own: arc-audit already asked and gated once, so this is
  // deterministic application. ORDER: widen-start -> widen-end -> finalizer
  // trims last - the finalizer keeps the last word on every boundary either
  // extension stage touches, same load-bearing order as end-extension alone.
  // BOTH flags, explicitly, mirroring the guard inside extendClipStarts
  // itself (defence in depth) - the dependency on arcAuditEnabled has to be
  // visible here, not merely implied by arcFlags happening to be empty.
  //
  // Fed `afterLongClipPolicy`, not `selection.selected` directly: the policy
  // above already resolved every overLength clip before this stage (or any
  // later one) ever sees it. When LONG_CLIPS is off the two are the same
  // array.
  let startExtensionTelemetry: StartExtensionTelemetry | undefined;
  let afterStartExtension = afterLongClipPolicy;
  if (cfg.arcAuditEnabled && cfg.startExtensionEnabled) {
    const started = extendClipStarts(afterLongClipPolicy, arcFlags, nodes, cfg);
    afterStartExtension = started.clips;
    startExtensionTelemetry = started.telemetry;
  }

  // Ends move FORWARD here and nowhere else, and only for clips that will ship.
  // Before the finalizer on purpose: the finalizer is the stage that trims, and
  // it must get the last word on a boundary. Widening cannot invalidate copy -
  // evidence already inside the range stays inside a larger one - so this needs
  // no regroundCopy re-run, which is exactly why it is safe here and would not
  // be if it could shorten.
  //
  // `arcFlags` (spec 2026-08-10 task 4) is the SAME map start-extension read
  // above - possibly empty, possibly populated by arcAudit above. Whether it
  // does anything to this stage's offered set is decided entirely inside
  // end-extension.ts by cfg.endExtensionHintsEnabled (independent of
  // cfg.endExtensionEnabled, the pre-existing self-motivated switch), so no
  // extra gate is needed at this call site - unlike start-extension, this
  // stage's OWN top-of-function guard already covers "neither switch is on".
  // Capture end nodes at the exact boundary before this stage. The gate's
  // provenance is about the clip geometry that survives extension, not what
  // the critic proposed or what an audit inferred.
  const endNodeBeforeExtension = new Map(
    afterStartExtension.map((clip) => [clip.verdict.id, clip.finalEndNode])
  );
  const extension = await extendClipEnds(
    client,
    usage,
    afterStartExtension,
    arcFlags,
    nodes,
    cfg,
    { retryDelayMs: options.retryDelayMs }
  );
  const endExtensionAppliedById = new Map(
    extension.clips.map((clip) => [
      clip.verdict.id,
      endNodeBeforeExtension.get(clip.verdict.id) !== clip.finalEndNode,
    ])
  );

  // LONG-CLIP SWEEP (spec 2026-08-10 task 5, follow-up) - closes an asymmetry
  // the task 5 report flagged: a clip that started at or under maxSec but
  // crossed it via a blessed-ceiling widening in EITHER extension stage
  // reached the finalizer with no `overLength` mark, so the owner's first
  // condition - a long clip ships only as an EXPLICIT finalizer decision -
  // silently failed for it (no LENGTH EXCEPTION line, no ratification).
  //
  // One sweep, right here, between both extension stages and the finalizer,
  // UNCONDITIONAL - no cfg.longClipsEnabled guard. With the flag off this is
  // a PROVABLE no-op: start-extension's and end-extension's own too_long
  // gates both read `cfg.longClipsEnabled && blessed` to pick their ceiling
  // (start-extension.ts's/end-extension.ts's own fitsMaxSec), so with the
  // flag off the ceiling is always cfg.maxSec and neither stage can hand this
  // loop a clip whose span exceeds it - nor can snapNodes, which already
  // enforced maxSec unconditionally before either stage ever ran. So the
  // predicate below can only ever fire on a clip a blessed-ceiling widening
  // actually produced, which by construction requires `cfg.longClipsEnabled`
  // to already be true.
  //
  // Composes with finalize.ts's defence-in-depth gate without contradiction:
  // reaching a widened span past maxSec required `isFullyOk` (full THREE-axis
  // blessing, not a partial one - see start-extension.ts's/end-extension.ts's
  // own fitsMaxSec) at the widening gate itself, so every clip this sweep
  // marks is already blessed by the same definition finalize.ts's gate reads,
  // and that gate ships it wide rather than compressing it.
  const beforeFinalize = extension.clips.map((clip) =>
    clip.overLength || clip.endSec - clip.startSec <= cfg.maxSec
      ? clip
      : { ...clip, overLength: true }
  );

  // POST-BOUNDARY HOOK GATE - evaluates the actual post-extension and
  // post-sweep geometry before any later selection authority. Off is a true
  // no-op: no telemetry key, no candidate filtering, and no rescue exclusion.
  let postBoundaryHookGateTelemetry: PostBoundaryHookGateTelemetry | undefined;
  let afterPostBoundaryHookGate = beforeFinalize;
  const postBoundaryHookGateDroppedIds = new Set<string>();
  let allSelectedClipsDroppedByPostBoundaryHookGate = false;
  if (cfg.postBoundaryHookGateMode !== "off") {
    const gated = applyPostBoundaryHookGate(beforeFinalize, nodes, {
      mode: cfg.postBoundaryHookGateMode,
      maxDelaySec: cfg.postBoundaryHookMaxDelaySec,
      maxPreHookGapSec: cfg.postBoundaryHookMaxPreHookGapSec,
      scoreThreshold: cfg.scoreThreshold,
      targetMinSec: cfg.targetMinSec,
      maxSec: cfg.maxSec,
      provenanceForClip: (clip) => ({
        startRepairApplied: arcFlags.get(clip.verdict.id)?.entry.repaired === true,
        endExtensionApplied: endExtensionAppliedById.get(clip.verdict.id) === true,
      }),
    });
    afterPostBoundaryHookGate = gated.clips;
    postBoundaryHookGateTelemetry = gated.telemetry;
    allSelectedClipsDroppedByPostBoundaryHookGate =
      beforeFinalize.length > 0 && gated.drops.length === beforeFinalize.length;
    for (const drop of gated.drops) {
      postBoundaryHookGateDroppedIds.add(drop.id);
      droppedVerdicts.push({
        id: drop.id,
        stage: "post_boundary_hook_gate",
        reason: drop.reasons.join("+"),
        score: critic.verdicts.find((verdict) => verdict.id === drop.id)?.score ?? 0,
      });
    }
  }

  // SAFE-END SHADOW AUDIT (V1) - observes the exact post-extension,
  // post-long-clip and post-hook-gate geometry at the last seam before any
  // downstream authority. It intentionally receives the same array arc
  // downrank will receive, but never replaces, reorders, flags, or otherwise
  // changes it. This is a separate schema and telemetry channel from arcAudit.
  let safeEndAuditTelemetry: SafeEndAuditTelemetry | undefined;
  if (cfg.safeEndAuditMode === "shadow") {
    const audit = await runSafeEndNormalAudit(
      client,
      usage,
      afterPostBoundaryHookGate,
      nodes,
      cfg,
      { retryDelayMs: options.retryDelayMs }
    );
    const injected = options.safeEndAuditTelemetryTestHook
      ? options.safeEndAuditTelemetryTestHook(audit)
      : audit;
    safeEndAuditTelemetry = jsonSafeEndAuditTelemetry(injected, afterPostBoundaryHookGate);
  }

  // ARC DOWNRANK (spec 2026-08-10 task 7) - the first DROP authority the arc
  // audit earns, placed exactly where the task 5 long-clip policy sits: AFTER
  // arcAudit and BOTH extension stages, so every `entry.repaired`/
  // `exit.repaired` mark either of them may have written is already final,
  // and BEFORE finalizeClips, so a dropped clip never reaches the judge's
  // prompt at all (the finalizer keeps its own drop verbs unchanged; this
  // stage only removes what the audit already showed to be unrepairable AND
  // weak - spec §2b's "the audit never drops" is about DETECTION, not about
  // this later, code-gated stage that reads its published flags).
  //
  // GATED ON BOTH FLAGS, explicitly, the same doubling every audit-fed stage
  // in this file uses (extendClipStarts, the endExtensionHintsEnabled check,
  // the long-clip policy's own isFullyOk call): with ARC_AUDIT off, arcFlags
  // is always the empty map built above, so `standing` would already be 0 for
  // every clip and this block would already be a no-op BY ACCIDENT - the
  // explicit `cfg.arcAuditEnabled` check here makes that dependency a fact a
  // reader can see, not an implication of an upstream empty map, and it is
  // also what keeps the `arcDownrank` telemetry key genuinely ABSENT (not
  // merely zeroed) when only ARC_DOWNRANK is set without ARC_AUDIT.
  let arcDownrankTelemetry:
    | { considered: number; penalized: number; dropped: number }
    | undefined;
  let afterArcDownrank = afterPostBoundaryHookGate;
  if (cfg.arcDownrankEnabled && cfg.arcAuditEnabled) {
    const t = { considered: 0, penalized: 0, dropped: 0 };
    const kept: SnappedClip[] = [];
    for (const clip of afterPostBoundaryHookGate) {
      t.considered += 1;
      const standing = standingArcFlagCount(arcFlags.get(clip.verdict.id));
      // Penalty tiers, verbatim from spec §7/task 7: 2+ standing axes pay
      // arcDownrankPenalty2 (default 0.15, corpus-sized - see config.ts's own
      // doc comment for the 0.62-0.79 SKIP band this puts under threshold),
      // exactly 1 pays arcDownrankPenalty1 (default 0.0 - the corpus does not
      // separate SKIP from POST on a single flag), 0 pays nothing.
      const penalty =
        standing >= 2
          ? cfg.arcDownrankPenalty2
          : standing === 1
            ? cfg.arcDownrankPenalty1
            : 0;
      if (penalty > 0) t.penalized += 1;
      // NOT written back to verdict.score (spec §7: "the score is the
      // critic's record"): `effective` exists only for this threshold
      // comparison and is discarded immediately after. The finalizer, if this
      // clip survives, still sees the ORIGINAL score in its prompt block.
      const effective = clip.verdict.score - penalty;
      if (effective < cfg.scoreThreshold) {
        t.dropped += 1;
        droppedVerdicts.push({
          id: clip.verdict.id,
          stage: "arc_downrank",
          reason: "arc_unrepairable",
          score: clip.verdict.score,
        });
        continue;
      }
      kept.push(clip);
    }
    afterArcDownrank = kept;
    arcDownrankTelemetry = t;
  }

  let standaloneFilterTelemetry: StandaloneFilterTelemetry | undefined;
  let afterStandaloneFilter = afterArcDownrank;
  if (cfg.standaloneFilterEnabled && cfg.arcAuditEnabled) {
    const filtered = filterStandaloneClips(
      afterArcDownrank,
      arcFlags,
      cfg.scoreThreshold,
      cfg.arcDownrankPenalty2
    );
    afterStandaloneFilter = filtered.clips;
    standaloneFilterTelemetry = filtered.telemetry;
    for (const drop of filtered.drops) {
      droppedVerdicts.push({
        id: drop.id,
        stage: "standalone_filter",
        reason: "not_self_contained",
        score: drop.score,
      });
    }
  }

  // NEVER throws: any error, refusal, truncation or malformed output ships the
  // input set with a reason in telemetry. A stage with veto authority over
  // already-approved clips must not be able to turn a content answer into a
  // failed job - that would bill the user nothing but deny them a real reply
  // (billing invariant, engine-notes §6).
  const finalized = await finalizeClips(
    client,
    usage,
    afterStandaloneFilter,
    nodes,
    languageIso,
    isoToLanguageName(languageIso),
    cfg,
    { retryDelayMs: options.retryDelayMs },
    // arcFlags (spec 2026-08-10 task 5): the defence-in-depth gate for a
    // surviving unblessed overLength clip - unreachable if the policy above
    // is correct, checked anyway. Trailing positional argument so every
    // pre-task-5 call to finalizeClips (this file's own tests included) keeps
    // working unmodified with its own default of an empty map.
    arcFlags
  );
  // A title the finalizer WROTE is a model's sentence again, so the clip leaves
  // the snippet-title set. This is the only thing that removes an id from it,
  // and it is why a snap-stage snippet title normally costs nothing below.
  for (const rewrite of finalized.telemetry.titleRewrites) {
    snippetTitleIds.delete(rewrite.id);
  }

  // The backstop for the OTHER thing that moves boundaries: the finalizer's
  // opening trim re-snaps a clip, and it may move the start arbitrarily far
  // forward. Same rule, applied where the boundaries finally stop.
  const shipped = finalized.clips.slice(0, cfg.softCap).map((clip) => {
    const result = regroundCopy(clip, nodes);
    if (result.regrounded.length > 0) {
      copyRegrounded.push({ id: clip.verdict.id, at: "shipped", fields: result.regrounded });
    }
    if (result.regrounded.includes("title")) snippetTitleIds.add(clip.verdict.id);
    return result.clip;
  });

  // ---------------------------------------------------------------------------
  // DEGENERATE TITLES - the last stage that can write copy, and the only one
  // that runs after every stage that can destroy it.
  // ---------------------------------------------------------------------------
  // podcast-answer-arc shipped a clip titled "Плюсы" - one word, "Pros" - at
  // score 0.66. The clip was fine: it passed the critic, the evidence gate and
  // the finalizer. The TITLE was not a model's bad sentence. It was node #316 of
  // the transcript, verbatim, installed by the `regroundCopy` call above after
  // the finalizer's trim moved the clip past the nodes its title cited.
  //
  // MEASURED, because the shape of the fix follows from which population the bad
  // title came from. Two populations, all four eval snapshots plus every title in
  // every critic verdict in both responses.json, gpt-5.6-luna and gpt-5.1
  // together - 150 titles, 102 distinct:
  //
  //   A. MODEL-AUTHORED titles (critic + finalizer). Word counts:
  //        3:1  4:3  5:9  6:17  7:28  8:21  9:10  10:9  11:2  13:1
  //      Shortest: "Человек ускоряет эволюцию" - 3 words, 25 chars. NOTHING at
  //      one or two words, in either model, kept or rejected. A length floor on
  //      model output would have fired ZERO times on this corpus: it is the
  //      inert knob engine-notes §4 warns about, and building it would have
  //      claimed to fix a defect while never once executing.
  //
  //   B. SNIPPET titles - `snippetFallbackCopy` takes one node's text verbatim,
  //      so its population is the transcript's clean-start nodes. 788 of them
  //      across the two fixtures, by word count:
  //        1:27  2:53  3:77  4:80  5:80  6:80  7:75  8:74  9:63  10:51  11+:128
  //      A smooth continuum straight down to one word ("Нет", "Михаил",
  //      "Плюсы"). Inside THIS population "Плюсы" is not an outlier at all -
  //      it is an ordinary member of the short end, and a length floor drawn
  //      inside it would be a cutoff through a continuum, which is the other
  //      half of the same warning.
  //
  // The gap is BETWEEN the two populations - min 3 words / 21 chars against a
  // floor of 1 word / 3 chars - not inside either. So the categorical unit of
  // decision is not LENGTH, it is PROVENANCE: authored, or verbatim. That is
  // what `snippetTitleIds` tracks, and it is why nothing here counts a character
  // or splits on whitespace.
  //
  // MULTILINGUAL BY CONSTRUCTION, and this is the second reason to prefer
  // provenance. A word-count or character-count rule has to answer what a word
  // is in Chinese, Japanese or Thai, where a whole title is one whitespace token
  // - it would flag every title in those languages while flagging none in
  // German, where one compound word can be a sentence. "This string came out of
  // snippetFallbackCopy" is the same true statement in all six supported locales
  // and in every script beyond them. The only length in the whole path is
  // `truncateTitle`'s pre-existing 70-CODE-POINT cap, which is already
  // surrogate-safe.
  //
  // REPAIR, NEVER DROP. The clip cleared every content gate; the copy is broken
  // because our own code moved a boundary. Dropping it would spend a real clip to
  // avoid a bad line of text, and engine-notes §4's rule about staying quiet and
  // retrying points the same way. So: one repair attempt, and if it does not
  // produce something usable the snippet title SHIPS. That is the lesser harm in
  // both directions - the snippet is grounded and in the clip's own language by
  // construction, so the worst case is a dull title on a good clip, against a
  // user who paid for a clip and got nothing.
  //
  // BOUNDED STRUCTURALLY, like the critic's omission retry: this is one pass over
  // a fixed array with no recursion and no loop, and `copyRepairAttempted` is
  // global per clip, so a clip whose language repair already failed upstream does
  // not get a second call here. There is no counter to get wrong.
  for (let i = 0; i < shipped.length; i++) {
    const clip = shipped[i];
    const id = clip.verdict.id;
    if (!snippetTitleIds.has(id)) continue;
    const from = clip.verdict.title;

    if (copyRepairAttempted.has(id)) {
      snippetTitleRepairs.push({ id, from, to: null, outcome: "already_repaired" });
      continue;
    }
    copyRepairAttempted.add(id);

    const clipText = nodes
      .slice(clip.finalStartNode, clip.finalEndNode + 1)
      .filter((n) => n.hasWords)
      .map((n) => n.text)
      .join(" ");
    const repaired = await repairCopy(client, usage, nodes, clip.verdict, languageIso, cfg, {
      retryDelayMs: options.retryDelayMs,
    });
    // Same acceptance test the language-repair path uses, plus "it actually
    // changed something": a repair that hands back the snippet repaired nothing
    // and must not be reported as a fix.
    const usable =
      repaired !== null &&
      repaired.title !== from &&
      !scriptMismatch(repaired.title, clipText);
    if (!usable) {
      snippetTitleRepairs.push({ id, from, to: null, outcome: "unusable" });
      continue;
    }
    // TITLE ONLY. The description is a verbatim snippet too, and dull, but it is
    // not the hook and it is not what broke; swapping it as well would widen the
    // blast radius of a call whose only acceptance test is a script check.
    // titleEvidenceNodes stays as regroundCopy set it - the clip's own first
    // speech node, inside the shipped range - which remains a true in-range
    // citation for a title the model wrote from that same clip's text.
    shipped[i] = { ...clip, verdict: { ...clip.verdict, title: repaired.title } };
    snippetTitleIds.delete(id);
    snippetTitleRepairs.push({ id, from, to: repaired.title, outcome: "repaired" });
  }

  const snippetTitlesRepaired = snippetTitleRepairs.filter(
    (r) => r.outcome === "repaired"
  ).length;

  const highlights = shipped.map((clip) => toHighlight(clip, arcFlags));

  // Pulled out of the spread below so they land in the nested `longClips`
  // block instead of leaking as flat top-level keys (spec 2026-08-10 task 5)
  // - finalize.ts's defence-in-depth gate is the ONLY thing that ever sets
  // them, and it is meant to be unreachable when the policy above is correct,
  // so both are almost always absent here.
  const { longClipsCompressed, longClipsDropped, ...finalizedTelemetryRest } =
    finalized.telemetry;

  const telemetry = {
    // Not-a-key discipline (spec 2026-08-19-stream-analyze-mode, S1), same as
    // arcAudit below: present only when cfg.streamModeEnabled is true, so a
    // dark run adds no key at all - not "standard", not undefined, absent.
    // modeResolution (spec 2026-08-25-mid-rescue-and-stream-resolver-v2, part
    // 2 observability) mirrors that same discipline via resolveMode itself
    // returning modeResolution: undefined when the flag is off.
    ...(cfg.streamModeEnabled ? { analysisMode: mode, modeResolution } : {}),
    ...scannerTelemetry,
    criticVerdicts: critic.verdicts.length,
    verdictScores: critic.verdicts
      .map((v) => ({ id: v.id, keep: v.keep, score: v.score }))
      .sort((a, b) => b.score - a.score),
    ...critic.telemetry,
    evidenceDrops,
    evidenceWidened,
    gateDropReasons,
    evidenceOutOfRange,
    droppedVerdicts,
    snapDrops,
    copyRepairs,
    snippetFallbacks,
    copyRegrounded,
    // Shipped clips whose title was engine-written verbatim speech with nothing
    // left downstream to rewrite it, and what the one repair call did about it.
    // flagged = repaired + kept, always: the three are computed from one array.
    snippetTitlesFlagged: snippetTitleRepairs.length,
    snippetTitlesRepaired,
    snippetTitlesKept: snippetTitleRepairs.length - snippetTitlesRepaired,
    snippetTitleRepairs,
    tier: selection.tier,
    droppedByNms: selection.droppedByNms,
    // Absent, never a zeroed placeholder, while the stage is dark - the same
    // "not a key" promise `_arcFlags` keeps below. arcAuditTelemetry is
    // undefined exactly when cfg.arcAuditEnabled was false, so this spread
    // adds nothing at all to the object in that case (spec 2026-08-10 task 2).
    ...(arcAuditTelemetry ? { arcAudit: arcAuditTelemetry } : {}),
    // Same not-a-key promise as arcAudit above: startExtensionTelemetry is
    // undefined exactly when the combined gate just above did not call
    // extendClipStarts, so this spread adds nothing at all to the object on a
    // dark run (spec 2026-08-10 task 3).
    ...(startExtensionTelemetry ? { startExtension: startExtensionTelemetry } : {}),
    // THE WHOLE OBJECT, never a hand-picked subset of its counters. `skipped` is
    // the only field that separates "the stage never ran" from "it ran and
    // declined every clip" - both are zeros everywhere else - and `refusedBy` is
    // the only thing that says WHICH prompt edit a rising `refused` argues for.
    // This engine has already shipped one defect from two facts sharing one
    // field: `lowQuality` meant "a degraded model judged this" while the bot
    // printed "no strong moments found" from it, so a user got 12 good clips
    // each headed by a false apology (job cmscht6rp001xq41s5rhjx6q0).
    endExtension: extension.telemetry,
    // The three numbers that make the finalizer's arithmetic readable in a job
    // record: what it was given, what it returned, what the soft cap then cut.
    // Without them a clip lost to the cap looks identical to a clip the judge
    // vetoed, and this stage's failure mode is an invisible loss.
    //
    // Counted off the ARGUMENT the finalizer received, not off selection. The
    // two agree today only because the extension stage returns its input 1:1 on
    // every path, and nothing at this call site says so - a counter that reads
    // "what it was given" has to read what was given. `afterStandaloneFilter`,
    // not `extension.clips`, IS that argument: arc downrank and the standalone
    // filter above can remove clips (droppedVerdicts carries the reason), and
    // with both dark the arrays stay identical.
    selectedForFinalizer: afterStandaloneFilter.length,
    finalizerSurvivors: finalized.clips.length,
    ...finalizedTelemetryRest,
    kept: highlights.length,
    meanLexicalOverlap: mean(
      shipped.map((c) =>
        lexicalOverlap(
          c.verdict.title,
          nodes.slice(c.finalStartNode, c.finalEndNode + 1).map((n) => n.text).join(" ")
        )
      )
    ),
    durations: highlights.map((h) => Math.round((h.end - h.start) * 10) / 10),
    // Absent entirely when LONG_CLIPS is off (spec 2026-08-10 task 5) - the
    // same not-a-key promise arcAudit/startExtension keep above.
    // `compressed`/`dropped` fold in the finalizer's own defence-in-depth
    // counts (longClipsCompressed/longClipsDropped, pulled out above) so a
    // reader sees ONE total regardless of which stage actually did the work.
    ...(longClipsTelemetry
      ? {
          longClips: {
            overLength: longClipsTelemetry.overLength,
            blessed: longClipsTelemetry.blessed,
            compressed: longClipsTelemetry.compressed + (longClipsCompressed ?? 0),
            dropped: longClipsTelemetry.dropped + (longClipsDropped ?? 0),
          },
        }
      : {}),
    // Absent entirely when the gate above did not run (spec 2026-08-10 task 7)
    // - the same not-a-key promise arcAudit/startExtension/longClips keep
    // above, not a zeroed placeholder.
    ...(arcDownrankTelemetry ? { arcDownrank: arcDownrankTelemetry } : {}),
    ...(standaloneFilterTelemetry ? { standaloneFilter: standaloneFilterTelemetry } : {}),
    ...(postBoundaryHookGateTelemetry ? { postBoundaryHookGate: postBoundaryHookGateTelemetry } : {}),
    // V1 is observation-only. The key is absent exactly when the shadow mode is
    // off, not a zeroed placeholder; downstream stages have no reference to it.
    ...(safeEndAuditTelemetry ? { safeEndAudit: safeEndAuditTelemetry } : {}),
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
    const t = critic.telemetry;
    const unjudged = t.omittedDrops + t.truncatedDrops + t.refusalDrops;
    if (unjudged > 0) {
      throw new AnalyzeTechnicalError(
        `no clip survived and ${unjudged} of ${candidates.length} candidate(s) never got a verdict ` +
          `(omitted ${t.omittedDrops}, refused ${t.refusalDrops}, truncated ${t.truncatedDrops}, ` +
          `invariant ${t.invariantDrops}) - the empty result is not a complete answer`
      );
    }

    // SHORT-SOURCE RESCUE (spec 2026-08-19-short-source-rescue), extended by
    // MID-SOURCE RESCUE (spec 2026-08-25-mid-rescue-and-stream-resolver-v2,
    // part 1). Every candidate was really judged (the guard above) and
    // really rejected - for a normal source that honest "no" ships below,
    // unchanged. For a SHORT source that "no" is usually the user's first
    // impression of the product (half of all first submissions are under 5
    // minutes, 0.2 clips on average, 2 of 16 returned), and the measured
    // population died entirely downstream of the critic - so the best
    // snappable verdict ships as ONE lowQuality clip instead. Deliberately
    // AFTER the unjudged throw: a technical failure must keep failing - its
    // retries are free to the user and genuinely re-roll the critic - and a
    // rescue there would bill for an answer that was never obtained.
    // `sourceDurationSec` comes only from the stage; eval scripts never pass
    // it, so the corpus never sees this path. STRICTLY under, matching
    // isShortSource in shared plans.ts exactly: the bot's notice and this
    // rescue must describe the same population, and the bot's is
    // `durationSec < shortNoticeSec`. A 300s source gets neither.
    const shortSource =
      typeof options.sourceDurationSec === "number" &&
      options.sourceDurationSec > 0 &&
      options.sourceDurationSec < cfg.shortSourceRescueMaxSec;
    // MID window: [shortSourceRescueMaxSec, rescueMidMaxSourceSec) - the same
    // strict-under discipline at its own ceiling, disjoint from shortSource
    // above so a duration is eligible for at most one tier. Independently
    // switchable (rescueMidSourceEnabled) so the two ceilings can be armed on
    // separate schedules; the candidate rules, lowQuality mark and bot copy
    // inside rescueShortSource are untouched by this widening.
    const midSource =
      typeof options.sourceDurationSec === "number" &&
      options.sourceDurationSec >= cfg.shortSourceRescueMaxSec &&
      options.sourceDurationSec < cfg.rescueMidMaxSourceSec;
    let rescueTelemetry: RescueTelemetry | undefined;
    if (
      ((cfg.shortSourceRescueEnabled && shortSource) ||
        (cfg.rescueMidSourceEnabled && midSource)) &&
      !allSelectedClipsDroppedByPostBoundaryHookGate
    ) {
      const rescue = rescueShortSource(
        critic.verdicts.filter((verdict) => !postBoundaryHookGateDroppedIds.has(verdict.id)),
        nodes,
        cfg
      );
      rescueTelemetry = rescue.telemetry;
      if (rescue.clip) {
        // An EMPTY map, never `arcFlags`: with ARC_AUDIT on, a verdict that
        // was selected, audited and then dropped (downrank, finalizer) is
        // exactly what the rescue re-snaps - and its flags can carry
        // `repaired` entries the extension stages set for a geometry this
        // clip does not have. No audit ran on the rescue geometry, so no
        // flags may travel with it (toHighlight's own rule: a diagnostic
        // that names things the clip does not contain sends investigations
        // to the wrong place).
        const h = toHighlight(rescue.clip, new Map());
        return {
          highlights: [h],
          // `tier` stays "none", truthfully - selection found nothing, and
          // the rescue is not selection. The `rescue` key is the record that
          // this clip exists despite that, and `kept`/`durations` describe
          // what actually shipped. The OTHER counters - selectedForFinalizer,
          // finalizerSurvivors, meanLexicalOverlap, snippetFallbacks - keep
          // their selection-path values deliberately: they describe the
          // selection that found nothing (kept > finalizerSurvivors is the
          // rescue's signature in a job record, not a bug), and the rescue's
          // own copy provenance lives in rescue.copySource. `rescue.tier`
          // ("short" | "mid") records which ceiling made this job eligible,
          // additive only on the shipped path, so the 2026-09 checkpoint can
          // tell the two populations apart.
          telemetry: {
            ...telemetry,
            kept: 1,
            durations: [Math.round((h.end - h.start) * 10) / 10],
            rescue: { ...rescueTelemetry, tier: shortSource ? "short" : "mid" },
          },
          usage,
        };
      }
    }

    // Every candidate survived the holes, every one came back with a real
    // verdict, and the emptiness is therefore a judgement - keep:false, or our
    // own evidence/snap/selection bar - made on audio we really heard. Never
    // technical: PARTIAL_TRANSCRIPT tells the user both halves (we lost some
    // audio, and the rest held no strong moments).
    return {
      highlights: [],
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      // The rescue key is present iff the stage RAN (same not-a-key promise
      // as arcAudit) - here that is "ran and could not realize any verdict",
      // which the 2026-09 checkpoint needs to see as clearly as a success.
      telemetry: rescueTelemetry
        ? { ...telemetry, rescue: { ...rescueTelemetry, tier: shortSource ? "short" : "mid" } }
        : telemetry,
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

/** `arcFlags` is keyed by clip id and absent whenever the stage did not audit
 *  this clip - disabled, or a batch this clip fell into stayed unaudited - so
 *  `_arcFlags` on the returned highlight is present if and only if a real
 *  verdict exists for it (Map#get returning undefined never adds the key,
 *  since the spread below is conditional). That is what keeps a dark run
 *  byte-identical to today: an empty map here means the key never appears on
 *  any highlight.
 *
 *  This lookup runs AFTER extendClipStarts/extendClipEnds, against the SAME
 *  map instance both of them may have `.set()` a repaired entry into
 *  (follow-up, 2026-08-11) - so `_arcFlags.entry.repaired`/`.exit.repaired`
 *  reach the shipped highlight with no extra plumbing here: this function
 *  never needed to know a repair happened, only to read the map late enough
 *  to see it. */
function toHighlight(clip: SnappedClip, arcFlags: Map<string, ArcFlags>): V2Highlight {
  const v = clip.verdict;
  const flags = arcFlags.get(v.id);
  return {
    start: clip.startSec,
    end: clip.endSec,
    hookStart: clip.hookStartSec,
    hookEnd: clip.hookEndSec,
    payoffAt: clip.payoffSec,
    title: v.title,
    description: v.description,
    score: v.score,
    language: v.language,
    lowQuality: v.lowQuality ?? false,
    shortMoment: clip.shortMoment,
    kind: v.kind,
    // The range that SHIPPED, not the critic's proposal - these are diagnostics,
    // and a diagnostic that names nodes the clip does not contain sent a real
    // investigation (job cms2c8ahm) looking in the wrong place.
    _startNode: clip.finalStartNode,
    _endNode: clip.finalEndNode,
    _titleEvidenceNodes: v.titleEvidenceNodes,
    _descriptionEvidenceNodes: v.descriptionEvidenceNodes,
    _grounded: v.grounded,
    _boundaryConfidence: clip.boundaryConfidence,
    ...(flags ? { _arcFlags: flags } : {}),
  };
}

/**
 * How many of a clip's three arc-audit axes are STANDING - `ok: false` and
 * NOT since repaired (spec 2026-08-10 task 7, §2b/§7). This is the count the
 * ARC DOWNRANK block above tiers its penalty on, per the corpus finding that
 * the separating signal is the COUNT of standing axes, not any single one.
 *
 * `!flags` (never audited, or the stage is dark) reads as 0 standing, same
 * "absent means nothing was established" rule `isFullyOk` (arc-audit.ts)
 * documents for its own missing-flags case - a clip nothing ever flagged is
 * never downranked by this stage, which is also the positive-control
 * property spec §7's acceptance criteria names explicitly.
 *
 * `repaired` is EXCLUDED deliberately, mirroring `isFullyOk`'s own opposite
 * choice for the SAME field: that function stays conservative and reads
 * `ok` only (a patched boundary does not un-flag a clip for the long-clip
 * gate's purposes), while this one exists to count what is STILL WRONG with
 * the clip as it ships - and a widen-only repair that actually applied did
 * fix the boundary the detector complained about (start-extension.ts's and
 * end-extension.ts's own `repaired` doc comments: "the STANDING defect no
 * longer describes the shipped clip - only the historical verdict does").
 * Counting a repaired axis here would penalize a clip for a defect this same
 * pipeline already corrected earlier in this very function call.
 *
 * `standalone` carries no `repaired` field (types.ts: "the audit has no
 * drop or repair verb for it") - `flags.standalone.ok === false` therefore
 * always counts once nothing ever un-flags it, which is the correct reading:
 * a standalone gap this pipeline could not act on is still standing.
 */
function standingArcFlagCount(flags: ArcFlags | undefined): number {
  if (!flags) return 0;
  let standing = 0;
  if (!flags.entry.ok && !flags.entry.repaired) standing += 1;
  if (!flags.exit.ok && !flags.exit.repaired) standing += 1;
  if (!flags.standalone.ok) standing += 1;
  return standing;
}

/** Evidence cited at most EVIDENCE_BOUNDARY_SLACK_NODES outside [startNode,
 *  endNode] pulls the boundary out to contain it. Mutates the verdict; returns
 *  whether anything moved. Evidence further out stays a genuine grounding
 *  failure - and the same slack governs the mirror question after the
 *  boundaries stop moving (gates.ts, regroundCopy). */
function widenRangeToEvidence(
  verdict: { startNode: number; endNode: number; titleEvidenceNodes: number[]; descriptionEvidenceNodes: number[] },
  maxIdx: number
): boolean {
  const evidence = [...verdict.titleEvidenceNodes, ...verdict.descriptionEvidenceNodes]
    .filter((i) => Number.isInteger(i) && i >= 0 && i <= maxIdx);
  if (evidence.length === 0) return false;
  const min = Math.min(...evidence);
  const max = Math.max(...evidence);
  let widened = false;
  if (min < verdict.startNode && verdict.startNode - min <= EVIDENCE_BOUNDARY_SLACK_NODES) {
    verdict.startNode = min;
    widened = true;
  }
  if (max > verdict.endNode && max - verdict.endNode <= EVIDENCE_BOUNDARY_SLACK_NODES) {
    verdict.endNode = max;
    widened = true;
  }
  return widened;
}

/** Coarse last-resort language guess for legacy transcripts without a language.
 *  New V2 transcripts carry the Whisper-detected ISO code and never hit this. */
function scriptFallbackIso(text: string): string {
  const sample = text.slice(0, 2000);
  switch (dominantScript(sample)) {
    case "cyrillic":
      return "ru";
    case "arabic":
      return "ar";
    case "cjk":
      return "zh";
    default:
      return "en";
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}
