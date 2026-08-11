import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { isFullyOk } from "./arc-audit";
import { callJsonSchema, logModelFallback } from "./llm";
import { EXTENSION_SYSTEM, buildExtensionUser } from "./prompts";
import { END_EXTENSION_SCHEMA } from "./schemas";
import { endsOnQuestionMark, isCleanEnd } from "./sentence-graph";
import { sceneEndAfter } from "./scene-gaps";
import { endSecFor } from "./snap";
import type {
  ArcExitDefect,
  ArcFlags,
  ExtensionWindow,
  LlmUsage,
  SentenceNode,
  SnappedClip,
} from "./types";

/** Would a clip ending on this node still fit the platform cap? One expression,
 *  two callers - the window that stops offering ends past the cap, and the gate
 *  that would refuse one - so the ceiling and its backstop cannot drift apart.
 *
 *  `blessed` (spec 2026-08-10 task 5, item 4) raises the ceiling to
 *  `cfg.longClipMaxSec` when `cfg.longClipsEnabled` and the clip is
 *  arc-audit-blessed (`isFullyOk`) - mirrors start-extension.ts's own
 *  fitsMaxSec exactly. Defaults to `false` so every pre-task-5 caller (this
 *  file's own suite included) keeps today's ceiling unchanged. UNLIKE
 *  start-extension's gate, this one IS reachable: end-extension's
 *  SELF-MOTIVATED path (`endExtensionEnabled`) offers every clip with a
 *  non-empty window regardless of its flags, so a clip whose arc-audit
 *  verdict is fully ok - including one the long-clip policy already shipped
 *  wide - can legitimately reach here blessed. */
function fitsMaxSec(
  clip: SnappedClip,
  node: SentenceNode,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  blessed: boolean = false
): boolean {
  const ceilingSec = cfg.longClipsEnabled && blessed ? cfg.longClipMaxSec : cfg.maxSec;
  return endSecFor(nodes, node, cfg) - clip.startSec <= ceilingSec;
}

/**
 * How far this clip is allowed to reach. The tightest of three bounds: the next
 * scene cut, endExtensionWindowSec of wall clock, and maxSec.
 *
 * A CEILING, never a target. Nothing here says a clip should end at lastNode -
 * it says nothing past lastNode may be offered to a model or accepted from one.
 *
 * No bound here is decoration. The scene rail is PARTIAL by construction: it
 * finds the cuts that fall silent and not the ones an audience laughs through,
 * and nothing at all in a source with no hard cuts, which is what both podcast
 * fixtures are (scene-gaps.ts holds that measurement and is the single copy of
 * it). Where the rail is blind the clock is the only thing between a clip and
 * the rest of the video; where the clock is generous the rail is what stops a
 * compilation clip from stapling two unrelated scenes together. And maxSec is
 * the platform cap, which this is the only stage that can approach from below:
 * snapNodes compresses an over-long clip by moving its START, and moving the
 * start is exactly what this stage promises not to do.
 *
 * maxSec is applied here as well as in the gate so that the model is not offered
 * ends it cannot have: 5 of the 111 candidates this window used to hand out on
 * sitcom-friends were over the cap, and every one of them was a choice destined
 * to be thrown away.
 *
 * THE TWO BOUNDS BEHAVE DIFFERENTLY INSIDE THE LOOP, and the asymmetry is the
 * whole correctness argument.
 *
 * The deadline BREAKS. It bounds the material the model may reach INTO, a node's
 * own end is the right proxy for that, and being conservative there costs only
 * reach. maxSec must not break, because it bounds the SHIPPED clip's duration -
 * and the shipped clip is cut at endSecFor(END NODE), so an intervening node
 * never lengthens it. Word timings nest (the `max, not last` comment on `end:`
 * in buildSentenceGraph), so node 35 can carry a word running to 92s while node
 * 36 closes at 74s: with a break, a clip ending at node 34 loses nine legal ends
 * and drops out of the prompt entirely; with a skip it keeps all nine, and the
 * one node that really is over the cap is refused by the gate as `too_long`.
 * Breaking made this ceiling STRICTER than the gate it exists to mirror, which
 * is the one thing a ceiling must never be. Built by hand, because no fixture
 * can produce it: no shipped clip on any of the four ends on a node whose nested
 * end overruns its successor (the harness blind spot, engine-notes §5).
 *
 * So maxSec is a PER-NODE predicate here, like opacity and a clean end, not a
 * truncation of the list: `lastNode` is the furthest node that is itself a legal
 * end, and the contiguous run up to it can contain one that is not.
 *
 * The deadline is measured from the END NODE's last word, not from clip.endSec,
 * so the tail hold is not charged against the window: the hold is silence, and
 * "25 seconds further" should mean 25 seconds of further material. A node ending
 * exactly on the deadline is inside it, and so is a clip landing exactly on
 * maxSec.
 *
 * The deadline's break is not an accident of style. A clip is a contiguous
 * range: node i+1 cannot play without node i, so a node whose end is past the
 * window closes the reach behind it rather than being stepped over.
 *
 * clip.finalEndNode must be a real index into `nodes` - sceneEndAfter refuses to
 * invent a ceiling for an invalid one, and neither does this.
 *
 * `blessed` (spec 2026-08-10 task 5) - threaded straight into `fitsMaxSec`, so
 * this window and the gate that later re-checks a chosen node against
 * `fitsMaxSec` can never disagree about the ceiling. Defaults to `false`.
 */
