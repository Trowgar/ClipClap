/**
 * Selection autopsy (spec 2026-08-11 "Selection autopsy: where labeled
 * moments die in the funnel"). Replay-only, zero-cost.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-selection-autopsy.ts \
 *        [--variant NAME] [--labels PATH] <fixture>"
 *
 * WHAT THIS IS FOR
 * -----------------------------------------------------------------
 * The owner's direction after the arc-audit programme: if the hit rate does
 * not move, look at SELECTION - which candidates ever reach criticCandidates
 * and the finalizer. `podcast-nuclear`'s labels already show the motivating
 * fact: three moments with 3/3 blind-scout consensus that neither engine run
 * shipped, and roughly five shipped moments no scout chose. Nothing in the
 * engine currently says WHERE in the funnel a labeled moment died. This
 * script says it, stage by stage, for every labeled moment AND in reverse for
 * every shipped clip that matches no label - "recall died where" and
 * "precision leaked where" in one instrument. NO ENGINE CHANGE. The remedy
 * gets its own spec once these tables exist.
 *
 * HOW IT WORKS
 * -----------------------------------------------------------------
 * The front half (scanner -> merge -> teaser -> critic-candidate selection ->
 * critic -> evidence gate -> snap -> select) replays via
 * `replay-front-half.ts`'s `runFrontHalf`, the same plumbing
 * `eval-arc-stability.ts` uses (extracted from it for this script, so this is
 * the SECOND user, not a third copy). The finalizer half comes from
 * `runFixtureVariant`'s full result, because the finalizer's veto lives only
 * there.
 *
 * TWO THINGS THIS SCRIPT RECOMPUTES rather than reads directly off an engine
 * export, both because the engine only returns the ACCEPTED set, never the
 * rejected one with reasons. Both recomputations call the engine's own
 * exported functions for the actual decision test (`criticBudget`,
 * `nmsCollides`) rather than re-deriving the arithmetic, and both are
 * verified against the real engine output before being trusted - see
 * `recomputeCriticSelection` and `recomputeSelectAndOrder` below, and the
 * assertions right after each call in `main()`.
 *
 *   1. `selectCriticCandidates` (candidates.ts) returns only the K it kept.
 *      Which of the rest lost to the budget K versus the per-region
 *      diversity cap is not exposed, so this script mirrors the function's
 *      own two-phase algorithm (per-window quota, then global-by-interest
 *      capped per region) to label each rejected candidate.
 *   2. `selectAndOrder` (select.ts) returns only the survivors and a COUNT of
 *      NMS drops, never which clip beat which. This script mirrors the
 *      tier-pool + score-sorted-NMS-sweep algorithm, using the real exported
 *      `nmsCollides` for the actual collision test, to name the winning
 *      neighbour for every clip NMS killed.
 *
 * Everything else - gate/snap outcomes, critic verdicts, finalizer drops,
 * trims and rewrites - is read directly off the real functions' own return
 * values; nothing about THEIR internal logic is reimplemented.
 *
 * MATCHING A CANDIDATE/VERDICT/CLIP TO A LABELED MOMENT: time overlap >= 30%
 * of the SHORTER range (spec's convention, distinct from the IoU
 * `arc-audit-labels.ts` uses for its own labeled-clip matching).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  parseVariantArgs,
  runFixtureVariant,
  variantConfig,
} from "../__tests__/helpers/eval-fixture";
import { criticBudget } from "../analyze-v2/candidates";
import { nmsCollides } from "../analyze-v2/select";
import { labelRange, type LabelEntry } from "./arc-audit-labels";
import { runFrontHalf, type FrontHalfResult } from "./replay-front-half";
import type { AnalyzeConfig } from "../analyze-v2/config";
import type {
  CriticVerdict,
  MergedCandidate,
  ScanCandidate,
  SentenceNode,
  SnappedClip,
  V2Highlight,
} from "../analyze-v2/types";

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function extractLabelsFlag(argv: string[]): { labelsPath: string | undefined; rest: string[] } {
  const idx = argv.indexOf("--labels");
  if (idx === -1) return { labelsPath: undefined, rest: argv };
  const value = argv[idx + 1];
  if (!value || value.startsWith("-")) throw new Error("--labels requires a path argument");
  return { labelsPath: value, rest: [...argv.slice(0, idx), ...argv.slice(idx + 2)] };
}

// ---------------------------------------------------------------------------
// labels: moments[] AND missedMoments[] - loadLabels (arc-audit-labels.ts)
// only ever returns the first matching top-level array key, so it cannot
// surface both at once. `labelRange` is reused unmodified for parsing one
// entry's range.
// ---------------------------------------------------------------------------

interface RawLabelEntry extends LabelEntry {
  hook?: string;
  payoff?: string;
  agreement?: string;
  note?: string;
}

interface LabeledMoment {
  kind: "moment" | "missed";
  ordinal: number;
  range: [number, number];
  title: string;
  entry: RawLabelEntry;
}

function loadMoments(path: string): LabeledMoment[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    console.warn(`[eval-selection-autopsy] ${path} did not parse as JSON: ${(error as Error).message}`);
    return [];
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const out: LabeledMoment[] = [];
  const moments = Array.isArray(obj.moments) ? (obj.moments as RawLabelEntry[]) : [];
  moments.forEach((m, i) => {
    const range = labelRange(m);
    if (!range) return;
    out.push({ kind: "moment", ordinal: i + 1, range, title: m.productionTitle ?? `moment ${i + 1}`, entry: m });
  });
  const missed = Array.isArray(obj.missedMoments) ? (obj.missedMoments as RawLabelEntry[]) : [];
  missed.forEach((m, i) => {
    const range = labelRange(m);
    if (!range) return;
    out.push({ kind: "missed", ordinal: i + 1, range, title: m.hook ?? `missed moment ${i + 1}`, entry: m });
  });
  return out;
}

// ---------------------------------------------------------------------------
// time-overlap matching: >= 30% of the SHORTER range (spec's own convention,
// not arc-audit-labels.ts's IoU).
// ---------------------------------------------------------------------------

const MATCH_FRAC = 0.3;

function overlapFrac(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const interStart = Math.max(aStart, bStart);
  const interEnd = Math.min(aEnd, bEnd);
  const inter = Math.max(0, interEnd - interStart);
  const shorter = Math.min(aEnd - aStart, bEnd - bStart);
  return shorter > 0 ? inter / shorter : 0;
}

function covers(momentStart: number, momentEnd: number, otherStart: number, otherEnd: number): boolean {
  return overlapFrac(momentStart, momentEnd, otherStart, otherEnd) >= MATCH_FRAC;
}

function candSec(nodes: SentenceNode[], c: { startNode: number; endNode: number }): [number, number] {
  return [nodes[c.startNode].start, nodes[c.endNode].end];
}

const fmtSec = (s: number) => s.toFixed(1);
const fmtRange = (a: number, b: number) => `${fmtSec(a)}-${fmtSec(b)}s`;

// ---------------------------------------------------------------------------
// Recompute 1: selectCriticCandidates' own rejects, with a reason.
// Mirrors candidates.ts's selectCriticCandidates (per-window quota, then
// global-by-interest extras capped per 10-min payoff region) so a rejected
// candidate can be told apart as "budget K" or "region cap". Verified against
// the real function's output right after the call in main().
// ---------------------------------------------------------------------------

interface CriticRejectReason {
  reason: "budget" | "region_cap";
  detail: string;
}

const REGION_SEC = 600; // candidates.ts's own REGION_SEC, not exported - mirrored here for the region key only

function recomputeCriticSelection(
  withoutTeasers: MergedCandidate[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  K: number
): { picked: MergedCandidate[]; rejectReason: Map<string, CriticRejectReason> } {
  const byWindow = new Map<number, MergedCandidate[]>();
  for (const c of withoutTeasers) {
    const list = byWindow.get(c.windowIndex) ?? [];
    list.push(c);
    byWindow.set(c.windowIndex, list);
  }
  const pickedSet = new Set<string>();
  const picked: MergedCandidate[] = [];
  const take = (c: MergedCandidate) => {
    if (pickedSet.has(c.id)) return;
    pickedSet.add(c.id);
    picked.push(c);
  };
  for (const list of byWindow.values()) {
    [...list]
      .sort((a, b) => b.interest - a.interest)
      .slice(0, cfg.perWindowMinCandidates)
      .forEach(take);
  }

  const regionCount = new Map<number, number>();
  for (const c of picked) {
    const region = Math.floor(nodes[c.payoffNode].start / REGION_SEC);
    regionCount.set(region, (regionCount.get(region) ?? 0) + 1);
  }
  const extras = withoutTeasers.filter((c) => !pickedSet.has(c.id)).sort((a, b) => b.interest - a.interest);
  const rejectReason = new Map<string, CriticRejectReason>();
  for (const c of extras) {
    if (picked.length >= K) {
      rejectReason.set(c.id, {
        reason: "budget",
        detail: `criticBudgetK=${K} already reached before this candidate's rank (interest=${c.interest.toFixed(2)})`,
      });
      continue;
    }
    const region = Math.floor(nodes[c.payoffNode].start / REGION_SEC);
    if ((regionCount.get(region) ?? 0) >= cfg.regionMaxCandidates) {
      rejectReason.set(c.id, {
        reason: "region_cap",
        detail:
          `payoff region [${region * REGION_SEC}-${(region + 1) * REGION_SEC}s) already holds ` +
          `regionMaxCandidates=${cfg.regionMaxCandidates} (interest=${c.interest.toFixed(2)})`,
      });
      continue;
    }
    regionCount.set(region, (regionCount.get(region) ?? 0) + 1);
    take(c);
  }
  return { picked, rejectReason };
}

// ---------------------------------------------------------------------------
// Recompute 2: selectAndOrder's own NMS drops, with the winning neighbour.
// Mirrors select.ts's tier-pool selection and score-sorted NMS sweep, using
// the real exported `nmsCollides` for the actual overlap test. Verified
// against the real function's output right after the call in main().
// ---------------------------------------------------------------------------

function recomputeSelectAndOrder(
  eligible: SnappedClip[],
  cfg: AnalyzeConfig,
  limit: number
): {
  tier: "strong" | "weak" | "none";
  poolIds: Set<string>;
  keptIds: Set<string>;
  selectedIds: Set<string>;
  nmsWinner: Map<string, string>;
  cutBySoftLimitIds: Set<string>;
} {
  const surcharge = (c: SnappedClip) =>
    (c.endSec - c.startSec < cfg.shortClipStrictSec ? cfg.shortClipScoreBonus : 0) +
    (c.endsOnQuestion ? cfg.questionEndScoreBonus : 0);
  const strong = eligible.filter((c) => c.verdict.score >= cfg.scoreThreshold + surcharge(c));
  let tier: "strong" | "weak" | "none";
  let pool: SnappedClip[];
  if (strong.length > 0) {
    tier = "strong";
    pool = strong;
  } else {
    const weak = eligible
      .filter((c) => c.verdict.score >= cfg.weakFallbackMinScore + surcharge(c))
      .sort((a, b) => b.verdict.score - a.verdict.score)
      .slice(0, 2);
    tier = weak.length > 0 ? "weak" : "none";
    pool = weak;
  }
  const poolIds = new Set(pool.map((c) => c.verdict.id));

  const byScore = [...pool].sort((a, b) => b.verdict.score - a.verdict.score || a.startSec - b.startSec);
  const kept: SnappedClip[] = [];
  const nmsWinner = new Map<string, string>();
  for (const c of byScore) {
    const winner = kept.find((k) => nmsCollides(k, c));
    if (winner) {
      nmsWinner.set(c.verdict.id, winner.verdict.id);
      continue;
    }
    kept.push(c);
  }
  const keptIds = new Set(kept.map((c) => c.verdict.id));
  const selected = kept.slice(0, limit);
  const selectedIds = new Set(selected.map((c) => c.verdict.id));
  const cutBySoftLimitIds = new Set(kept.slice(limit).map((c) => c.verdict.id));
  return { tier, poolIds, keptIds, selectedIds, nmsWinner, cutBySoftLimitIds };
}

// ---------------------------------------------------------------------------
// Finalizer correlation: telemetry.finalizerDrops etc. are keyed by candidate
// id; result.highlights carries no id. Positional correspondence is
// recovered from the one order-preserving fact finalize.ts documents itself
// (drops -> trims -> rewrites, never a reorder) plus the trailing
// `.slice(0, cfg.softCap)` in index.ts (not itself telemetry) - see the
// module doc comment and the assertion right after this call in main().
// ---------------------------------------------------------------------------

interface FinalizeCorrelation {
  hookDrop: Map<string, string>;
  semDrop: Map<string, { duplicateOf: string; sharedClaim: string | null }>;
  finReason: Map<string, string>;
  trims: Map<string, { fromNode: number; toNode: number }>;
  rewrites: Map<string, { from: string; to: string }>;
  shippedIds: string[]; // positionally aligned with result.highlights
  cutBySoftCapIds: Set<string>;
}

function correlateFinalizer(
  orderedIds: string[],
  telemetry: Record<string, unknown>,
  softCap: number
): FinalizeCorrelation {
  const hookDrop = new Map<string, string>(
    ((telemetry.hookDedupDrops as Array<{ id: string; duplicateOf: string }>) ?? []).map((d) => [
      d.id,
      d.duplicateOf,
    ])
  );
  const semDrop = new Map<string, { duplicateOf: string; sharedClaim: string | null }>(
    (
      (telemetry.semanticDedupDrops as Array<{ id: string; duplicateOf: string; sharedClaim: string | null }>) ?? []
    ).map((d) => [d.id, { duplicateOf: d.duplicateOf, sharedClaim: d.sharedClaim }])
  );
  const finReason = new Map<string, string>(
    ((telemetry.finalizerDrops as Array<{ id: string; reason: string }>) ?? []).map((d) => [d.id, d.reason])
  );
  const trims = new Map<string, { fromNode: number; toNode: number }>(
    ((telemetry.openingTrims as Array<{ id: string; fromNode: number; toNode: number }>) ?? []).map((d) => [
      d.id,
      { fromNode: d.fromNode, toNode: d.toNode },
    ])
  );
  const rewrites = new Map<string, { from: string; to: string }>(
    ((telemetry.titleRewrites as Array<{ id: string; from: string; to: string }>) ?? []).map((d) => [
      d.id,
      { from: d.from, to: d.to },
    ])
  );

  const survivingIds = orderedIds.filter((id) => !hookDrop.has(id) && !semDrop.has(id) && !finReason.has(id));
  const shippedIds = survivingIds.slice(0, softCap);
  const cutBySoftCapIds = new Set(survivingIds.slice(softCap));

  return { hookDrop, semDrop, finReason, trims, rewrites, shippedIds, cutBySoftCapIds };
}

// ---------------------------------------------------------------------------
// Per-candidate trace
// ---------------------------------------------------------------------------

type TraceStage =
  | "teaser_drop"
  | "not_judged_budget"
  | "not_judged_region_cap"
  | "critic_no_verdict"
  | "critic_rejected"
  | "gate_drop"
  | "snap_drop"
  | "below_threshold"
  | "nms_drop"
  | "cut_by_selection_limit"
  | "finalizer_hook_dedup"
  | "finalizer_duplicate"
  | "finalizer_drop"
  | "cut_by_softcap_after_finalizer"
  | "shipped";

/** Special headline stages for a moment no merged candidate covers at all. */
type MomentHeadline = TraceStage | "scan_miss" | "merge_lost_coverage";

