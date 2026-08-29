import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema, mapWithConcurrency } from "./llm";
import { ARC_AUDIT_SYSTEM, arcAuditUserPrompt } from "./prompts";
import { ARC_AUDIT_SCHEMA } from "./schemas";
import { isCleanStart } from "./sentence-graph";
import type {
  ArcEntryDefect,
  ArcExitDefect,
  ArcFlags,
  LlmUsage,
  SentenceNode,
  SnappedClip,
} from "./types";

const ARC_ENTRY_DEFECTS: ReadonlySet<string> = new Set<ArcEntryDefect>([
  "dangling_reference",
  "mid_story",
  "borrowed_answer",
  "meta_opening",
]);
const ARC_EXIT_DEFECTS: ReadonlySet<string> = new Set<ArcExitDefect>([
  "mid_thought",
  "setup_no_payoff",
  "transition_out",
  "refuted_after",
]);

// Output budget for one arc-audit batch call.
//
// PROVISIONAL, pending the M5 ladder measurement - see spec 2026-08-10. This
// stage has not been run once yet, so rather than inventing a number it
// reuses the critic's shape verbatim: CRITIC_BASE_TOKENS / CRITIC_TOKENS_PER_
// CANDIDATE (critic.ts) were derived from a live measurement ladder over a
// prompt of comparable weight - strict json_schema, a padded context window,
// reasoning_effort driven by the same knob. Three questions per clip against
// the critic's ~8, so if anything this UNDER-estimates the visible-JSON term;
// the base term is unmeasured for this exact prompt either way. Re-measure
// from a real batch's completion_tokens at batch 1/2/4 before trusting this
// further than "does not truncate on the fixtures" (M5, spec §3).
export const ARC_AUDIT_BASE_TOKENS = 1200;
export const ARC_AUDIT_TOKENS_PER_CLIP = 800;

/** Output cap for one arc-audit batch call. */
export function arcAuditMaxOutputTokens(clipCount: number): number {
  return ARC_AUDIT_BASE_TOKENS + ARC_AUDIT_TOKENS_PER_CLIP * clipCount;
}

/** Same concurrency the critic runs its batches at (critic.ts's
 *  CRITIC_CONCURRENCY) - independent per-clip judgements over a shared node
 *  graph, no reason for a different number until one is measured. */
const ARC_AUDIT_CONCURRENCY = 4;

/**
 * Why a proposed fix pointer (`fix_start_node` or `fix_end_node`) did not
 * survive into the flag. Named, like end-extension's ExtensionRefuseReason and
 * the critic's drop counters, because the histogram this feeds is the only
 * thing that can say WHAT to do about a rising count - a prompt edit for
 * `not_clean_start`, a window widening (with a fresh measurement) for
 * `outside_window`, nothing at all for `wrong_direction` on a model that
 * cannot yet tell forward from backward.
 *
 * THE FLAG SURVIVES a gate failure; only the pointer is dropped (spec 2026-08-10
 * task 2, item 4). A clip whose entry the model called broken is still
 * reported broken even when its `fix_start_node` failed a gate - the
 * detector's finding and the detector's repair suggestion are different
 * claims, and only the second is code-gated here.
 */
export type ArcGateReason =
  | "not_an_index"
  | "wrong_direction"
  | "outside_graph"
  | "outside_window"
  | "not_clean_start";

/**
 * What the stage did, in the numbers the spec's acceptance criteria (M3) and
 * the dark-stage control both read.
 *
 * `audited` + `unaudited` always equals the number of clips this stage was
 * called with - every clip lands in exactly one bucket. `unaudited` covers
 * every way this task's NO-RETRY policy can lose a clip: the whole batch call
 * truncated, refused or hard-errored; the model omitted the row; the row
 * failed shape validation (missing an axis, an out-of-enum defect, a
 * duplicate id). None of those retries - the critic's omission-retry lesson
 * (engine-notes §3) is that a JUDGE's silent miss is a recall defect worth a
 * second ask; a DETECTOR's miss is tolerable and bounded, which is why a
 * counter is the whole remedy here.
 *
 * `flaggedEntry`/`flaggedExit`/`flaggedStandalone` count `ok: false` on each
 * axis among AUDITED clips only - independent counts, since a clip can fail
 * more than one axis or none.
 *
 * `byDefect` pools entry and exit defects into one histogram (the two enums do
 * not overlap, so there is nothing to disambiguate) and counts a defect only
 * when its axis is `ok: false` - a model that names a defect while somehow
 * also claiming `ok: true` is a schema-legal inconsistency the prompt does not
 * ask for, and this stage does not surface it as a flagged defect either.
 *
 * `gatedOut` is ArcGateReason -> count, incremented once per pointer that
 * FAILED a gate (fix_start_node and fix_end_node share the histogram; the
 * reason names are shared and the entry/exit split is visible from `byDefect`
 * and the two flagged counters instead).
 */