export function extensionWindow(
  clip: SnappedClip,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  blessed: boolean = false
): ExtensionWindow {
  const from = clip.finalEndNode;
  const sceneEnd = sceneEndAfter(nodes, from, cfg);
  const deadline = nodes[from].end + cfg.endExtensionWindowSec;
  let last = from;
  for (let i = from + 1; i <= sceneEnd; i++) {
    if (nodes[i].end > deadline) break;
    if (fitsMaxSec(clip, nodes[i], nodes, cfg, blessed)) last = i;
  }
  return { lastNode: last };
}

/** Why a proposal was turned down, one value per `return` below. The spellings
 *  match snap's DropReason wherever they mean the same thing.
 *
 *  THE ORDER IS THE FILING RULE. The gates short-circuit in the order listed
 *  here, so a node failing two of them is filed under the earlier one and the
 *  histogram is a partition rather than a tally of independent faults. It is not
 *  a rare tie-break: on sitcom-friends 3 of the 26 candidates counted
 *  `opaque_end` also fail `isCleanEnd`, so 3 of 35 refusals would move if the
 *  order changed. Anyone reading the split to choose a prompt edit needs that -
 *  `opaque_end` means "opaque, and possibly more", never "opaque only".
 *
 *  A NAMED reason rather than a bare null because the histogram it feeds is the
 *  only thing that can answer the question the stage's telemetry poses: a
 *  `refused` count that is rising says the model and the gates disagree, and
 *  only the reason says WHAT to do about it - a prompt that marks opaque lines
 *  and a prompt that explains what a clean end is are different edits. Both
 *  siblings discriminate for the same reason (critic.ts's four drop counters,
 *  finalize.ts's TrimRejectReason). */
export type ExtensionRefuseReason =
  | "not_an_index"
  | "not_forward"
  | "outside_graph"
  | "clip_end_unusable"
  | "outside_window"
  | "opaque_end"
  | "no_clean_end"
  | "no_gain"
  | "too_long";

/** Mirrors SnapResult and finalize's RewriteAttempt: the widened clip, or the
 *  reason there is none. */
export type ExtensionAttempt =
  | { ok: true; clip: SnappedClip }
  | { ok: false; reason: ExtensionRefuseReason };

