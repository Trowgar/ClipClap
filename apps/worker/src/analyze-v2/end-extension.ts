import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema, logModelFallback } from "./llm";
import { EXTENSION_SYSTEM, buildExtensionUser } from "./prompts";
import { END_EXTENSION_SCHEMA } from "./schemas";
import { endsOnQuestionMark, isCleanEnd } from "./sentence-graph";
import { sceneEndAfter } from "./scene-gaps";
import { endSecFor } from "./snap";
import type { LlmUsage, SentenceNode, SnappedClip } from "./types";

export interface ExtensionWindow {
  /** Highest node index this clip may legally be extended to. Equals the clip's
   *  own end when no extension is possible. */
  lastNode: number;
}

/**
 * How far this clip is allowed to reach. The tighter of two bounds: the next
 * scene cut, and endExtensionWindowSec of wall clock.
 *
 * A CEILING, never a target. Nothing here says a clip should end at lastNode -
 * it says nothing past lastNode may be offered to a model or accepted from one.
 *
 * The two bounds are not redundant and neither is decoration. The scene rail is
 * PARTIAL by construction: it finds the cuts that fall silent and not the ones
 * an audience laughs through, and it finds nothing at all in a source with no
 * hard cuts, which is what both podcast fixtures are. scene-gaps.ts carries that
 * measurement and is the single copy of it. Where the rail is blind the clock is
 * the only thing standing between a clip and the rest of the video; where the
 * clock is generous the rail is what stops a compilation clip from stapling two
 * unrelated scenes together.
 *
 * The deadline is measured from the END NODE's last word, not from clip.endSec,
 * so the tail hold is not charged against the window: the hold is silence, and
 * "25 seconds further" should mean 25 seconds of further material. A node ending
 * exactly on the deadline is inside it.
 *
 * The loop BREAKS on the first node that overruns the deadline rather than
 * skipping it. A clip is a contiguous range: node i+1 cannot play without node
 * i, so a single long node closes the window for everything behind it. Skipping
 * would offer an end whose inclusion drags the clip far past the window - and
 * node ends really can overrun their successor's start, because word timings
 * nest (the `max, not last` comment on `end:` in buildSentenceGraph).
 *
 * clip.finalEndNode must be a real index into `nodes` - sceneEndAfter refuses to
 * invent a ceiling for an invalid one, and neither does this.
 */
export function extensionWindow(
  clip: SnappedClip,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): ExtensionWindow {
  const from = clip.finalEndNode;
  const sceneEnd = sceneEndAfter(nodes, from, cfg);
  const deadline = nodes[from].end + cfg.endExtensionWindowSec;
  let last = from;
  for (let i = from + 1; i <= sceneEnd; i++) {
    if (nodes[i].end > deadline) break;
    last = i;
  }
  return { lastNode: last };
}

/**
 * Applies a proposed end node, or refuses it.
 *
 * Refusal is the default and returns null. Every branch below is a way for a
 * model's proposal to be wrong, and the caller's only job is to keep the clip it
 * already had when one fires. Nothing here is advisory.
 *
 * TOTAL, unlike extensionWindow: any clip, any number, either a widened clip or
 * null - never a throw. A stage that runs once per shipped clip must not be able
 * to fail a whole job over one bad answer. That holds only because the clip's
 * OWN end node is checked at both ends before the window is computed - the
 * upper bound falls out of the gate pairing below, the lower one needs its own
 * line, and an earlier version of this comment claimed totality while -1 and
 * NaN still threw.
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
 *   Delete it and a clip carrying a stale end node turns a null refusal into a
 *   TypeError thrown out of a stage that must never throw.
 * - THE CLIP'S OWN END IS A REAL INDEX, from below. The pairing above proves
 *   nothing about a negative or NaN finalEndNode, so that is its own gate. Not
 *   reachable through snapNodes, whose idxOk already demands >= 0; it is here
 *   because the totality promise above is unconditional and a future caller
 *   handing this stage a clip from somewhere else must get null, not a throw.
 * - INSIDE THE WINDOW. The scene cut and the clock, above.
 * - WORD-BEARING. An opaque node's timings are segment-level (music, laughter,
 *   crosstalk), so ending on one puts the boundary at a coarse Whisper edge.
 *   snapNodes walks BACK off opaque ends for exactly this reason; walking ONTO
 *   one here would undo that.
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
 * - MAX LENGTH. maxSec is the platform ceiling, and this is the only stage that
 *   can approach it from below. snapNodes compresses an over-long clip by moving
 *   its START; there is no equivalent repair here, because moving the start is
 *   exactly what this stage promises not to do. So an over-long proposal is
 *   refused outright and the clip keeps the end it had.
 */