export interface ArcAuditTelemetry {
  audited: number;
  unaudited: number;
  flaggedEntry: number;
  flaggedExit: number;
  flaggedStandalone: number;
  byDefect: Partial<Record<ArcEntryDefect | ArcExitDefect, number>>;
  gatedOut: Partial<Record<ArcGateReason, number>>;
}

export interface ArcAuditResult {
  flags: Map<string, ArcFlags>;
  telemetry: ArcAuditTelemetry;
  /** Telemetry-only audit-time geometry. It deliberately shares the already
   * published flag object rather than creating or mutating a second flag map. */
  geometryEvidence: Map<string, ArcAuditGeometryEvidence>;
}

export interface ArcAuditGeometryEvidence {
  id: string;
  finalStartNode: number;
  finalEndNode: number;
  startMs: number;
  endMs: number;
  flags: ArcFlags;
}

/**
 * "Blessed", verbatim from spec 2026-08-10 §2b (task 5): flags EXIST for this
 * clip AND all three axes read `ok: true`. Unaudited (`undefined`) and
 * audit-dark (arcAuditEnabled off, so the caller never even looked this id up)
 * both read as NOT blessed - the same "absent means not established" reading
 * this file already uses for a missing pointer, never a silent pass.
 *
 * ONE helper, used at all three places blessed-ness is asked (spec task 5,
 * item 4): the long-clip policy in index.ts, start-extension.ts's too_long
 * gate, end-extension.ts's fitsMaxSec/extensionWindow. Detection logic is
 * untouched - this reads a verdict already computed by runArcAudit, above; it
 * does not judge anything itself.
 *
 * DELIBERATELY UNCHANGED by the `repaired` follow-up (2026-08-11): this
 * reads `ok` only, never `repaired`, on every axis. A repaired axis was still
 * NOT CLEAN AT AUDIT TIME - the detector flagged something real about the
 * clip's THEN-current boundary, and a later widen fixing that boundary is a
 * different fact from the audit having found nothing wrong in the first
 * place. The long-clip gate this feeds stays conservative on purpose: it
 * blesses only material the audit never had a complaint about, not material
 * a complaint was later patched on. So `entry.repaired`/`exit.repaired` can
 * both be `true` and `isFullyOk` still returns `false` for that clip, same as
 * before this follow-up existed.
 */
export function isFullyOk(flags: ArcFlags | undefined): boolean {
  return !!flags && flags.entry.ok && flags.exit.ok && flags.standalone.ok;
}

function emptyTelemetry(): ArcAuditTelemetry {
  return {
    audited: 0,
    unaudited: 0,
    flaggedEntry: 0,
    flaggedExit: 0,
    flaggedStandalone: 0,
    byDefect: {},
    gatedOut: {},
  };
}

function countGate(t: ArcAuditTelemetry, reason: ArcGateReason): void {
  t.gatedOut[reason] = (t.gatedOut[reason] ?? 0) + 1;
}

function countDefect(t: ArcAuditTelemetry, defect: ArcEntryDefect | ArcExitDefect): void {
  t.byDefect[defect] = (t.byDefect[defect] ?? 0) + 1;
}

type GateOutcome =
  | { ok: true; node: number }
  | { ok: false; reason: ArcGateReason };

/**
 * Gates a proposed BACKWARD pointer (`entry.fix_start_node`) against the clip
 * it would widen. This is a DETECTOR's gate, not extendClipStarts's (task 3,
 * not built yet) - it decides whether the flag may CARRY the pointer, never
 * whether to move a boundary. Order matters, same filing rule as
 * end-extension's applyExtension: a pointer failing two checks is filed under
 * the earlier one, and only `not_an_index` and `wrong_direction` are safe to
 * ask before the bounds check has run (they are pure number comparisons, no
 * array access).
 */
export function gateEntryFix(
  fixStartNode: number,
  clip: SnappedClip,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): GateOutcome {
  if (!Number.isInteger(fixStartNode)) return { ok: false, reason: "not_an_index" };
  if (fixStartNode >= clip.finalStartNode) return { ok: false, reason: "wrong_direction" };
  if (fixStartNode < 0 || fixStartNode > nodes.length - 1) {
    return { ok: false, reason: "outside_graph" };
  }
  // Converted through node START times, per spec 2026-08-10 task 2 item 4 -
  // the same reference point the fixed opening line will actually play from.
  const distanceSec = nodes[clip.finalStartNode].start - nodes[fixStartNode].start;
  if (distanceSec > cfg.startExtensionWindowSec) return { ok: false, reason: "outside_window" };
  if (!isCleanStart(nodes, fixStartNode)) return { ok: false, reason: "not_clean_start" };
  return { ok: true, node: fixStartNode };
}

