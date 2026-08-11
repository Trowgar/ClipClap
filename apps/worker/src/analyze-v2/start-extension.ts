import type { AnalyzeConfig } from "./config";
import { isFullyOk } from "./arc-audit";
import { isCleanStart } from "./sentence-graph";
import { sceneStartBefore } from "./scene-gaps";
import { startSecFor } from "./snap";
import { detectTeaserRegion, isInTeaserRegion, type TeaserRegion } from "./teaser";
import { nmsCollides } from "./select";
import type { ArcFlags, SentenceNode, SnappedClip } from "./types";

/**
 * start-extension.ts - the WIDEN-ONLY, BACKWARD-ONLY mirror of end-extension.ts
 * (spec 2026-08-10 task 3, design §2c).
 *
 * THE LOAD-BEARING DIFFERENCE FROM end-extension.ts: this stage makes NO model
 * call of its own. arc-audit.ts already both DETECTED the defect (entry.ok)
 * and PROPOSED the repair (entry.fixStartNode), gated once there
 * (not_an_index, wrong_direction, outside_graph, outside_window against
 * startExtensionWindowSec, not_clean_start - arc-audit.ts's gateEntryFix).
 * What is left here is deterministic APPLICATION behind a second, independent
 * set of gates - re-checking everything arc-audit.ts already checked (defence
 * in depth, the same doubling every stage in this engine uses), plus three
 * checks arc-audit.ts's detector-only gate never needed: the scene rail, the
 * teaser region, and NMS collision against the other clips actually shipping.
 *
 * Pure and synchronous by construction - no client, no usage, nothing to await
 * - because there is nothing left to ask a model. See the module doc on
 * end-extension.ts for why THAT stage cannot make the same simplification
 * (self-motivated, its own call, its own refusal-in-writing case).
 */

/** Would a clip starting on this second still fit the platform cap? One
 *  expression, mirroring end-extension's fitsMaxSec, which pairs the same
 *  question against a candidate END.
 *
 *  `blessed` (spec 2026-08-10 task 5, item 4) raises the ceiling to
 *  `cfg.longClipMaxSec` when `cfg.longClipsEnabled` and the clip is
 *  arc-audit-blessed (`isFullyOk`) - the effective ceiling is `longClipMaxSec`
 *  only on that combination, `maxSec` otherwise. Defaults to `false`, so
 *  every call site that predates this task (including every test that calls
 *  `applyStartExtension` positionally without it) keeps today's ceiling
 *  exactly.
 *
 *  NOTE (measured, not fixed - same posture as the NMS asymmetry index.ts
 *  documents): `extendClipStarts`'s own eligibility loop only ever reaches
 *  this gate for a clip whose `entry.ok` is FALSE, and `isFullyOk` requires
 *  `entry.ok` true - so `blessed` is structurally always `false` on THIS
 *  gate today. The parameter exists for symmetry with end-extension.ts and
 *  because the spec names all three call sites explicitly; it is currently
 *  unreachable here, not merely untested. See the task 5 report. */
function fitsMaxSec(
  clip: SnappedClip,
  candidateStartSec: number,
  cfg: AnalyzeConfig,
  blessed: boolean = false
): boolean {
  const ceilingSec = cfg.longClipsEnabled && blessed ? cfg.longClipMaxSec : cfg.maxSec;
  return clip.endSec - candidateStartSec <= ceilingSec;
}

/**
 * Where a clip STARTS in seconds, given the node it starts on.
/**
 * How far BACKWARD this clip is allowed to reach. The tightest of three
 * bounds - the backward twin of end-extension's extensionWindow: the nearest
 * scene cut BEHIND the clip, startExtensionWindowSec of wall clock (via node
 * START times), and the teaser region.
 *
 * A FLOOR, never a target - nothing here says a clip should start at
 * firstNode, it says nothing before firstNode may be accepted from arc-audit's
 * pointer.
 *
 * The scene rail bounds the loop itself (mirrors sceneEnd bounding
 * end-extension's loop), the wall-clock deadline BREAKS the loop the moment a
 * node is reached that is too far back (mirrors the deadline break in
 * extensionWindow - both are monotonic thresholds against node time, so once
 * crossed nothing further back can un-cross it), and the teaser region also
 * BREAKS for the same reason: region.endSec is one threshold, node.start is
 * monotonically non-increasing as the index decreases, so once a node's start
 * falls inside the region every earlier node's start does too - continuing
 * the loop past that point could only ever re-confirm the same refusal.
 *
 * Unlike end-extension's window, this floor does NOT bake maxSec in: there is
 * no model being offered a menu here, so a too-long candidate is refused by
 * its own gate (too_long, below) rather than never being reachable in the
 * first place.
 */