/**
 * Applies a proposed end node, or refuses it.
 *
 * Refusal is the default. Every branch below is a way for a model's proposal to
 * be wrong, and the caller's only job is to keep the clip it already had when
 * one fires. Nothing here is advisory.
 *
 * TOTAL, unlike extensionWindow: any clip, any number, either a widened clip or
 * a reason - never a throw. A stage that runs once per shipped clip must not be
 * able to fail a whole job over one bad answer. That holds only because the
 * clip's OWN end node is checked at both ends before the window is computed:
 * the upper bound falls out of the gate pairing below, the lower one needs its
 * own line, and -1 and NaN both proved it by throwing.
 *
 * This stage may only ever move an end FORWARD: shortening is the finalizer's
 * `trim`, which has its own gates, and more importantly a shorter range can push
 * titleEvidenceNodes outside the clip and silently degrade copy - engine-notes
 * §6 "boundaries are code-owned", and the `Плюсы` defect it points at in §4.
 * Widening cannot, which is the whole reason this stage is safe to run after
 * copy has been grounded.
 *
 * The gates, and what each one is for:
 *
 * - INTEGER. A model that answers 8.5, or a NaN out of a parse, must never be
 *   used as an array index - nodes[8.5] is undefined and every later gate reads
 *   a property off it.
 * - FORWARD ONLY, by index. The never-shorten rule, stated above.
 * - INSIDE THE GRAPH. Not a duplicate of the window gate, which would refuse an
 *   out-of-range proposal too. Paired with the forward-only gate above, it caps
 *   clip.finalEndNode from ABOVE - nothing can be both `> finalEndNode` and
 *   `<= nodes.length - 1` unless finalEndNode is under the top of the graph -
 *   and it does so BEFORE extensionWindow dereferences nodes[finalEndNode].end.
 *   Delete it and a clip carrying a stale end node turns a refusal into a
 *   TypeError thrown out of a stage that must never throw.
 * - THE CLIP'S OWN END IS A REAL INDEX, from below. The pairing above proves
 *   nothing about a negative or NaN finalEndNode, so that is its own gate. Not
 *   reachable through snapNodes, whose idxOk already demands >= 0; it is here
 *   because the totality promise above is unconditional and a future caller
 *   handing this stage a clip from somewhere else must get a reason, not a throw.
 * - INSIDE THE WINDOW. The scene cut, the clock and maxSec, above.
 * - WORD-BEARING. An opaque node's timings are segment-level (music, laughter,
 *   crosstalk), so ending on one puts the boundary at a coarse Whisper edge.
 *   snapNodes walks BACK off an opaque end - but only while a word-bearing node
 *   exists at or after the payoff; when the PAYOFF itself is opaque it keeps the
 *   opaque end and marks the clip segment-confidence, which is how 2 of the 12
 *   shipped sitcom-friends clips end. So this gate is stricter than snap on
 *   exactly those clips, and unconditionally: keeping an end the payoff forced
 *   is not the same decision as MOVING onto one, and only the second is this
 *   stage's to make.
 * - CLEAN END. The same test snap applies to every other end. A weak trailing
 *   boundary followed by a lowercase continuation is a mid-clause cut, and a
 *   clip that ends mid-clause is worse than a clip that ends early - which is
 *   the whole complaint this stage exists to answer.
 * - FORWARD ONLY, in seconds. Not implied by the index gate: word timings nest,
 *   so a later node can end EARLIER than the clip already does, and such a
 *   proposal would shorten the clip - and can strand the payoff outside it -
 *   while passing every index check. Equality is refused too, because a node
 *   whose whole span is already inside the clip adds no ending to extend; this
 *   is the same no-op the index gate refuses, wearing a different index. So an
 *   ACCEPTED extension always moves endSec strictly later, which is the property
 *   callers and telemetry can rely on.
 * - MAX LENGTH. The platform cap, and REACHABLE: the window skips over a node
 *   that breaches it rather than stopping there (see extensionWindow for why),
 *   so a node inside the offered run can still be over the cap when word timings
 *   nest, and this is what refuses it. Shares fitsMaxSec with the window, so the
 *   ceiling and the gate cannot answer differently.
 *
 * `blessed` (spec 2026-08-10 task 5) - passed straight to both extensionWindow
 * and the final fitsMaxSec gate, so the candidate list this function's caller
 * offered and the ceiling this function enforces always agree on which cap is
 * in effect. Defaults to `false`, so every pre-task-5 caller (including this
 * file's own suite) keeps today's ceiling exactly.
 */
export function applyExtension(
  clip: SnappedClip,
  nodes: SentenceNode[],
  proposedEndNode: number,
  cfg: AnalyzeConfig,
  blessed: boolean = false
): ExtensionAttempt {
  const no = (reason: ExtensionRefuseReason): ExtensionAttempt => ({ ok: false, reason });

  if (!Number.isInteger(proposedEndNode)) return no("not_an_index");
  if (proposedEndNode <= clip.finalEndNode) return no("not_forward");
  if (proposedEndNode > nodes.length - 1) return no("outside_graph");

  // The gates above bound the clip's own end from ABOVE only. Nothing there
  // rules out a negative, fractional or NaN finalEndNode, and each of those
  // reaches undefined inside extensionWindow - measured, not feared: -1 and NaN
  // throw on `nodes[from].end`, 2.5 throws inside sceneEndAfter.
  if (!Number.isInteger(clip.finalEndNode) || clip.finalEndNode < 0) {
    return no("clip_end_unusable");
  }

  const { lastNode } = extensionWindow(clip, nodes, cfg, blessed);
  if (proposedEndNode > lastNode) return no("outside_window");

  const e = nodes[proposedEndNode];
  if (!e.hasWords) return no("opaque_end");
  if (!isCleanEnd(nodes, proposedEndNode)) return no("no_clean_end");

  // snap's own arithmetic, called rather than copied: an end this stage MOVES
  // has to land where snap would have put it.
  const endSec = endSecFor(nodes, e, cfg);
  if (endSec <= clip.endSec) return no("no_gain");
  if (!fitsMaxSec(clip, e, nodes, cfg, blessed)) return no("too_long");

  // A NEW clip, never the argument mutated: clips travel by reference between
  // stages, and an accepted extension must not reach back into the caller's copy.
  //
  // Two fields are DERIVED from the end and are recomputed with snap's own
  // expressions (snap.ts:204-206), because carrying them forward would leave the
  // clip describing an end it no longer has. shortMoment is a length verdict and
  // this stage changes the length; it is persisted onto the highlight, so a stale
  // `true` would file a 20s clip as a fragment. endsOnQuestion names the last
  // sentence, and reaching the answer to a question the clip ended on is one of
  // the beats this stage exists for - the flag has to move with the end. Its
  // consumer (select.ts) has already run and priced the old end.
  //
  // boundaryConfidence is NOT recomputed and does not need to be. It reads
  // "segment" exactly when the PAYOFF is opaque - snap walks an opaque end back
  // to a word-bearing node whenever one exists at or after the payoff, and keeps
  // the opaque end only when the payoff is opaque itself - and the payoff cannot
  // move here. So the value snap derived still holds, including for a clip that
  // extends OFF an opaque end onto a word-bearing one: the end got sharper, the
  // payoff the flag describes did not.
  return {
    ok: true,
    clip: {
      ...clip,
      endSec,
      finalEndNode: proposedEndNode,
      shortMoment: endSec - clip.startSec < cfg.targetMinSec,
      endsOnQuestion: endsOnQuestionMark(e.text),
    },
  };
}