const STAGE_RANK: Record<TraceStage, number> = {
  teaser_drop: 1,
  not_judged_budget: 2,
  not_judged_region_cap: 2,
  critic_no_verdict: 3,
  critic_rejected: 3,
  gate_drop: 4,
  snap_drop: 4,
  below_threshold: 5,
  nms_drop: 5,
  cut_by_selection_limit: 5,
  finalizer_hook_dedup: 6,
  finalizer_duplicate: 6,
  finalizer_drop: 6,
  cut_by_softcap_after_finalizer: 6,
  shipped: 7,
};

interface Ctx {
  nodes: SentenceNode[];
  cfg: AnalyzeConfig;
  mergedById: Map<string, MergedCandidate>;
  teaserDroppedIds: Set<string>;
  teaserRegionEndSec?: number;
  criticCandidateById: Map<string, MergedCandidate>;
  criticReject: Map<string, CriticRejectReason>;
  verdictById: Map<string, CriticVerdict>;
  outcomeById: Map<string, FrontHalfResult["verdictOutcomes"][number]>;
  eligibleById: Map<string, SnappedClip>;
  poolIds: Set<string>;
  tier: "strong" | "weak" | "none";
  nmsWinner: Map<string, string>;
  cutBySoftLimitIds: Set<string>;
  fin: FinalizeCorrelation;
  shippedIndexById: Map<string, number>; // id -> index into result.highlights
  highlights: V2Highlight[];
}