/**
 * Gates a proposed FORWARD pointer (`exit.fix_end_node`). Reuses
 * `endExtensionWindowSec` - the EXISTING end-extension window, not a new knob
 * - because task 4 hands this same pointer to extendClipEnds as a hint: the
 * detector's own window has to agree with the stage that will eventually act
 * on it, or a pointer this gate accepts could still be refused there for a
 * reason nobody could see coming.
 */
export function gateExitFix(
  fixEndNode: number,
  clip: SnappedClip,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): GateOutcome {
  if (!Number.isInteger(fixEndNode)) return { ok: false, reason: "not_an_index" };
  if (fixEndNode <= clip.finalEndNode) return { ok: false, reason: "wrong_direction" };
  if (fixEndNode < 0 || fixEndNode > nodes.length - 1) {
    return { ok: false, reason: "outside_graph" };
  }
  const distanceSec = nodes[fixEndNode].end - nodes[clip.finalEndNode].end;
  if (distanceSec > cfg.endExtensionWindowSec) return { ok: false, reason: "outside_window" };
  return { ok: true, node: fixEndNode };
}

// ---------------------------------------------------------------------------
// Row parsing - defensive by construction. `callJsonSchema` calls the real API
// under `strict: true`, which guarantees a conforming shape in production, but
// this stage must not simply trust that: a replay fixture or a future caller
// can hand it anything JSON.parse can produce, and "a row missing an axis or
// carrying an out-of-enum defect must land in `unaudited`, not crash" is one
// of this task's own acceptance tests. Every reader below returns null - never
// throws, never guesses - on anything it cannot fully trust.
// ---------------------------------------------------------------------------

interface ParsedEntry {
  ok: boolean;
  defect: ArcEntryDefect | null;
  fixStartNode: number | null;
}
interface ParsedExit {
  ok: boolean;
  defect: ArcExitDefect | null;
  fixEndNode: number | null;
}
interface ParsedStandalone {
  ok: boolean;
  missing: string | null;
}
interface ParsedRow {
  id: string;
  entry: ParsedEntry;
  exit: ParsedExit;
  standalone: ParsedStandalone;
}

function readEntry(raw: unknown): ParsedEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { ok, defect, fix_start_node: fixStartNode } = raw as Record<string, unknown>;
  if (typeof ok !== "boolean") return null;
  if (defect !== null && !(typeof defect === "string" && ARC_ENTRY_DEFECTS.has(defect))) {
    return null;
  }
  if (fixStartNode !== null && typeof fixStartNode !== "number") return null;
  return {
    ok,
    defect: (defect as ArcEntryDefect | null) ?? null,
    fixStartNode: fixStartNode ?? null,
  };
}

function readExit(raw: unknown): ParsedExit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { ok, defect, fix_end_node: fixEndNode } = raw as Record<string, unknown>;
  if (typeof ok !== "boolean") return null;
  if (defect !== null && !(typeof defect === "string" && ARC_EXIT_DEFECTS.has(defect))) {
    return null;
  }
  if (fixEndNode !== null && typeof fixEndNode !== "number") return null;
  return {
    ok,
    defect: (defect as ArcExitDefect | null) ?? null,
    fixEndNode: fixEndNode ?? null,
  };
}

function readStandalone(raw: unknown): ParsedStandalone | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { ok, missing } = raw as Record<string, unknown>;
  if (typeof ok !== "boolean") return null;
  if (missing !== null && typeof missing !== "string") return null;
  return { ok, missing: (missing as string | null) ?? null };
}

function readRow(raw: unknown): ParsedRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, entry, exit, standalone } = raw as Record<string, unknown>;
  if (typeof id !== "string") return null;
  const parsedEntry = readEntry(entry);
  const parsedExit = readExit(exit);
  const parsedStandalone = readStandalone(standalone);
  if (!parsedEntry || !parsedExit || !parsedStandalone) return null;
  return { id, entry: parsedEntry, exit: parsedExit, standalone: parsedStandalone };
}

/**
 * Runs the arc audit over the SELECTED set - the same clips extendClipEnds
 * receives (index.ts: after selectAndOrder, before extendClipEnds). PURE
 * DETECTOR: no boundary in `clips` is ever moved here, and nothing this
 * function returns can shorten, lengthen, drop or reorder a clip. Its whole
 * output is a flag map and a telemetry block.
 *
 * NEVER throws. Any call failure - truncation, refusal, a hard error - leaves
 * every clip in that batch `unaudited` and moves on; there is no retry and no
 * fallback model in this version (spec 2026-08-10 task 2: "no other numbers,
 * no other resilience machinery until measured"). A detector's miss is
 * tolerable and counted; it must never cost the job.
 */