// Output budget for the single extension call.
//
// ESTIMATED, NOT MEASURED (engine-notes §3 rule: say so). Per clip the visible
// JSON is one small row - id, a boolean, an integer and a short clause, call it
// 40-60 tokens against the critic's MEASURED ~150 for a row carrying a title, a
// description and two evidence arrays. The reasoning term is borrowed from the
// critic's Luna measurement, 68-171 tokens per candidate for a harder judgement
// over a padded window, so ~230 is the worst case this shape suggests and 250
// carries a small margin. The base covers the read of the rules plus the JSON
// scaffold. At the softCap of 12 clips that is 3600 against an estimate near
// 2800.
//
// The two errors are not symmetric, which is why the margin sits where it does:
// there is no truncation retry here, so starvation costs the WHOLE stage for the
// job, while over-sizing costs nothing - an unused cap is not billed (the same
// argument critic.ts makes about its own headroom). Re-measure from a real job's
// completion_tokens once the stage has run one.
const EXTENSION_BASE_TOKENS = 600;
const EXTENSION_TOKENS_PER_CLIP = 250;

/** Output cap for the one call this stage makes. */
export function extensionMaxOutputTokens(clipCount: number): number {
  return EXTENSION_BASE_TOKENS + EXTENSION_TOKENS_PER_CLIP * clipCount;
}

/**
 * What the stage did, in the numbers that can each be wrong differently.
 *
 * `skipped` is the first thing to read, and the reason it exists is that every
 * other field is zero in two situations that mean opposite things: the stage
 * never ran, and the stage ran and declined every clip. A refusal, a truncation,
 * an unreadable payload and an honest `extend: false` on all twelve clips all
 * emit the same zeros. `finalizerSkipped` solves this for FINALIZE and this is
 * the same field for the same reason - a degradation recorded only in a log line
 * is a degradation nobody notices (job cmscht6rp001xq41s5rhjx6q0).
 *
 * `offered` counts clips with somewhere to go - a non-empty window - not clips
 * shipped: a set where offered is far below the shipped count means the scene
 * rail, the clock or maxSec is binding, not the model. Task 4 adds one more way
 * IN: a clip arcAudit gave a gated exit hint is offered even with an empty
 * self-motivated window, on the argument that the hint's own gate (gateExitFix)
 * already bounds it by the clock and the model should still see the note - the
 * scene rail and maxSec remain the gates that decide whether anything it
 * proposes is actually accepted.
 *
 * `proposed` counts the model's extend:true rows. `applied` and `refused` split
 * those by what the gates said, and the gap between proposed and applied+refused
 * is rows naming an id that is not in the set at all - a model inventing clips.
 * `contradicted` counts the clips it answered about TWICE, whose proposals are
 * dropped and which would otherwise be invisible in the zeros above.
 *
 * `refusedBy` is what makes `refused` actionable. A rising refused count says
 * the model and the gates disagree; only the reason says what to do about it,
 * and the repairs are different - mark opaque lines in the prompt, explain what
 * a clean end is, or leave the prompt alone because the model is naming clips it
 * was never shown (`not_offered` is a hallucination, not a strict gate, and must
 * not be read as one). The fixture split cannot substitute: 26 of the 35
 * refusable candidates on sitcom-friends are opaque, and that is a laugh-track
 * sitcom - the podcasts have neither the laugh track nor the opaque rate, which
 * is why Task 5 judges them separately.
 *
 * `secondsGained` is the only number that says whether the stage did anything a
 * viewer would notice; applied alone cannot distinguish twelve 0.4s nudges from
 * one 13s rescue of a payoff.
 *
 * `hinted`/`hintFollowed`/`hintOverridden` (spec 2026-08-10 task 4) are ABSENT,
 * never zero, whenever no clip in this run carried an arc-audit exit hint - the
 * same "absent means nothing happened" rule `skipped` documents above, chosen
 * here for a second reason: every telemetry object built before this task
 * existed is asserted against with an exact `toEqual` somewhere in this file's
 * own suite, and a counter that is always present (even at 0) would break every
 * one of them the moment it was added, for a feature those tests know nothing
 * about. `hinted` counts clips added to (or already in) the offered set because
 * arcAudit flagged their exit - set once, right after the offered set is built,
 * so it is present even when the call itself times out, refuses or throws
 * (mirroring `offered`, which survives the same paths). `hintFollowed` counts
 * APPLIED extensions whose accepted end_node equals the hint's node exactly;
 * `hintOverridden` counts APPLIED extensions on a hinted clip that landed on a
 * different legal node instead - the model read the note and chose its own
 * answer, which is legal and exactly the honest-miss case this task exists to
 * give a second chance. Both are always present together with `hinted` (0 is a
 * real answer once there was a hinted population to ask about) and both are
 * counted only from APPLIED rows - a hinted clip whose proposal a gate refused
 * lands in `refused`/`refusedBy` like any other, never in either of these.
 */