function traceCandidate(id: string, ctx: Ctx): { stage: TraceStage; lines: string[] } {
  const lines: string[] = [];
  const merged = ctx.mergedById.get(id);
  if (!merged) {
    // Should be unreachable - callers only trace ids drawn from mergedById's
    // own keys - but a wrong id here must be loud, not a silent "unknown".
    throw new Error(`[eval-selection-autopsy] traceCandidate: "${id}" is not a merged candidate`);
  }
  const [mStart, mEnd] = candSec(ctx.nodes, merged);
  lines.push(
    `[${id}] merged nodes ${merged.startNode}-${merged.endNode} (${fmtRange(mStart, mEnd)})  ` +
      `interest=${merged.interest.toFixed(2)} type=${merged.type} window=${merged.windowIndex}` +
      (merged.thread ? ` thread=${merged.thread}` : "")
  );

  if (ctx.teaserDroppedIds.has(id)) {
    lines.push(
      `    TEASER: DROPPED - starts inside the detected teaser region (endSec=${ctx.teaserRegionEndSec?.toFixed(1) ?? "?"})`
    );
    return { stage: "teaser_drop", lines };
  }
  lines.push("    TEASER: survived (or no teaser region detected)");

  const criticC = ctx.criticCandidateById.get(id);
  if (!criticC) {
    const reject = ctx.criticReject.get(id);
    lines.push(`    JUDGED: NOT sent to critic - reason=${reject?.reason ?? "?"} (${reject?.detail ?? "no detail"})`);
    return { stage: reject?.reason === "region_cap" ? "not_judged_region_cap" : "not_judged_budget", lines };
  }

  const verdict = ctx.verdictById.get(id);
  if (!verdict) {
    lines.push(
      "    JUDGED: sent to critic but NO verdict returned (omitted/truncated/refused - see aggregate critic telemetry below)"
    );
    return { stage: "critic_no_verdict", lines };
  }
  const [vStart, vEnd] = [ctx.nodes[verdict.startNode]?.start ?? NaN, ctx.nodes[verdict.endNode]?.end ?? NaN];
  lines.push(
    `    JUDGED: keep=${verdict.keep} score=${verdict.score.toFixed(2)} ` +
      `nodes ${verdict.startNode}-${verdict.endNode} (${fmtRange(vStart, vEnd)})`
  );
  if (!verdict.keep) {
    return { stage: "critic_rejected", lines };
  }

  const outcome = ctx.outcomeById.get(id);
  const gate = outcome?.gate;
  if (!gate || !gate.ok) {
    lines.push(`    GATE: DROPPED reason=${gate?.reason ?? "?"}`);
    return { stage: "gate_drop", lines };
  }
  lines.push(`    GATE: ok${gate.outOfRange && gate.outOfRange.length > 0 ? ` (outOfRange: ${gate.outOfRange.join(",")}, repaired downstream)` : ""}`);

  const snap = outcome?.snap;
  if (!snap || !snap.ok) {
    lines.push(`    SNAP: DROPPED reason=${snap && !snap.ok ? snap.reason : "?"}`);
    return { stage: "snap_drop", lines };
  }
  const clip = outcome?.clip;
  if (!clip) {
    throw new Error(`[eval-selection-autopsy] traceCandidate: "${id}" snapped ok but carries no clip`);
  }
  lines.push(`    SNAP: ok -> nodes ${clip.finalStartNode}-${clip.finalEndNode} (${fmtRange(clip.startSec, clip.endSec)})`);

  if (!ctx.poolIds.has(id)) {
    lines.push(
      `    SELECTED: below the score bar for any tier - score=${verdict.score.toFixed(2)} ` +
        `(current pool=${ctx.tier}; scoreThreshold=${ctx.cfg.scoreThreshold}, weakFallbackMinScore=${ctx.cfg.weakFallbackMinScore})`
    );
    return { stage: "below_threshold", lines };
  }
  const nmsWinnerId = ctx.nmsWinner.get(id);
  if (nmsWinnerId) {
    const winnerClip = ctx.eligibleById.get(nmsWinnerId);
    lines.push(
      `    SELECTED: DROPPED by NMS - beaten by [${nmsWinnerId}] ` +
        (winnerClip
          ? `${fmtRange(winnerClip.startSec, winnerClip.endSec)} score=${winnerClip.verdict.score.toFixed(2)}`
          : "(winner not found)")
    );
    return { stage: "nms_drop", lines };
  }
  if (ctx.cutBySoftLimitIds.has(id)) {
    lines.push(
      `    SELECTED: survived NMS but cut by the selection limit (softCap+finalizerHeadroom=` +
        `${ctx.cfg.softCap + ctx.cfg.finalizerHeadroom})`
    );
    return { stage: "cut_by_selection_limit", lines };
  }
  lines.push(`    SELECTED: tier=${ctx.tier}, survived NMS, forwarded to the finalizer`);

  if (ctx.fin.hookDrop.has(id)) {
    lines.push(`    FINALIZED: DROPPED - lexical hook-duplicate of [${ctx.fin.hookDrop.get(id)}]`);
    return { stage: "finalizer_hook_dedup", lines };
  }
  if (ctx.fin.semDrop.has(id)) {
    const d = ctx.fin.semDrop.get(id)!;
    lines.push(
      `    FINALIZED: DROPPED - finalizer-judged duplicate of [${d.duplicateOf}]` +
        (d.sharedClaim ? ` ("${d.sharedClaim}")` : "")
    );
    return { stage: "finalizer_duplicate", lines };
  }
  if (ctx.fin.finReason.has(id)) {
    lines.push(`    FINALIZED: DROPPED reason=${ctx.fin.finReason.get(id)}`);
    return { stage: "finalizer_drop", lines };
  }
  if (ctx.fin.cutBySoftCapIds.has(id)) {
    lines.push(`    FINALIZED: survived the judge but cut by the post-finalizer softCap slice (softCap=${ctx.cfg.softCap})`);
    return { stage: "cut_by_softcap_after_finalizer", lines };
  }
  const idx = ctx.shippedIndexById.get(id);
  const h = idx !== undefined ? ctx.highlights[idx] : undefined;
  if (!h) {
    throw new Error(`[eval-selection-autopsy] traceCandidate: "${id}" reached FINALIZED with no drop reason and no shipped highlight`);
  }
  const trim = ctx.fin.trims.get(id);
  const rewrite = ctx.fin.rewrites.get(id);
  lines.push(
    `    FINALIZED: SHIPPED as highlight #${idx! + 1} "${h.title}" score=${(h.score ?? 0).toFixed(2)} ${fmtRange(h.start, h.end)}` +
      (trim ? ` [trimmed start node ${trim.fromNode}->${trim.toNode}]` : "") +
      (rewrite ? ` [title rewritten by finalizer]` : "")
  );
  return { stage: "shipped", lines };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { labelsPath: labelsOverride, rest } = extractLabelsFlag(process.argv.slice(2));
  const { variant, cases } = parseVariantArgs(rest);
  const [fixtureName] = cases;
  if (!fixtureName || !variant) {
    console.error("usage: eval-selection-autopsy.ts [--variant NAME] [--labels PATH] <fixture>");
    process.exit(1);
  }

  const fixture = loadFixture(fixtureName);
  const cfg: AnalyzeConfig = variantConfig(variant);

  const front = await runFrontHalf(fixture, cfg);
  const result = await runFixtureVariant(fixture, variant);

  const labelsPath = labelsOverride ?? join(FIXTURES_DIR, fixtureName, "labels.json");
  const moments = loadMoments(labelsPath);

  const K = criticBudget(front.nodes, cfg);

  // --- recompute 1, verified against the real engine output -----------------
  const recomputedCritic = recomputeCriticSelection(front.withoutTeasers, front.nodes, cfg, K);
  {
    const a = new Set(recomputedCritic.picked.map((c) => c.id));
    const b = new Set(front.criticCandidates.map((c) => c.id));
    const same = a.size === b.size && [...a].every((id) => b.has(id));
    if (!same) {
      throw new Error(
        "[eval-selection-autopsy] recomputeCriticSelection drifted from the real selectCriticCandidates() " +
          `output (recomputed ${a.size}, engine ${b.size}) - candidates.ts changed and this script's mirror ` +
          "of it (see recomputeCriticSelection) needs to be updated to match. Refusing to print a table built " +
          "on a stale recompute."
      );
    }
  }

  // --- recompute 2, verified against the real engine output -----------------
  const limit = cfg.softCap + cfg.finalizerHeadroom;
  const recomputedSelect = recomputeSelectAndOrder(front.eligible, cfg, limit);
  {
    const a = recomputedSelect.selectedIds;
    const b = new Set(front.selection.selected.map((c) => c.verdict.id));
    const same =
      a.size === b.size &&
      [...a].every((id) => b.has(id)) &&
      recomputedSelect.tier === front.selection.tier &&
      recomputedSelect.nmsWinner.size === front.selection.droppedByNms;
    if (!same) {
      throw new Error(
        "[eval-selection-autopsy] recomputeSelectAndOrder drifted from the real selectAndOrder() output " +
          `(recomputed selected=${a.size}/tier=${recomputedSelect.tier}/nmsDrops=${recomputedSelect.nmsWinner.size}, ` +
          `engine selected=${b.size}/tier=${front.selection.tier}/nmsDrops=${front.selection.droppedByNms}) - ` +
          "select.ts changed and this script's mirror of it needs to be updated to match. Refusing to print a " +
          "table built on a stale recompute."
      );
    }
  }

  // --- finalizer correlation, with a hard consistency check -----------------
  const orderedIds = front.selection.selected.map((c) => c.verdict.id);
  const telemetry = result.telemetry as Record<string, unknown>;
  const fin = correlateFinalizer(orderedIds, telemetry, cfg.softCap);
  if (fin.shippedIds.length !== result.highlights.length) {
    throw new Error(
      "[eval-selection-autopsy] finalizer correlation drifted from the real pipeline: recomputed " +
        `${fin.shippedIds.length} shipped id(s) against ${result.highlights.length} real highlight(s). ` +
        "This means either an extension stage reordered/changed the clip set (this script assumes base-variant " +
        "extension stages are all off) or finalize.ts's ordering guarantee changed. Refusing to print a table " +
        "with a wrong id<->highlight mapping."
    );
  }
  // Spot-check the positional mapping on END seconds: the finalizer only ever
  // TRIMS a start forward and never touches the end, so a correct positional
  // zip must have every shipped highlight's end within rounding of its
  // originating clip's end.
  fin.shippedIds.forEach((id, i) => {
    const clip = front.selection.selected.find((c) => c.verdict.id === id);
    const h = result.highlights[i];
    if (clip && Math.abs(h.end - clip.endSec) > 0.5) {
      throw new Error(
        `[eval-selection-autopsy] finalizer correlation mismatch at position ${i}: id "${id}"'s ` +
          `pre-finalizer end (${clip.endSec.toFixed(1)}s) does not match the shipped highlight's end ` +
          `(${h.end.toFixed(1)}s) - the positional id<->highlight mapping is wrong. Refusing to print a table ` +
          "built on it."
      );
    }
  });
  const shippedIndexById = new Map<string, number>();
  fin.shippedIds.forEach((id, i) => shippedIndexById.set(id, i));

  const mergedById = new Map(front.merged.map((c) => [c.id, c]));
  const teaserDroppedIds = new Set(front.teaserDropped.map((c) => c.id));
  const criticCandidateById = new Map(front.criticCandidates.map((c) => [c.id, c]));
  const verdictById = new Map(front.critic.verdicts.map((v) => [v.id, v]));
  const outcomeById = new Map(front.verdictOutcomes.map((o) => [o.verdict.id, o]));
  const eligibleById = new Map(front.eligible.map((c) => [c.verdict.id, c]));

  const ctx: Ctx = {
    nodes: front.nodes,
    cfg,
    mergedById,
    teaserDroppedIds,
    teaserRegionEndSec: front.teaserRegion?.endSec,
    criticCandidateById,
    criticReject: recomputedCritic.rejectReason,
    verdictById,
    outcomeById,
    eligibleById,
    poolIds: recomputedSelect.poolIds,
    tier: recomputedSelect.tier,
    nmsWinner: recomputedSelect.nmsWinner,
    cutBySoftLimitIds: recomputedSelect.cutBySoftLimitIds,
    fin,
    shippedIndexById,
    highlights: result.highlights,
  };

  // ---------------------------------------------------------------------------
  // header
  // ---------------------------------------------------------------------------
  console.log(
    `fixture: ${fixtureName}${variant === BASE_VARIANT ? "" : `[${variant}]`}  ` +
      `raw scanner candidates: ${front.scan.candidates.length}  merged: ${front.merged.length}  ` +
      `teaser-dropped: ${front.teaserDropped.length}  criticCandidates: ${front.criticCandidates.length} ` +
      `(criticBudgetK=${K})  criticVerdicts: ${front.critic.verdicts.length}  ` +
      `eligible(gate+snap ok): ${front.eligible.length}  selected(pre-finalizer): ${front.selection.selected.length} ` +
      `(tier=${front.selection.tier}, nmsDrops=${front.selection.droppedByNms})  shipped: ${result.highlights.length}`
  );
  if (moments.length === 0) {
    console.log(`no labels found at ${labelsPath} - printing the reverse table only.\n`);
  } else {
    console.log(`labels: ${moments.length} (${labelsPath})\n`);
  }

  // ---------------------------------------------------------------------------
  // forward table: one block per labeled moment (moments[] + missedMoments[])
  // ---------------------------------------------------------------------------
  const histogram = new Map<MomentHeadline, number>();
  const bump = (h: MomentHeadline) => histogram.set(h, (histogram.get(h) ?? 0) + 1);

  for (const moment of moments) {
    const [mStart, mEnd] = moment.range;
    console.log(
      `=== [${moment.kind === "moment" ? "moment" : "MISSED"} #${moment.ordinal}] "${moment.title}" ` +
        `range ${fmtRange(mStart, mEnd)} ===`
    );
    if (moment.entry.note) console.log(`  note: ${moment.entry.note}`);
    const scoutConsensus = moment.entry.scoutConsensus;
    if (scoutConsensus && (scoutConsensus.start !== null || scoutConsensus.end !== null)) {
      console.log(
        `  scoutConsensus: ${scoutConsensus.start ?? "?"}-${scoutConsensus.end ?? "?"}` +
          (scoutConsensus.agreement ? ` (${scoutConsensus.agreement})` : "")
      );
    }
    if (moment.entry.agreement) console.log(`  agreement: ${moment.entry.agreement}`);

    const rawHits: ScanCandidate[] = front.scan.candidates.filter((c) => {
      const [s, e] = candSec(front.nodes, c);
      return covers(mStart, mEnd, s, e);
    });
    if (rawHits.length === 0) {
      console.log("  SCANNED: NO raw scanner candidate (pre-merge) overlaps this moment by >=30% - scan recall miss");
      // Extra context for the "nothing at all" case: the nearest raw candidate
      // by time, whatever its overlap, so a reader can see whether the scanner
      // came close (a windowing/budget problem) or nowhere near (a genuine
      // scanner miss) without re-running anything.
      let nearest: ScanCandidate | null = null;
      let nearestDist = Infinity;
      for (const c of front.scan.candidates) {
        const [s, e] = candSec(front.nodes, c);
        const dist = s > mEnd ? s - mEnd : e < mStart ? mStart - e : 0;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = c;
        }
      }
      if (nearest) {
        const [s, e] = candSec(front.nodes, nearest);
        console.log(
          `    closest raw candidate (no qualifying overlap): window ${nearest.windowIndex} ` +
            `nodes ${nearest.startNode}-${nearest.endNode} (${fmtRange(s, e)}) ` +
            `interest=${nearest.interest.toFixed(2)} type=${nearest.type} - ${nearestDist.toFixed(1)}s away`
        );
      } else {
        console.log("    (the scanner returned zero candidates on this fixture entirely)");
      }
    } else {
      console.log(`  SCANNED: ${rawHits.length} raw candidate(s) overlap >=30%:`);
      for (const c of rawHits) {
        const [s, e] = candSec(front.nodes, c);
        console.log(
          `    - window ${c.windowIndex} nodes ${c.startNode}-${c.endNode} (${fmtRange(s, e)}) ` +
            `interest=${c.interest.toFixed(2)} type=${c.type}${c.thread ? ` thread=${c.thread}` : ""}`
        );
      }
    }

    const mergedHits = front.merged.filter((c) => {
      const [s, e] = candSec(front.nodes, c);
      return covers(mStart, mEnd, s, e);
    });

    let headline: MomentHeadline;
    if (mergedHits.length === 0) {
      if (rawHits.length > 0) {
        console.log(
          "  MERGED: no post-merge candidate retains >=30% overlap - the raw hit(s) above were split away by " +
            "the span guard/thread split in mergeCandidates"
        );
        headline = "merge_lost_coverage";
      } else {
        headline = "scan_miss";
      }
    } else {
      console.log(`  MERGED candidates covering this moment: ${mergedHits.length}`);
      let bestStage: TraceStage | null = null;
      for (const c of mergedHits) {
        const { stage, lines } = traceCandidate(c.id, ctx);
        for (const line of lines) console.log(`  ${line}`);
        if (bestStage === null || STAGE_RANK[stage] > STAGE_RANK[bestStage]) bestStage = stage;
      }
      headline = bestStage!;
    }

    console.log(`  MOMENT VERDICT: ${headline}\n`);
    bump(headline);
  }

  // ---------------------------------------------------------------------------
  // reverse table: shipped clips matching no labeled moment
  // ---------------------------------------------------------------------------
  const allLabelRanges = moments.map((m) => m.range);
  const unlabeledShipped = fin.shippedIds
    .map((id, i) => ({ id, h: result.highlights[i] }))
    .filter(({ h }) => !allLabelRanges.some(([s, e]) => covers(h.start, h.end, s, e)));

  console.log(
    `=== REVERSE TABLE: shipped clips matching NO labeled moment ` +
      `(${unlabeledShipped.length}/${result.highlights.length}) ===`
  );
  if (moments.length === 0) {
    console.log(`  (no labels for this fixture - every shipped clip is listed)`);
  }
  if (unlabeledShipped.length === 0) {
    console.log("  none - every shipped clip matches a labeled moment.");
  }
  for (const { id, h } of unlabeledShipped) {
    const merged = mergedById.get(id);
    const verdict = verdictById.get(id);
    console.log(
      `  "${h.title}" ${fmtRange(h.start, h.end)}  ` +
        `scannerInterest=${merged ? merged.interest.toFixed(2) : "?"}  ` +
        `criticScore=${verdict ? verdict.score.toFixed(2) : (h.score ?? 0).toFixed(2)}`
    );
  }
  console.log();

  // ---------------------------------------------------------------------------
  // kill histogram over labeled moments
  // ---------------------------------------------------------------------------
  const order: MomentHeadline[] = [
    "shipped",
    "scan_miss",
    "merge_lost_coverage",
    "teaser_drop",
    "not_judged_budget",
    "not_judged_region_cap",
    "critic_rejected",
    "critic_no_verdict",
    "gate_drop",
    "snap_drop",
    "below_threshold",
    "nms_drop",
    "cut_by_selection_limit",
    "finalizer_hook_dedup",
    "finalizer_duplicate",
    "finalizer_drop",
    "cut_by_softcap_after_finalizer",
  ];
  console.log(`kill histogram over ${moments.length} labeled moment(s):`);
  for (const stage of order) {
    const n = histogram.get(stage) ?? 0;
    if (n > 0) console.log(`  ${stage}: ${n}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
