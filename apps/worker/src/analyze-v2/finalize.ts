import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import {
  duplicateDropCap,
  findHookDuplicates,
  resolveDuplicatesDetailed,
  type DuplicateClaim,
} from "./dedup";
import { scriptMismatch } from "./language";
import { callJsonSchema } from "./llm";
import { finalizerSystemPrompt, finalizerUserPrompt } from "./prompts";
import { FINALIZER_SCHEMA } from "./schemas";
import { nmsCollides } from "./select";
import { isCleanStart } from "./sentence-graph";
import { snapNodes } from "./snap";
import type {
  FinalizerDropReason,
  FinalizerEntry,
  LlmUsage,
  SentenceNode,
  SnappedClip,
} from "./types";

/** Same ceiling the critic's copy obeys - a longer title is not truncated but
 *  rejected: half a model's sentence is worse copy than the original. */
const MAX_TITLE_CHARS = 70;

// Output budget for the single finalizer call.
//
// DELIBERATELY NOT criticMaxOutputTokens. That curve was measured at batch sizes
// 1/3/6 for a stage whose recovery from truncation is to split the batch and try
// again. This call judges the WHOLE set - up to softCap + finalizerHeadroom = 16
// clips - and it cannot split, because splitting is exactly the cross-clip
// blindness the stage exists to remove. Starvation here therefore costs the
// entire stage, not one batch, which is why the headroom is generous.
//
// ESTIMATED, NOT MEASURED (engine-notes §3 rule: say so). The per-item reasoning
// term is borrowed from the critic's live measurement - 330-450 tokens per item
// at reasoning_effort "low" - and the visible JSON from its stable ~150 tokens
// per verdict. At 16 items that is ~7k reasoning + ~2.4k JSON = ~9.4k, and the
// base covers the whole-set comparison pass the critic has no analogue for.
// Re-measure from a real job's completion_tokens before trusting these numbers.
//
// One call per job, so unlike the critic there is no concurrency multiplier on
// the TPM reservation: ~13k in flight once, against the critic's ~61k.
const FINALIZER_BASE_TOKENS = 2000;
const FINALIZER_TOKENS_PER_CLIP = 700;

/** Output cap for the finalizer call. capMultiplier is the truncation retry. */
export function finalizerMaxOutputTokens(clipCount: number, capMultiplier = 1): number {
  return (FINALIZER_BASE_TOKENS + clipCount * FINALIZER_TOKENS_PER_CLIP) * capMultiplier;
}

/** Why a proposed trim did not move the clip's start. */
export type TrimRejectReason =
  | "not_an_index"
  | "not_forward"
  | "at_or_past_payoff"
  | "not_clean_start"
  | "snap_rejected"
  | "nms_collision";

/** Why a proposed title rewrite did not replace the critic's title. */
export type RewriteRejectReason =
  | "blank"
  | "too_long"
  | "no_evidence"
  | "evidence_out_of_range"
  | "script_mismatch";

/**
 * Everything the stage decided, and why.
 *
 * Deliberately richer than counts. This stage removes clips and rewrites copy
 * behind the user's back; its failure mode is an invisible loss, and nobody ever
 * reports the clip that was never made. `teaserDrops` carries seconds for the
 * same reason - in a job record "c2" alone says nothing.
 */
export interface FinalizeTelemetry {
  /** Lexical opening-line duplicates, dropped before any LLM saw the set. */
  hookDedupDrops: Array<{ id: string; duplicateOf: string }>;
  /** Judge-called duplicates, resolved through the shared duplicate graph. */
  semanticDedupDrops: Array<{ id: string; duplicateOf: string; sharedClaim: string | null }>;
  /** Content drops (everything that is not a duplicate call). */
  finalizerDrops: Array<{ id: string; reason: FinalizerDropReason }>;
  titleRewrites: Array<{ id: string; from: string; to: string }>;
  openingTrims: Array<{ id: string; fromNode: number; toNode: number }>;
  trimRejected: Array<{ id: string; node: number; reason: TrimRejectReason }>;
  rewriteRejected: Array<{ id: string; reason: RewriteRejectReason }>;
  /** Drops the cap withheld - a judge trying to empty the set. */
  dropCapHits: number;
  /** Ids whose content drop was refused because they anchor a duplicate group. */
  dropsProtected: string[];
  /** Present whenever the LLM half did not run: "disabled" or a call outcome. */
  finalizerSkipped?: string;
}

export interface FinalizeResult {
  clips: SnappedClip[];
  telemetry: FinalizeTelemetry;
}