export function startExtensionWindow(
  clip: SnappedClip,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  teaserRegion: TeaserRegion | null
): { firstNode: number } {
  const from = clip.finalStartNode;
  const sceneStart = sceneStartBefore(nodes, from, cfg);
  const deadline = nodes[from].start - cfg.startExtensionWindowSec;
  let first = from;
  for (let i = from - 1; i >= sceneStart; i--) {
    if (nodes[i].start < deadline) break;
    if (isInTeaserRegion(teaserRegion, nodes[i].start)) break;
    first = i;
  }
  return { firstNode: first };
}

/** Why a gated arc-audit pointer still did not move a start. THE ORDER IS THE
 *  FILING RULE, same discipline as end-extension's ExtensionRefuseReason and
 *  arc-audit's own ArcGateReason: a pointer failing two of these is filed
 *  under the earlier one.
 *
 *  The first five mirror arc-audit.ts's gateEntryFix exactly (defence in
 *  depth - a pointer that reaches here already passed that gate once, on the
 *  same clip's THEN-current finalStartNode; re-checking here costs nothing
 *  and protects against a caller that skips arc-audit's own gate, or a clip
 *  whose finalStartNode moved between the two calls). `no_gain`, `too_long`
 *  and `nms_collision` exist only here - arc-audit.ts's gate never needed
 *  them, because a DETECTOR publishing a pointer never has to ask whether
 *  applying it is worth anything or safe next to the clip's neighbours. */
export type StartExtensionRefuseReason =
  | "not_an_index"
  | "not_backward"
  | "outside_graph"
  | "outside_window"
  | "not_clean_start"
  | "no_gain"
  | "too_long"
  | "nms_collision";

/** Mirrors end-extension's ExtensionAttempt: the widened clip, or the reason
 *  there is none. */
export type StartExtensionAttempt =
  | { ok: true; clip: SnappedClip }
  | { ok: false; reason: StartExtensionRefuseReason };

/**
 * Applies one gated `entry.fixStartNode` pointer to one clip, or refuses it.
 *
 * TOTAL, like end-extension's applyExtension: any clip, any proposed node,
 * either a widened clip or a reason, never a throw. This stage runs once per
 * eligible clip in a job and must not be able to fail the whole job over one
 * bad pointer.
 *
 * `others` is every OTHER clip currently in the selected set, at whatever
 * state extendClipStarts's single pass has reached for each of them - see
 * that function's own doc comment for exactly what "currently" means and why
 * that reading was chosen over a fixpoint.
 *
 * `blessed` (spec 2026-08-10 task 5) - see fitsMaxSec's own doc comment for
 * what it does to gate 7 and why it is currently unreachable through this
 * function's own eligibility rule. Defaults to `false`.
 */