export async function runArcAudit(
  client: OpenAI,
  usage: LlmUsage,
  clips: SnappedClip[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  options: { retryDelayMs?: number } = {}
): Promise<ArcAuditResult> {
  const telemetry = emptyTelemetry();
  const flags = new Map<string, ArcFlags>();
  const geometryEvidence = new Map<string, ArcAuditGeometryEvidence>();
  // Defence in depth, same as extendClipEnds's own top-of-function guard: the
  // caller (index.ts) already gates this behind cfg.arcAuditEnabled, but a
  // module that moves a boundary - or, here, publishes a flag - must not trust
  // a single call site to be the only thing standing between it and a live
  // call while the stage is meant to ship dark.
  if (!cfg.arcAuditEnabled || clips.length === 0) {
    return { flags, telemetry, geometryEvidence };
  }

  const byId = new Map(clips.map((c) => [c.verdict.id, c]));
  const batches: SnappedClip[][] = [];
  for (let i = 0; i < clips.length; i += cfg.arcAuditBatchSize) {
    batches.push(clips.slice(i, i + cfg.arcAuditBatchSize));
  }

  await mapWithConcurrency(batches, ARC_AUDIT_CONCURRENCY, async (batch) => {
    const result = await callJsonSchema<{ results?: unknown }>(client, usage, {
      model: cfg.criticModel,
      system: ARC_AUDIT_SYSTEM,
      user: arcAuditUserPrompt(batch, nodes),
      schema: ARC_AUDIT_SCHEMA,
      reasoningEffort: cfg.reasoningEffort,
      maxOutputTokens: arcAuditMaxOutputTokens(batch.length),
      retryDelayMs: options.retryDelayMs,
    });

    // NO RETRY (spec task 2): a batch that truncates, refuses or hard-errors
    // leaves every clip in it unaudited. See ArcAuditTelemetry's doc comment
    // for why this is the deliberately bounded twin of the critic's omission
    // retry rather than a copy of it.
    if (!result.ok) {
      telemetry.unaudited += batch.length;
      return;
    }
    const rows = Array.isArray(result.data?.results) ? result.data.results : [];
    const batchIds = new Set(batch.map((c) => c.verdict.id));
    const seen = new Set<string>();

    for (const raw of rows) {
      const row = readRow(raw);
      // Wrong shape, an id outside this batch (a hallucinated or foreign id -
      // the same per-batch id guard critic.ts uses), or a repeat of an id
      // already read: none of these are trustworthy enough to act on, and all
      // three count exactly like an omission - unaudited, never a crash and
      // never a guess.
      if (!row || !batchIds.has(row.id) || seen.has(row.id)) continue;
      seen.add(row.id);
      const clip = byId.get(row.id);
      if (!clip) continue; // unreachable given batchIds.has(row.id) above; kept for totality

      const entryFlag: ArcFlags["entry"] = { ok: row.entry.ok };
      if (!row.entry.ok && row.entry.defect) {
        entryFlag.defect = row.entry.defect;
        countDefect(telemetry, row.entry.defect);
      }
      if (!row.entry.ok && row.entry.fixStartNode !== null) {
        const gate = gateEntryFix(row.entry.fixStartNode, clip, nodes, cfg);
        if (gate.ok) entryFlag.fixStartNode = gate.node;
        else countGate(telemetry, gate.reason);
      }

      const exitFlag: ArcFlags["exit"] = { ok: row.exit.ok };
      if (!row.exit.ok && row.exit.defect) {
        exitFlag.defect = row.exit.defect;
        countDefect(telemetry, row.exit.defect);
      }
      if (!row.exit.ok && row.exit.fixEndNode !== null) {
        const gate = gateExitFix(row.exit.fixEndNode, clip, nodes, cfg);
        if (gate.ok) exitFlag.fixEndNode = gate.node;
        else countGate(telemetry, gate.reason);
      }

      const standaloneFlag: ArcFlags["standalone"] = { ok: row.standalone.ok };
      if (!row.standalone.ok && row.standalone.missing) {
        standaloneFlag.missing = row.standalone.missing;
      }

      const flag = { entry: entryFlag, exit: exitFlag, standalone: standaloneFlag };
      flags.set(row.id, flag);
      geometryEvidence.set(row.id, {
        id: row.id,
        finalStartNode: clip.finalStartNode,
        finalEndNode: clip.finalEndNode,
        startMs: Math.round(clip.startSec * 1000),
        endMs: Math.round(clip.endSec * 1000),
        flags: flag,
      });
      telemetry.audited += 1;
      if (!row.entry.ok) telemetry.flaggedEntry += 1;
      if (!row.exit.ok) telemetry.flaggedExit += 1;
      if (!row.standalone.ok) telemetry.flaggedStandalone += 1;
    }

    const missed = batch.filter((c) => !seen.has(c.verdict.id));
    telemetry.unaudited += missed.length;
  });

  return { flags, telemetry, geometryEvidence };
}