export function emptyFinalizeTelemetry(): FinalizeTelemetry {
  return {
    hookDedupDrops: [],
    semanticDedupDrops: [],
    finalizerDrops: [],
    titleRewrites: [],
    openingTrims: [],
    trimRejected: [],
    rewriteRejected: [],
    dropCapHits: 0,
    dropsProtected: [],
  };
}

const DROP_REASONS: ReadonlySet<string> = new Set<FinalizerDropReason>([
  "duplicate",
  "unanswered_title",
  "broken_opening",
  "no_payoff",
  "redundant",
  "teaser_montage",
  "incoherent",
]);

/**
 * Deterministic application of finalizer output. PURE: no I/O, no LLM, no clock.
 *
 * Every field the model emitted is a PROPOSAL. Nothing here trusts it: a trim
 * must be a legal clip start before the payoff that survives a fresh snapNodes
 * AND leaves the set free of new NMS collisions; a rewrite must be short, in the
 * clip's script, and grounded in evidence inside the clip's FINAL range; drops
 * are capped and routed through the shared duplicate graph. Boundaries stay
 * code-owned (spec §4.4, engine-notes §6).
 *
 * Order is load-bearing and is: drops -> trims -> rewrites. A trim narrows the
 * range a rewrite's evidence is checked against, so validating copy first would
 * accept a title grounded in words the viewer never hears.
 */