export function applyStartExtension(
  clip: SnappedClip,
  nodes: SentenceNode[],
  proposedStartNode: number,
  cfg: AnalyzeConfig,
  teaserRegion: TeaserRegion | null,
  others: SnappedClip[],
  blessed: boolean = false
): StartExtensionAttempt {
  const no = (reason: StartExtensionRefuseReason): StartExtensionAttempt => ({ ok: false, reason });

  // 1. INTEGER (defence in depth - arc-audit's gateEntryFix already required
  //    this before the pointer could reach ArcFlags.entry.fixStartNode).
  if (!Number.isInteger(proposedStartNode)) return no("not_an_index");

  // Guards the CLIP'S OWN start before it is used as a comparison or an array
  // index below - not reachable through snapNodes, whose idxOk already
  // demands a real node, but this function's total-function promise is
  // unconditional (end-extension's clip_end_unusable is the same defensive
  // shape for its own end node). Folded into "outside_graph" rather than a
  // ninth reason: the spec names exactly eight buckets for this stage and a
  // corrupted clip.finalStartNode is, at heart, the same complaint - there is
  // no real node to be strictly earlier than.
  if (
    !Number.isInteger(clip.finalStartNode) ||
    clip.finalStartNode < 0 ||
    clip.finalStartNode > nodes.length - 1
  ) {
    return no("outside_graph");
  }

  // 2. BACKWARD ONLY, strictly (spec: "must be strictly earlier than the
  //    clip's current finalStartNode"; defence in depth).
  if (proposedStartNode >= clip.finalStartNode) return no("not_backward");

  // 3. INSIDE THE GRAPH (defence in depth).
  if (proposedStartNode < 0 || proposedStartNode > nodes.length - 1) return no("outside_graph");

  // 4. INSIDE THE WINDOW: startExtensionWindowSec of wall clock (via node
  //    START times), the scene rail behind the clip, and the teaser region -
  //    a start pulled into the intro montage is the defect the teaser filter
  //    exists to prevent (spec 2026-08-10 task 3).
  const { firstNode } = startExtensionWindow(clip, nodes, cfg, teaserRegion);
  if (proposedStartNode < firstNode) return no("outside_window");

  // 5. CLEAN START (defence in depth - the same isCleanStart snap uses,
  //    already required once by arc-audit's gateEntryFix).
  if (!isCleanStart(nodes, proposedStartNode)) return no("not_clean_start");

  // snap's own arithmetic, imported from snap.ts (startSecFor) - the same
  // precedent as endSecFor, so the two stages can never place one node at two
  // different seconds.
  const startSec = startSecFor(nodes, nodes[proposedStartNode], cfg);

  // 6. GAIN, strictly, in SECONDS - not implied by the node-index gate. The
  //    lead-in clamp and the previous node's own end can both hold the new
  //    start's seconds back toward (or even past) the clip's current startSec
  //    even though the NODE moved strictly earlier; the shape is the same
  //    reason end-extension's own no_gain gate cannot be replaced by its
  //    index gate.
  if (startSec >= clip.startSec) return no("no_gain");

  // 7. MAX LENGTH. The end does not move on this path, so a widened start can
  //    only ever push the clip's duration UP against maxSec. THE SAME seconds
  //    arithmetic snap's own over-length compression loop uses for a
  //    candidate start (clip.endSec - candidateStartSec), so a clip this stage
  //    accepts can never be one snap itself would have compressed away.
  if (!fitsMaxSec(clip, startSec, cfg, blessed)) return no("too_long");

  const widened: SnappedClip = {
    ...clip,
    startSec,
    finalStartNode: proposedStartNode,
    // shortMoment is a verdict on LENGTH and this stage changes the length -
    // the same argument end-extension's applyExtension makes for recomputing
    // it against its own new endSec. hookStart/hookEnd/payoff are NOT
    // recomputed: this stage never touches the hook or payoff nodes, and the
    // verdict's own startNode is not rewritten either (index.ts's
    // finalStartNode remains the shipped truth, same policy as end-extension).
    shortMoment: clip.endSec - startSec < cfg.targetMinSec,
  };

  // 8. NMS COLLISION. end-extension carries no equivalent gate. Starts get one
  //    because of the anaphora lesson (engine-notes §3, "the arc audit"
  //    section): a widened boundary that feeds NMS deleted the very clip it
  //    repaired, and the finalizer's own fixpoint is not a place to discover a
  //    collision after the fact - refuse here, visibly, and let the telemetry
  //    say so. Checked with select.ts's own primitive, imported rather than
  //    re-derived, so the two can never disagree about what "the same moment"
  //    means.
  if (others.some((o) => nmsCollides(widened, o))) return no("nms_collision");

  return { ok: true, clip: widened };
}

/** Mirrors end-extension's ExtensionTelemetry, but simpler: there is no model
 *  call to time out, refuse, or fall back from, so there is no `skipped`, no
 *  `fallbackModelUsed`, no `proposed`/`contradicted` split between what the
 *  model said and what the gates did with it - every eligible clip goes
 *  through exactly one gate chain and lands in `applied` or `refused`, always.
 *
 *  `eligible` counts clips whose `_arcFlags` carried a gated
 *  `entry.fixStartNode` pointer - the population this stage was handed a
 *  chance to act on, whether or not it ultimately did. `eligible` always
 *  equals `applied + refused`. */
export interface StartExtensionTelemetry {
  eligible: number;
  applied: number;
  refused: number;
  refusedBy: Partial<Record<StartExtensionRefuseReason, number>>;
  secondsGained: number;
}

