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
  if (missingRanges.length > 0) {
    candidates = candidates.filter((c) => {
      const startSec = nodes[c.startNode].start;
      const endSec = nodes[c.endNode].end;
      return !missingRanges.some((r) => startSec < r.end && endSec > r.start);
    });
  }

  if (candidates.length === 0) {
    return {
      highlights: [],
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      telemetry: { ...scannerTelemetry, keptVerdicts: 0 },
      usage,
    };
  }

  const critic = await runCritic(client, usage, nodes, candidates, languageIso, cfg, {
    retryDelayMs: options.retryDelayMs,
  });

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
    return {
      highlights: [],
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      telemetry,
      usage,
    };
  }

  return { highlights, telemetry, usage };
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