export function applyFinalizerEntries(
  clips: SnappedClip[],
  entries: FinalizerEntry[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): FinalizeResult {
  const telemetry = emptyFinalizeTelemetry();

  // A hallucinating judge can name one clip twice. First entry wins: later rows
  // are no more trustworthy and silently preferring the last one would make the
  // outcome depend on emission order.
  const byId = new Map<string, FinalizerEntry>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);

  const scores: Record<string, number> = {};
  for (const c of clips) scores[c.verdict.id] = c.verdict.score;

  // --- 1. drops --------------------------------------------------------------
  // Duplicate calls go through the shared duplicate graph so cycles, chains and
  // the "strongest member survives" rule behave identically for the lexical pass
  // and this one. Everything else is a plain content drop.
  const claims: DuplicateClaim[] = [];
  const plainDrops: Array<{ id: string; reason: FinalizerDropReason }> = [];
  for (const c of clips) {
    const e = byId.get(c.verdict.id);
    if (!e || e.verdict !== "drop") continue;
    const reason: FinalizerDropReason =
      e.dropReason && DROP_REASONS.has(e.dropReason) ? e.dropReason : "incoherent";
    if (e.duplicateOf && scores[e.duplicateOf] !== undefined && e.duplicateOf !== e.id) {
      claims.push({ id: e.id, duplicateOf: e.duplicateOf });
    } else {
      plainDrops.push({ id: c.verdict.id, reason });
    }
  }

  // ONE budget for both families, spent on duplicates first. A duplicate drop is
  // the cheapest loss the set can take - the claim still ships in the survivor -
  // while a content drop removes a moment outright. Two independent caps would
  // also compose into "half plus half", i.e. no cap at all.
  const budget = duplicateDropCap(clips.length);
  const dup = resolveDuplicatesDetailed(claims, scores, budget);
  telemetry.dropCapHits = dup.dropCapHits;

  const dupDropped = new Set(dup.drops);
  // The survivor of a duplicate group is immune to a content drop: honouring
  // both "b duplicates a" and "a is incoherent" deletes the claim entirely while
  // telemetry calls it a duplicate. A judge that says both is contradicting
  // itself, and the conservative half of a contradiction is to keep the clip.
  const groupSurvivors = new Set<string>();
  for (const claim of claims) {
    for (const id of [claim.id, claim.duplicateOf]) {
      if (!dupDropped.has(id)) groupSurvivors.add(id);
    }
  }

  const dropped = new Set(dupDropped);
  let remaining = Math.max(0, budget - dup.drops.length);
  const orderedPlain = [...plainDrops].sort(
    (a, b) => scores[a.id] - scores[b.id] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  for (const drop of orderedPlain) {
    if (dropped.has(drop.id)) continue;
    if (groupSurvivors.has(drop.id)) {
      telemetry.dropsProtected.push(drop.id);
      continue;
    }
    if (remaining <= 0) {
      telemetry.dropCapHits += 1;
      continue;
    }
    dropped.add(drop.id);
    remaining -= 1;
    telemetry.finalizerDrops.push(drop);
  }

  for (const id of dup.drops) {
    const e = byId.get(id);
    telemetry.semanticDedupDrops.push({
      id,
      duplicateOf: e?.duplicateOf ?? "",
      sharedClaim: e?.sharedClaim ?? null,
    });
  }

  const survivors = clips.filter((c) => !dropped.has(c.verdict.id));

  // --- 2. trims --------------------------------------------------------------
  // A clip whose drop the cap refused ships UNCHANGED. Its trim was never
  // offered as "this makes the clip good" - the judge concluded it should not
  // ship at all - so a capped drop is a no-op, never a half-application of
  // advice given under the opposite conclusion.
  const capRefused = new Set(
    plainDrops.map((d) => d.id).filter((id) => !dropped.has(id))
  );
  const proposed: Array<SnappedClip | null> = survivors.map(() => null);
  const rejects = new Map<number, { node: number; reason: TrimRejectReason }>();

  survivors.forEach((clip, i) => {
    const e = byId.get(clip.verdict.id);
    if (!e || e.trimStartNode === null || capRefused.has(clip.verdict.id)) return;
    const attempt = tryTrim(clip, e.trimStartNode, nodes, cfg);
    if (attempt.ok) proposed[i] = attempt.clip;
    else rejects.set(i, { node: e.trimStartNode, reason: attempt.reason });
  });

  // NMS ran in select.ts BEFORE this stage and is never re-run after it, so a
  // trim is the one thing in the engine that can put an overlapping pair in the
  // shipped set. It genuinely can: the collision test is a RATIO of the shorter
  // clip, and a trim shrinks the clip while leaving any overlap at its TAIL
  // untouched. Concretely, a=[0,41] and b=[35.85,81] overlap 5.15s = 13% of the
  // shorter - accepted; trim a to [29.85,41] and the same 5.15s is 46% of it.
  // (spec §4.4 asserts this cannot happen; it is wrong, and the counterexample
  // is in finalize.test.ts.)
  //
  // Fixpoint, not a single pass: reverting one trim can uncover a pair the
  // reverted clip's longer form now collides with. It terminates because every
  // round reverts at least one trim and restores an ORIGINAL interval, and the
  // set of all originals is collision-free by construction - selection just
  // proved it. Worst case every trim is withdrawn.
  const state = survivors.map((c, i) => proposed[i] ?? c);
  for (let round = 0; round <= survivors.length; round++) {
    let reverted = false;
    outer: for (let i = 0; i < state.length; i++) {
      for (let j = i + 1; j < state.length; j++) {
        if (!nmsCollides(state[i], state[j])) continue;
        for (const k of [i, j]) {
          if (!proposed[k]) continue;
          const e = byId.get(survivors[k].verdict.id);
          rejects.set(k, {
            node: e?.trimStartNode ?? survivors[k].verdict.startNode,
            reason: "nms_collision",
          });
          proposed[k] = null;
          state[k] = survivors[k];
          reverted = true;
        }
        // A colliding pair with no trim on either side predates this stage;
        // inventing a drop for it is not this stage's job.
        if (reverted) break outer;
      }
    }
    if (!reverted) break;
  }

  survivors.forEach((clip, i) => {
    const reject = rejects.get(i);
    if (reject) {
      telemetry.trimRejected.push({ id: clip.verdict.id, ...reject });
      return;
    }
    if (proposed[i]) {
      telemetry.openingTrims.push({
        id: clip.verdict.id,
        fromNode: clip.verdict.startNode,
        toNode: state[i].verdict.startNode,
      });
    }
  });

  // --- 3. rewrites -----------------------------------------------------------
  // AFTER the trim fixpoint: evidence is judged against the range the viewer
  // will actually see, which is neither the pre-trim range nor a proposed one.
  const out = state.map((clip, i) => {
    const id = survivors[i].verdict.id;
    const e = byId.get(id);
    if (!e || e.title === null || capRefused.has(id)) return clip;
    const attempt = tryRewrite(clip, e, nodes);
    if (!attempt.ok) {
      telemetry.rewriteRejected.push({ id, reason: attempt.reason });
      return clip;
    }
    telemetry.titleRewrites.push({
      id,
      from: clip.verdict.title,
      to: attempt.clip.verdict.title,
    });
    return attempt.clip;
  });

  return { clips: out, telemetry };
}

type TrimAttempt =
  | { ok: true; clip: SnappedClip }
  | { ok: false; reason: TrimRejectReason };

/**
 * A trim must be a real node index of this clip, move the start FORWARD, land
 * on a legal clip start, sit strictly before the payoff, and survive a fresh
 * snapNodes - which re-checks clean start, payoff containment, the 90s cap, the
 * 6s floor and every boundary invariant. Anything else keeps the original.
 */
function tryTrim(
  clip: SnappedClip,
  target: number,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): TrimAttempt {
  const v = clip.verdict;
  if (!Number.isInteger(target) || target < 0 || target >= nodes.length) {
    return { ok: false, reason: "not_an_index" };
  }
  if (target > v.endNode) return { ok: false, reason: "not_an_index" };
  if (target <= v.startNode) return { ok: false, reason: "not_forward" };
  if (target >= v.payoffNode) return { ok: false, reason: "at_or_past_payoff" };
  if (!isCleanStart(nodes, target)) return { ok: false, reason: "not_clean_start" };

  // The hook cannot stay behind the new start. hookEndNode is clamped to the
  // payoff so the widened hook can never swallow it - snap requires
  // hookEnd <= end and hookStart < hookEnd.
  const hookStartNode = Math.max(v.hookStartNode, target);
  const hookEndNode = Math.min(Math.max(v.hookEndNode, hookStartNode + 1), v.endNode);
  if (hookEndNode <= hookStartNode) return { ok: false, reason: "at_or_past_payoff" };

  const snapped = snapNodes(
    { ...v, startNode: target, hookStartNode, hookEndNode },
    nodes,
    cfg
  );
  if (!snapped.ok) return { ok: false, reason: "snap_rejected" };
  return { ok: true, clip: { ...clip, ...snapped.clip } };
}

type RewriteAttempt =
  | { ok: true; clip: SnappedClip }
  | { ok: false; reason: RewriteRejectReason };

/**
 * A rewrite must be non-empty, within the same 70-char ceiling the critic's copy
 * obeys, grounded in 1-3 evidence nodes inside the clip's FINAL [startNode,
 * endNode] - the same range rule evidenceGate applies - and written in the
 * clip's own script.
 *
 * The language check is scriptMismatch, never lexicalOverlap: overlap penalizes
 * paraphrase and inflection, and an honest rewrite of a Russian clip is exactly
 * a paraphrase (engine-notes §6).
 */
function tryRewrite(
  clip: SnappedClip,
  entry: FinalizerEntry,
  nodes: SentenceNode[]
): RewriteAttempt {
  const title = (entry.title ?? "").trim();
  if (title.length === 0) return { ok: false, reason: "blank" };
  if (Array.from(title).length > MAX_TITLE_CHARS) return { ok: false, reason: "too_long" };

  const evidence = entry.titleEvidenceNodes;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, reason: "no_evidence" };
  }
  const { startNode, endNode } = clip.verdict;
  for (const idx of evidence) {
    if (!Number.isInteger(idx) || !nodes[idx] || idx < startNode || idx > endNode) {
      return { ok: false, reason: "evidence_out_of_range" };
    }
  }

  const clipText = nodes
    .slice(startNode, endNode + 1)
    .filter((n) => n.hasWords)
    .map((n) => n.text)
    .join(" ");
  if (scriptMismatch(title, clipText)) return { ok: false, reason: "script_mismatch" };

  return {
    ok: true,
    clip: {
      ...clip,
      verdict: { ...clip.verdict, title, titleEvidenceNodes: [...evidence] },
    },
  };
}