export interface StartExtensionResult {
  clips: SnappedClip[];
  telemetry: StartExtensionTelemetry;
}

function emptyTelemetry(): StartExtensionTelemetry {
  return { eligible: 0, applied: 0, refused: 0, refusedBy: {}, secondsGained: 0 };
}

function countRefusal(t: StartExtensionTelemetry, reason: StartExtensionRefuseReason): void {
  t.refused += 1;
  t.refusedBy[reason] = (t.refusedBy[reason] ?? 0) + 1;
}

/**
 * Applies every gated `entry.fixStartNode` pointer arc-audit published, or
 * no-ops.
 *
 * PURE AND SYNCHRONOUS - no client, no usage, no await anywhere in this
 * module. That is the load-bearing difference from end-extension.ts named in
 * the module doc comment: arc-audit already asked a model and gated its
 * answer once, so this stage is deterministic application, nothing more.
 *
 * BOTH FLAGS, explicitly, checked here even though index.ts already gates the
 * call on both together - the same doubling arc-audit.ts and end-extension.ts
 * both use for their own enabling flags. Spec 2026-08-10 task 3: "the stage
 * no-ops unless BOTH arcAuditEnabled and startExtensionEnabled (no flags =
 * nothing to apply, and that dependency must be visible in code, not
 * implied)" - an empty `arcFlags` map when only ARC_AUDIT is off would ALSO
 * make this a no-op, but that would be the dependency holding by accident
 * (via an upstream side effect) rather than by a check a reader can see here.
 *
 * NEVER moves a clip's own `verdict.startNode` - the same policy as
 * end-extension, which leaves `verdict.endNode` alone: `finalStartNode` is
 * the shipped truth (snap.ts's own comment: "the range that shipped, which is
 * what every later 'is this node inside the clip' question has to be
 * answered against").
 *
 * SINGLE PASS, NO FIXPOINT. Clips are walked in the order they arrive (the
 * order selectAndOrder produced: score descending, then start ascending) and
 * each accepted widen is written back into the working array immediately, so
 * a LATER clip's `nms_collision` check sees an EARLIER clip's widened
 * boundary while an EARLIER clip's check still saw the later one at its
 * original boundary. This is a judgment call, not something the spec pins
 * down further than "must not collide... with any OTHER clip in the selected
 * set" - see the task report for the reasoning. It deliberately does not
 * iterate to a stable assignment: the whole point of this gate is to REFUSE a
 * collision immediately rather than hunt for one, mirroring select.ts's own
 * greedy (not globally-optimal) NMS keep loop.
 */
export function extendClipStarts(
  clips: SnappedClip[],
  arcFlags: Map<string, ArcFlags>,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): StartExtensionResult {
  const telemetry = emptyTelemetry();
  if (!cfg.arcAuditEnabled || !cfg.startExtensionEnabled || clips.length === 0) {
    return { clips, telemetry };
  }

  const teaserRegion = detectTeaserRegion(nodes, cfg);
  const out = clips.slice();

  for (let i = 0; i < out.length; i++) {
    const clip = out[i];
    const flags = arcFlags.get(clip.verdict.id);
    if (!flags || flags.entry.ok || flags.entry.fixStartNode === undefined) continue;

    telemetry.eligible += 1;
    const others = out.filter((_, j) => j !== i);
    // isFullyOk(flags) is structurally false here - see fitsMaxSec's own doc
    // comment - but computed via the shared helper anyway rather than a
    // hardcoded `false`, per spec 2026-08-10 task 5 item 4 ("used by all
    // three call sites"; do not re-derive blessed-ness in a second shape).
    const blessed = isFullyOk(flags);
    const attempt = applyStartExtension(
      clip,
      nodes,
      flags.entry.fixStartNode,
      cfg,
      teaserRegion,
      others,
      blessed
    );
    if (!attempt.ok) {
      countRefusal(telemetry, attempt.reason);
      continue;
    }
    telemetry.applied += 1;
    // Safe without a guard: an accepted widen always has a strictly SMALLER
    // startSec (the no_gain gate), so this can only ever add.
    telemetry.secondsGained += clip.startSec - attempt.clip.startSec;
    out[i] = attempt.clip;
  }

  return { clips: out, telemetry };
}