export interface ExtensionTelemetry {
  offered: number;
  proposed: number;
  applied: number;
  refused: number;
  /** Counts only what fired, like index.ts's gateDropReasons. `not_offered` is
   *  the stage's own reason and never comes from applyExtension. */
  refusedBy: Partial<Record<ExtensionRefuseReason | "not_offered", number>>;
  contradicted: number;
  secondsGained: number;
  fallbackModelUsed: boolean;
  /** Absent when the stage ran to completion. "disabled", "no_window",
   *  "unreadable", "exception", or the failing call's kind
   *  ("error"/"refusal"/"truncated"). */
  skipped?: string;
  hinted?: number;
  hintFollowed?: number;
  hintOverridden?: number;
}

export interface ExtensionResult {
  clips: SnappedClip[];
  telemetry: ExtensionTelemetry;
}

function emptyExtensionTelemetry(): ExtensionTelemetry {
  return {
    offered: 0,
    proposed: 0,
    applied: 0,
    refused: 0,
    refusedBy: {},
    contradicted: 0,
    secondsGained: 0,
    fallbackModelUsed: false,
  };
}

function countRefusal(
  telemetry: ExtensionTelemetry,
  reason: ExtensionRefuseReason | "not_offered"
): void {
  telemetry.refused += 1;
  telemetry.refusedBy[reason] = (telemetry.refusedBy[reason] ?? 0) + 1;
}

/**
 * The model's extend:true rows, keyed by clip id. Everything else is dropped
 * silently: this stage's whole posture is that an answer it cannot read is an
 * answer to ignore, and there is nothing to repair - the clip already ships.
 *
 * A REPEATED id drops the proposal instead of picking one of the two rows: a
 * model that answered twice does not have one answer, both readings of "which
 * wins" are arbitrary, and refusing costs at most one extension while
 * last-write-wins would let a garbled tail override a considered first answer.
 * Strict mode constrains each ROW's shape and says nothing about the set, so
 * this is schema-legal and needs a decided answer rather than an accidental
 * one. `contradicted` counts the clips it happened to.
 */
function readProposals(rows: unknown[]): {
  proposals: Map<string, number>;
  contradicted: number;
} {
  const proposals = new Map<string, number>();
  const contradictions = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { id, extend, end_node: endNode } = row as {
      id?: unknown;
      extend?: unknown;
      end_node?: unknown;
    };
    if (typeof id !== "string") continue;
    if (seen.has(id)) {
      proposals.delete(id);
      contradictions.add(id);
      continue;
    }
    seen.add(id);
    // `extend` is read FIRST and strictly: a false (or absent) flag beside a
    // later end_node is a contradiction, and the answer to a contradiction here
    // is to leave the clip alone. An extend:false echo needs no special case -
    // applyExtension refuses the no-op it names.
    if (extend !== true) continue;
    if (typeof endNode !== "number") continue;
    proposals.set(id, endNode);
  }
  return { proposals, contradicted: contradictions.size };
}