export interface FinalizeOptions {
  /** Test hook - forwarded to callJsonSchema. */
  retryDelayMs?: number;
}

/**
 * The FINALIZE stage: deterministic hook dedup, then ONE LLM pass over the whole
 * surviving set, then the code gates above.
 *
 * NEVER throws. Every failure - disabled, error, refusal, truncation, refusal
 * after fallback, unparseable payload, or a bug in this file - ships the input
 * set with `finalizerSkipped` naming the outcome. This stage has veto authority
 * over clips the engine already approved; it must never be able to turn a
 * content answer into a failed job (billing invariant, engine-notes §6).
 *
 * The lexical pass runs FIRST so an LLM outage still removes the near-identical
 * openings a montage produces. Each pass caps its own drops at floor(n/2), so
 * the composition still cannot empty the set.
 */
export async function finalizeClips(
  client: OpenAI,
  usage: LlmUsage,
  clips: SnappedClip[],
  nodes: SentenceNode[],
  languageIso: string,
  languageName: string,
  cfg: AnalyzeConfig,
  options: FinalizeOptions = {}
): Promise<FinalizeResult> {
  if (clips.length === 0) {
    return { clips, telemetry: emptyFinalizeTelemetry() };
  }

  const scores: Record<string, number> = {};
  for (const c of clips) scores[c.verdict.id] = c.verdict.score;

  const hookClaims = findHookDuplicates(
    clips.map((c) => ({
      id: c.verdict.id,
      score: c.verdict.score,
      hook: nodes[c.verdict.startNode]?.text ?? "",
    })),
    cfg.hookDedupSimilarity
  );
  const hookDropped = new Set(
    resolveDuplicatesDetailed(hookClaims, scores, duplicateDropCap(clips.length)).drops
  );
  const hookDedupDrops = hookClaims
    .filter((c) => hookDropped.has(c.id))
    .map((c) => ({ id: c.id, duplicateOf: c.duplicateOf }));
  const survivors = clips.filter((c) => !hookDropped.has(c.verdict.id));

  const skip = (reason: string): FinalizeResult => ({
    clips: survivors,
    telemetry: { ...emptyFinalizeTelemetry(), hookDedupDrops, finalizerSkipped: reason },
  });

  if (!cfg.finalizerEnabled) return skip("disabled");
  if (survivors.length === 0) return skip("empty");

  try {
    const call = (model: string, capMultiplier: number) =>
      callJsonSchema<{ clips?: unknown }>(client, usage, {
        model,
        system: finalizerSystemPrompt(languageIso, languageName),
        user: finalizerUserPrompt(survivors, nodes),
        schema: FINALIZER_SCHEMA as unknown as {
          name: string;
          strict: boolean;
          schema: unknown;
        },
        maxOutputTokens: finalizerMaxOutputTokens(survivors.length, capMultiplier),
        reasoningEffort: cfg.reasoningEffort,
        retryDelayMs: options.retryDelayMs,
      });

    let result = await call(cfg.finalizerModel, 1);
    // No batch split exists here - one call IS the stage - so the only truncation
    // recovery is more room. A second failure ships the set unjudged, which is
    // the right way round: the input already passed every earlier gate.
    if (!result.ok && result.kind === "truncated") result = await call(cfg.finalizerModel, 2);
    if (!result.ok && result.kind === "refusal") result = await call(cfg.finalizerModel, 1);
    // llm.ts already retried a hard error once with backoff; try the fallback
    // model exactly as the critic does.
    if (!result.ok && result.kind === "error") {
      result = await call(cfg.criticModelFallback, 1);
    }
    if (!result.ok) return skip(result.kind);

    const rows = Array.isArray(result.data?.clips) ? (result.data.clips as unknown[]) : [];
    const entries = rows.flatMap((raw) => {
      const entry = normalizeEntry(raw);
      return entry ? [entry] : [];
    });

    const applied = applyFinalizerEntries(survivors, entries, nodes, cfg);
    return { clips: applied.clips, telemetry: { ...applied.telemetry, hookDedupDrops } };
  } catch (error) {
    // Belt and braces: callJsonSchema already swallows API failures, so reaching
    // here means a defect in this file or in prompt rendering. A judge that
    // crashes must still ship the set someone already approved.
    console.warn(
      `[analyze-v2] finalizer threw, shipping the set unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return skip("exception");
  }
}

/**
 * snake_case row -> FinalizerEntry, or null when the row is not readable.
 *
 * The asymmetry is deliberate and always points the same way: an out-of-contract
 * field can never COST a clip. `drop_reason` is a closed enum in a strict schema,
 * so a value outside it means the judge left the contract - and a veto is the
 * last thing to honour on that evidence, so the whole row is discarded and the
 * clip ships. A null reason is schema-legal and becomes "incoherent". An
 * unreadable `verdict` falls back to "ship" for the same reason.
 */
function normalizeEntry(raw: unknown): FinalizerEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (row.drop_reason !== null && row.drop_reason !== undefined) {
    if (typeof row.drop_reason !== "string" || !DROP_REASONS.has(row.drop_reason)) {
      return null;
    }
  }
  const dropReason =
    typeof row.drop_reason === "string" ? (row.drop_reason as FinalizerDropReason) : null;
  return {
    id: row.id,
    verdict: row.verdict === "drop" ? "drop" : "ship",
    dropReason,
    duplicateOf: typeof row.duplicate_of === "string" ? row.duplicate_of : null,
    sharedClaim: typeof row.shared_claim === "string" ? row.shared_claim : null,
    title: typeof row.title === "string" ? row.title : null,
    titleEvidenceNodes: Array.isArray(row.title_evidence_nodes)
      ? (row.title_evidence_nodes as number[])
      : null,
    trimStartNode:
      typeof row.trim_start_node === "number" ? row.trim_start_node : null,
  };
}
