import OpenAI from "openai";
import type { TranscriptionResult } from "@clipclap/shared";
import { loadAnalyzeConfig, type AnalyzeConfig } from "./config";
import { buildSentenceGraph } from "./sentence-graph";
import { runScanner } from "./scanner";
import { mergeCandidates, selectCriticCandidates } from "./candidates";
import { AnalyzeTechnicalError, runCritic, repairCopy } from "./critic";
import { snapNodes } from "./snap";
import { evidenceGate, snippetFallbackCopy, lexicalOverlap } from "./gates";
import { dominantScript, scriptMismatch } from "./language";
import { selectAndOrder } from "./select";
import { newUsage } from "./llm";
import type {
  MergedCandidate,
  SnappedClip,
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
  /** Test hook - forwarded to scanner/critic. */
  retryDelayMs?: number;
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
    const scan = await runScanner(client, usage, nodes, cfg, {
      retryDelayMs: options.retryDelayMs,
    });

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

    const merged = mergeCandidates(scan.candidates, nodes, cfg);
    const sourceMinutes = speechSec / 60;
    candidates = selectCriticCandidates(merged, nodes, cfg, sourceMinutes);
    scannerTelemetry = {
      path: "full",
      ...scan.telemetry,
      rawCandidates: scan.candidates.length,
      mergedCandidates: merged.length,
      criticCandidates: candidates.length,
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
      telemetry: { ...scannerTelemetry, keptVerdicts: 0, holeDrops },
      usage,
    };
  }

  const critic = await runCritic(client, usage, nodes, candidates, languageIso, cfg, {
    retryDelayMs: options.retryDelayMs,
  });

  // A critic that judged the candidates and rejected them returns REAL verdicts
  // with keep:false - that is a content outcome and falls through below. Zero
  // verdicts for a non-empty candidate set means nothing was judged at all: the
  // API answered but every row was empty/unknown/invalid, or every batch was
  // refused. Same quota rule as the scanner guard above: shipping DONE with 0
  // clips burns the user's minutes (usage sums every job that is not FAILED)
  // for output no model ever looked at, while FAILED leaves the quota untouched
  // and BullMQ retries. Never ship unjudged emptiness.
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
  const gateDropReasons: Record<string, number> = {};
  const droppedVerdicts: Array<{ id: string; stage: string; reason: string; score: number }> = [];

  for (const verdict of critic.verdicts) {
    if (!verdict.keep) continue;

    // Evidence just past the chosen boundary is a boundary problem, not a
    // grounding failure: widen the range to contain its own evidence (snap
    // re-validates clean start, invariants and the 90s cap afterwards).
    if (widenRangeToEvidence(verdict, nodes.length - 1)) evidenceWidened += 1;

    const gate = evidenceGate(verdict, nodes);
    if (!gate.ok) {
      evidenceDrops += 1;
      const reason = gate.reason ?? "unknown";
      gateDropReasons[reason] = (gateDropReasons[reason] ?? 0) + 1;
      droppedVerdicts.push({ id: verdict.id, stage: "gate", reason, score: verdict.score });
      continue;
    }
    const snapped = snapNodes(verdict, nodes, cfg);
    if (!snapped.ok) {
      snapDrops += 1;
      droppedVerdicts.push({ id: verdict.id, stage: "snap", reason: snapped.reason, score: verdict.score });
      continue;
    }

    const clipText = nodes
      .slice(verdict.startNode, verdict.endNode + 1)
      .filter((n) => n.hasWords)
      .map((n) => n.text)
      .join(" ");
    if (scriptMismatch(`${verdict.title} ${verdict.description}`, clipText)) {
      copyRepairs += 1;
      const repaired = await repairCopy(client, usage, nodes, verdict, languageIso, cfg, {
        retryDelayMs: options.retryDelayMs,
      });
      if (repaired && !scriptMismatch(`${repaired.title} ${repaired.description}`, clipText)) {
        verdict.title = repaired.title;
        verdict.description = repaired.description;
      } else {
        snippetFallbacks += 1;
        const snippet = snippetFallbackCopy(nodes, verdict.startNode, verdict.endNode);
        verdict.title = snippet.title;
        verdict.description = snippet.description;
      }
    }
    eligible.push(snapped.clip);
  }

  const selection = selectAndOrder(eligible, cfg);
  const highlights = selection.selected.map(toHighlight);

  const telemetry = {
    ...scannerTelemetry,
    criticVerdicts: critic.verdicts.length,
    verdictScores: critic.verdicts
      .map((v) => ({ id: v.id, keep: v.keep, score: v.score }))
      .sort((a, b) => b.score - a.score),
    ...critic.telemetry,
    evidenceDrops,
    evidenceWidened,
    gateDropReasons,
    droppedVerdicts,
    snapDrops,
    copyRepairs,
    snippetFallbacks,
    tier: selection.tier,
    droppedByNms: selection.droppedByNms,
    kept: highlights.length,
    meanLexicalOverlap: mean(
      selection.selected.map((c) =>
        lexicalOverlap(
          c.verdict.title,
          nodes.slice(c.verdict.startNode, c.verdict.endNode + 1).map((n) => n.text).join(" ")
        )
      )
    ),
    durations: highlights.map((h) => Math.round((h.end - h.start) * 10) / 10),
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
    const t = critic.telemetry;
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

function toHighlight(clip: SnappedClip): V2Highlight {
  const v = clip.verdict;
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
    _startNode: v.startNode,
    _endNode: v.endNode,
    _titleEvidenceNodes: v.titleEvidenceNodes,
    _descriptionEvidenceNodes: v.descriptionEvidenceNodes,
    _grounded: v.grounded,
    _boundaryConfidence: clip.boundaryConfidence,
  };
}

const EVIDENCE_WIDEN_MAX_NODES = 2;

/** Evidence cited at most EVIDENCE_WIDEN_MAX_NODES outside [startNode, endNode]
 *  pulls the boundary out to contain it. Mutates the verdict; returns whether
 *  anything moved. Evidence further out stays a genuine grounding failure. */
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
  if (min < verdict.startNode && verdict.startNode - min <= EVIDENCE_WIDEN_MAX_NODES) {
    verdict.startNode = min;
    widened = true;
  }
  if (max > verdict.endNode && max - verdict.endNode <= EVIDENCE_WIDEN_MAX_NODES) {
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