export function applyExtension(
  clip: SnappedClip,
  nodes: SentenceNode[],
  proposedEndNode: number,
  cfg: AnalyzeConfig
): SnappedClip | null {
  if (!Number.isInteger(proposedEndNode)) return null;
  if (proposedEndNode <= clip.finalEndNode) return null;
  if (proposedEndNode > nodes.length - 1) return null;

  // The gates above bound the clip's own end from ABOVE only. Nothing there
  // rules out a negative, fractional or NaN finalEndNode, and each of those
  // reaches undefined inside extensionWindow - measured, not feared: -1 and NaN
  // throw on `nodes[from].end`, 2.5 throws inside sceneEndAfter.
  if (!Number.isInteger(clip.finalEndNode) || clip.finalEndNode < 0) return null;

  const { lastNode } = extensionWindow(clip, nodes, cfg);
  if (proposedEndNode > lastNode) return null;

  const e = nodes[proposedEndNode];
  if (!e.hasWords) return null;
  if (!isCleanEnd(nodes, proposedEndNode)) return null;

  // snap's own arithmetic, called rather than copied: an end this stage MOVES
  // has to land where snap would have put it.
  const endSec = endSecFor(nodes, e, cfg);
  if (endSec <= clip.endSec) return null;
  if (endSec - clip.startSec > cfg.maxSec) return null;

  // A NEW clip, never the argument mutated: clips travel by reference between
  // stages, and an accepted extension must not reach back into the caller's copy.
  //
  // Two fields are DERIVED from the end and are recomputed with the same
  // expressions snap.ts:204-206 used, because carrying them forward would leave
  // the clip describing an end it no longer has. shortMoment is a length verdict
  // and this stage changes the length; it is persisted onto the highlight, so a
  // stale `true` would mark a 20s clip a fragment. endsOnQuestion names the last
  // sentence, and "the answer to a question the clip ends on" is one of the beats
  // this stage exists to reach - the clip that ended on "so is it true?" now ends
  // on the answer, and the flag has to say so. Its consumer (select.ts) has
  // already run and priced the old end; nothing re-scores from it here.
  //
  // boundaryConfidence is NOT recomputed and does not need to be: it degrades to
  // "segment" for an opaque payoff or an opaque end, the payoff cannot move here
  // and an opaque end is refused above, so the value snap derived still holds.
  return {
    ...clip,
    endSec,
    finalEndNode: proposedEndNode,
    shortMoment: endSec - clip.startSec < cfg.targetMinSec,
    endsOnQuestion: endsOnQuestionMark(e.text),
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
// The two errors are not symmetric, which is why the margin sits where it does.
// There is no truncation retry here - unlike the finalizer, which retries with a
// doubled cap because a skipped finalizer ships an unjudged set - so starvation
// costs the WHOLE stage for the job. Over-sizing costs nothing at all: an unused
// cap is not billed (the same argument critic.ts makes about its own headroom).
// Re-measure from a real job's completion_tokens once the stage has run one.
const EXTENSION_BASE_TOKENS = 600;
const EXTENSION_TOKENS_PER_CLIP = 250;

/** Output cap for the one call this stage makes. */
export function extensionMaxOutputTokens(clipCount: number): number {
  return EXTENSION_BASE_TOKENS + EXTENSION_TOKENS_PER_CLIP * clipCount;
}

/**
 * What the stage did, in the numbers that can each be wrong differently.
 *
 * `offered` counts clips with somewhere to go - a non-empty window - not clips
 * shipped: a set where offered is far below the shipped count means the scene
 * rail or the clock is binding, not the model.
 *
 * `proposed` counts the model's extend:true rows. `applied` and `refused` split
 * those by what the gates said, and the gap between proposed and applied+refused
 * is rows naming an id that is not in the set at all - a model inventing clips.
 *
 * A nonzero `refused` is expected rather than alarming, and the number it should
 * be read against is measured: of the 111 candidate ends offered across the 12
 * sitcom-friends clips, 36 are nodes applyExtension would turn down (opaque, or
 * a mid-clause end). `refused` climbing toward `proposed` is the finding worth
 * acting on - it would say the model is systematically choosing the beats the
 * gates cannot take, which is an argument for marking them in the prompt.
 *
 * `secondsGained` is the only number that says whether the stage did anything a
 * viewer would notice; applied alone cannot distinguish twelve 0.4s nudges from
 * one 13s rescue of a payoff.
 */
export interface ExtensionTelemetry {
  offered: number;
  proposed: number;
  applied: number;
  refused: number;
  secondsGained: number;
  fallbackModelUsed: boolean;
}

export interface ExtensionResult {
  clips: SnappedClip[];
  telemetry: ExtensionTelemetry;
}

/**
 * The model's extend:true rows, keyed by clip id. Everything else is dropped
 * silently: this stage's whole posture is that an answer it cannot read is an
 * answer to ignore, and there is nothing to repair - the clip already ships.
 *
 * A REPEATED id drops the proposal instead of picking one of the two rows. Two
 * rows about one clip is a model that does not have one answer, and both
 * readings of "which one wins" are arbitrary; refusing costs at most one
 * extension, while last-write-wins would let a garbled tail of the response
 * override a considered first answer. Nothing upstream rules this out - strict
 * mode constrains each ROW's shape and says nothing about the set, so two rows
 * naming one clip is schema-legal and has to have a decided answer.
 */
function readProposals(raw: unknown): Map<string, number> {
  const proposals = new Map<string, number>();
  if (!Array.isArray(raw)) return proposals;

  const seen = new Set<string>();
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const { id, extend, end_node: endNode } = row as {
      id?: unknown;
      extend?: unknown;
      end_node?: unknown;
    };
    if (typeof id !== "string") continue;
    if (seen.has(id)) {
      proposals.delete(id);
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
  return proposals;
}

/**
 * Asks one focused question about every clip that has somewhere to go, and
 * routes each answer through applyExtension.
 *
 * NEVER throws, and never returns fewer clips than it was given. This stage
 * improves clips that are ALREADY shippable, so every failure - disabled,
 * refusal, truncation, outage, a malformed payload, a defect in this file -
 * ships the input set unchanged. The same discipline as finalizeClips and for
 * the same reason: a content answer must not become a failed job (billing
 * invariant, engine-notes §6). Unlike the finalizer it has no veto and no
 * repair, so there is nothing to retry a truncation for - the budget above
 * carries that argument.
 *
 * ONE call for the whole set, not one per clip. The question is per-clip and
 * independent, so batching buys latency and nothing else - but it buys a lot of
 * it: this runs while a user waits, after the critic's batches and before the
 * finalizer, and twelve serial calls would be the slowest stage in the engine.
 *
 * The clip's own end node is validated HERE, before anything is offered.
 * extensionWindow is partial by design and buildExtensionUser inherits that, so
 * this loop is the last place where a real end node is a caller's obligation
 * rather than a gate. A clip that fails the check is skipped rather than fatal:
 * one stale end node must not cost every other clip in the job its extension,
 * which is exactly what the outer catch alone would do.
 */
export async function extendClipEnds(
  client: OpenAI,
  usage: LlmUsage,
  clips: SnappedClip[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  options: { retryDelayMs?: number } = {}
): Promise<ExtensionResult> {
  const telemetry: ExtensionTelemetry = {
    offered: 0,
    proposed: 0,
    applied: 0,
    refused: 0,
    secondsGained: 0,
    fallbackModelUsed: false,
  };
  if (!cfg.endExtensionEnabled) return { clips, telemetry };

  try {
    const offered: Array<{ clip: SnappedClip; window: ExtensionWindow }> = [];
    for (const clip of clips) {
      const end = clip.finalEndNode;
      if (!Number.isInteger(end) || end < 0 || end > nodes.length - 1) continue;
      const window = extensionWindow(clip, nodes, cfg);
      // An empty window is not a question worth asking: every answer to it is
      // the current end, which applyExtension refuses as a no-op anyway.
      if (window.lastNode > end) offered.push({ clip, window });
    }
    telemetry.offered = offered.length;
    if (offered.length === 0) return { clips, telemetry };

    const user = offered
      .map((o) => buildExtensionUser(o.clip, nodes, o.window))
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
    if (!result.ok) return { clips, telemetry };

    // `data` itself can be null - JSON.parse("null") is a legal parse, and
    // callJsonSchema hands back whatever parsed.
    const proposals = readProposals(result.data?.results);
    telemetry.proposed = proposals.size;

    const out = clips.map((clip) => {
      const proposed = proposals.get(clip.verdict.id);
      if (proposed === undefined) return clip;
      // Every gate lives in applyExtension, including the ones this function
      // could have pre-checked. A clip that was never offered can still be
      // named by the model, and it is refused here on its own merits rather
      // than by bookkeeping.
      const extended = applyExtension(clip, nodes, proposed, cfg);
      if (!extended) {
        telemetry.refused += 1;
        return clip;
      }
      telemetry.applied += 1;
      // Safe to subtract without a guard: an accepted extension always has a
      // strictly larger endSec (applyExtension's seconds gate), so this can
      // only ever add.
      telemetry.secondsGained += extended.endSec - clip.endSec;
      return extended;
    });

    return { clips: out, telemetry };
  } catch (error) {
    // Belt and braces: callJsonSchema swallows API failures and applyExtension
    // is total, so reaching here means a defect in this file or in prompt
    // rendering. Clips that already passed every gate must still ship.
    console.warn(
      `[analyze-v2] end-extension threw, shipping the set unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { clips, telemetry };
  }
}