/**
 * Asks one focused question about every clip that has somewhere to go, and
 * routes each answer through applyExtension.
 *
 * NEVER throws, and never returns fewer clips than it was given. This stage
 * improves clips that are ALREADY shippable, so every failure - disabled,
 * refusal, truncation, outage, a malformed payload, a defect in this file -
 * ships the input set unchanged, and says which one it was in `skipped`. The
 * same discipline as finalizeClips and for the same reason: a content answer
 * must not become a failed job (billing invariant, engine-notes §6). Unlike the
 * finalizer it has no veto and no repair, so there is nothing to retry a
 * truncation for - the budget above carries that argument.
 *
 * ONE call for the whole set, not one per clip. The question is per-clip and
 * independent, so batching buys only latency - but it buys a lot of it: this
 * runs while a user waits, between the critic's batches and the finalizer, and
 * twelve serial calls would be the slowest stage in the engine.
 *
 * The clip's own end node is validated HERE, before anything is offered.
 * extensionWindow is partial by design and buildExtensionUser inherits that, so
 * this loop is the last place where a real end node is a caller's obligation
 * rather than a gate. A clip that fails the check is skipped rather than fatal:
 * one stale end node must not cost every other clip in the job its extension,
 * which is exactly what the outer catch alone would do.
 *
 * `arcFlags` (spec 2026-08-10 task 4) is the SAME map index.ts already builds
 * for start-extension - empty whenever arcAudit did not run, which is every
 * call site in this file's OWN suite and every fixture recorded before this
 * task. Two INDEPENDENT switches decide what it does to the offered set,
 * mirroring the self-motivated/hint-driven separation the spec requires:
 *
 *   - `cfg.endExtensionEnabled` (unchanged, pre-existing): the SELF-MOTIVATED
 *     path - every clip with a non-empty window is offered, cold, exactly as
 *     it has been since 2026-08-04. Net negative on compilation reels
 *     (engine-notes §3), ships OFF.
 *   - `cfg.endExtensionHintsEnabled` (new): the HINT-DRIVEN path - a clip is
 *     ALSO offered when arcAudit flagged its exit `ok: false` with a gated
 *     `fixEndNode`, whether or not its own window is non-empty, and that clip's
 *     prompt block carries the AUDIT NOTE line (buildExtensionUser's `hint`
 *     parameter). Gated on `cfg.arcAuditEnabled` here too, not merely on
 *     `arcFlags` happening to be empty - the same doubling start-extension.ts
 *     uses for its own dependency on the audit, so the dependency is visible
 *     in code rather than implied by an upstream side effect.
 *
 * Both off: identical to every build before this task, byte for byte - no
 * clip is ever added to `offered` by either path, so the recorded end-extension
 * variant keeps replaying against this file unmodified. Both on: the union;
 * only the clips arcAudit flagged carry the note, every other offered clip's
 * block renders exactly as it always has. ALL GATES BELOW ARE UNCHANGED - a
 * hinted proposal that fails `opaque_end` or `no_clean_end` is refused like any
 * other; the hint only ever widens what is ASKED, never what is ACCEPTED.
 *
 * ONE SIDE EFFECT on `arcFlags` (follow-up, 2026-08-11): an applied extension
 * on a clip whose exit was flagged `ok: false` replaces that clip's map entry
 * with a copy carrying `exit.repaired = true` - see the marking site inside
 * the `clips.map` below for the exact rule (fires on both hintFollowed and
 * hintOverridden applies, and on a flagged clip's self-motivated apply too).
 * `arcFlags` is the SAME map instance index.ts threads through every stage
 * after arcAudit, so this mark is what makes `_arcFlags` on the eventually
 * shipped highlight (index.ts's `toHighlight`) and the finalizer's AUDIT NOTE
 * (`resolveArcAuditNote`) both stop describing a defect this stage already
 * fixed. `clips` themselves are never mutated by this - only the flags map.
 */
export async function extendClipEnds(
  client: OpenAI,
  usage: LlmUsage,
  clips: SnappedClip[],
  arcFlags: Map<string, ArcFlags>,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  options: { retryDelayMs?: number } = {}
): Promise<ExtensionResult> {
  const telemetry = emptyExtensionTelemetry();
  if (!cfg.endExtensionEnabled && !cfg.endExtensionHintsEnabled) {
    return { clips, telemetry: { ...telemetry, skipped: "disabled" } };
  }

  try {
    const offered: Array<{
      clip: SnappedClip;
      window: ExtensionWindow;
      hint?: { defect?: ArcExitDefect; fixEndNode: number };
      blessed: boolean;
    }> = [];
    for (const clip of clips) {
      const end = clip.finalEndNode;
      if (!Number.isInteger(end) || end < 0 || end > nodes.length - 1) continue;

      // The hint-driven half of the offered set (spec 2026-08-10 task 4).
      // `cfg.arcAuditEnabled` is checked HERE, not inferred from `arcFlags`
      // being empty - the same defence-in-depth doubling every gated stage in
      // this engine uses for its own upstream dependency.
      const flags = cfg.arcAuditEnabled ? arcFlags.get(clip.verdict.id) : undefined;
      // Blessed-ness (spec 2026-08-10 task 5, item 4) - computed BEFORE the
      // window so the window and every later gate agree on the ceiling; see
      // fitsMaxSec's own doc comment for why, unlike start-extension.ts's
      // gate, this one is genuinely reachable.
      const blessed = isFullyOk(flags);
      const window = extensionWindow(clip, nodes, cfg, blessed);
      const hint =
        cfg.endExtensionHintsEnabled &&
        flags &&
        !flags.exit.ok &&
        flags.exit.fixEndNode !== undefined
          ? { defect: flags.exit.defect, fixEndNode: flags.exit.fixEndNode }
          : undefined;

      // An empty window is not a question worth asking ON ITS OWN - every
      // answer to it is the current end, which applyExtension refuses as a
      // no-op anyway - UNLESS a hint says otherwise: arcAudit's own gate
      // (gateExitFix) only bounds the pointer by endExtensionWindowSec, never
      // by the scene rail or maxSec that also shape this stage's window, so a
      // gated hint can legally exist for a clip whose self-motivated window is
      // empty. Offering it anyway lets the model see the note; the gates below
      // still refuse whatever they would have refused before this task.
      const selfOffers = cfg.endExtensionEnabled && window.lastNode > end;
      if (!selfOffers && !hint) continue;

      offered.push({ clip, window, hint, blessed });
    }
    telemetry.offered = offered.length;
    // Set once, right here, so it survives every early return below the same
    // way `offered` does - a call that times out, refuses or truncates still
    // truthfully describes what was ASKED. Absent (never 0) when nothing in
    // this run was hinted - see ExtensionTelemetry's doc comment for why that
    // keeps every telemetry-equality test written before this task green.
    const hintedCount = offered.filter((o) => o.hint !== undefined).length;
    if (hintedCount > 0) telemetry.hinted = hintedCount;
    if (offered.length === 0) {
      telemetry.skipped = "no_window";
      return { clips, telemetry };
    }

    const user = offered
      .map((o) => buildExtensionUser(o.clip, nodes, o.window, o.hint))
      .join("\n\n---\n\n");
    const call = (model: string) =>
      callJsonSchema<{ results?: unknown }>(client, usage, {
        model,
        system: EXTENSION_SYSTEM,
        user,
        schema: END_EXTENSION_SCHEMA,
        reasoningEffort: cfg.reasoningEffort,
        maxOutputTokens: extensionMaxOutputTokens(offered.length),
        retryDelayMs: options.retryDelayMs,
      });

    // The critic's model and the critic's fallback: this is the same kind of
    // judgement over the same transcript. No stage-specific knob exists, and
    // none should until a measurement asks for one - the finalizer's own
    // override was added because that stage judges the whole set at once.
    let result = await call(cfg.criticModel);
    // Only on a hard error, exactly as the critic and the finalizer degrade.
    // A refusal or a truncation is an answer about THIS request, and llm.ts has
    // already spent its retry budget on anything transient; re-asking a second
    // model would double the wall clock for a stage whose failure is free.
    if (!result.ok && result.kind === "error") {
      logModelFallback("end-extension", cfg.criticModel, cfg.criticModelFallback);
      telemetry.fallbackModelUsed = true;
      result = await call(cfg.criticModelFallback);
    }
    if (!result.ok) {
      telemetry.skipped = result.kind;
      return { clips, telemetry };
    }

    // A payload with no `results` ARRAY in it is a skip, not an answer. It looks
    // identical to an honest all-decline in every counter - zeros across the
    // board - and they are opposite findings, so the one field that can separate
    // them has to. `data` itself can be null: JSON.parse("null") is a legal
    // parse and callJsonSchema hands back whatever parsed.
    const rows = result.data?.results;
    if (!Array.isArray(rows)) {
      telemetry.skipped = "unreadable";
      return { clips, telemetry };
    }

    const { proposals, contradicted } = readProposals(rows);
    telemetry.proposed = proposals.size;
    telemetry.contradicted = contradicted;

    const offeredIds = new Set(offered.map((o) => o.clip.verdict.id));
    // Hint pointers by clip id, for the follow/override split below - built
    // from the same `offered` array `hintedCount` already read, never
    // recomputed against `arcFlags` a second time.
    const hintNodeById = new Map<string, number>();
    for (const o of offered) {
      if (o.hint) hintNodeById.set(o.clip.verdict.id, o.hint.fixEndNode);
    }
    let hintFollowed = 0;
    let hintOverridden = 0;

    const out = clips.map((clip) => {
      const proposed = proposals.get(clip.verdict.id);
      if (proposed === undefined) return clip;
      // The gate decides, always - a clip that was never offered is refused on
      // its own merits and not by bookkeeping. The bookkeeping only chooses
      // which REASON to record, because "the window is empty" describes the
      // clip while "the model named a clip it was never shown" describes the
      // model, and only the second is a fault worth acting on.
      //
      // Recomputed here rather than read off `offered` (spec 2026-08-10 task
      // 5): a proposal can name a clip id that was never offered at all (a
      // hallucinated or foreign id, the same case `not_offered` already
      // handles), and this clip's own arc-audit flags - not membership in
      // `offered` - are what blessed-ness is actually about. Read once and
      // reused below for the repaired-marking side effect (follow-up,
      // 2026-08-11), so the two can never disagree about this clip's flags.
      const flags = cfg.arcAuditEnabled ? arcFlags.get(clip.verdict.id) : undefined;
      const blessed = isFullyOk(flags);
      const attempt = applyExtension(clip, nodes, proposed, cfg, blessed);
      if (!attempt.ok) {
        countRefusal(
          telemetry,
          offeredIds.has(clip.verdict.id) ? attempt.reason : "not_offered"
        );
        return clip;
      }
      telemetry.applied += 1;
      // Safe to subtract without a guard: an accepted extension always has a
      // strictly larger endSec (applyExtension's seconds gate), so this can
      // only ever add.
      telemetry.secondsGained += attempt.clip.endSec - clip.endSec;
      // hintFollowed/hintOverridden (task 4): only APPLIED rows on a HINTED
      // clip land here - a hinted clip whose proposal a gate refused is
      // already counted in `refused`/`refusedBy` above and must not also be
      // double-counted here.
      const hintNode = hintNodeById.get(clip.verdict.id);
      if (hintNode !== undefined) {
        if (attempt.clip.finalEndNode === hintNode) hintFollowed += 1;
        else hintOverridden += 1;
      }
      // REPAIRED (follow-up, 2026-08-11, job cmsoqmy47008fuhfjosaxi86s): ANY
      // applied extension on a clip whose audited exit was flagged `ok:
      // false` retires that flag's standing, whether the model FOLLOWED the
      // hint node exactly, OVERRODE it with a different legal one, or the
      // clip had no gated `fixEndNode` at all and only reached here through
      // the self-motivated path - in every one of those cases the end moved
      // forward, so the exit the audit judged no longer exists. `flags.ok`
      // is left untouched, same discipline as start-extension.ts's own mark:
      // it stays the detector's record, `repaired` says a widen has since
      // moved the boundary. A clip with no flags at all (never audited, or
      // its exit was already `ok: true`) gets no map entry touched - marking
      // an axis that was never flagged would misreport a repair that never
      // needed to happen.
      if (flags && !flags.exit.ok) {
        arcFlags.set(clip.verdict.id, { ...flags, exit: { ...flags.exit, repaired: true } });
      }
      return attempt.clip;
    });

    // Present only alongside `hinted` - see ExtensionTelemetry's doc comment.
    if (telemetry.hinted !== undefined) {
      telemetry.hintFollowed = hintFollowed;
      telemetry.hintOverridden = hintOverridden;
    }

    return { clips: out, telemetry };
  } catch (error) {
    // Belt and braces: callJsonSchema swallows API failures and applyExtension
    // is total, so reaching here means a defect in this file or in prompt
    // rendering. Clips that already passed every gate must still ship.
    //
    // Counters are RESET rather than carried out, as finalizeClips does here:
    // nothing was applied, so an `applied` accumulated before a throw would
    // describe a set that never shipped. `offered`, `hinted` and the fallback
    // flag survive because they describe what was ASKED, which is still true.
    console.warn(
      `[analyze-v2] end-extension threw, shipping the set unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {
      clips,
      telemetry: {
        ...emptyExtensionTelemetry(),
        offered: telemetry.offered,
        fallbackModelUsed: telemetry.fallbackModelUsed,
        skipped: "exception",
        ...(telemetry.hinted !== undefined ? { hinted: telemetry.hinted } : {}),
      },
    };
  }
}
