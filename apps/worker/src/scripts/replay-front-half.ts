/**
 * Shared replay plumbing for the front half of the ANALYZE pipeline
 * (scanner -> merge -> teaser -> critic-candidate selection -> critic ->
 * evidence gate -> snap -> select), extracted from `eval-arc-stability.ts`'s
 * original `buildSelectedSet` (2026-08-10, spec "Clip arc audit ... " task 2
 * item 7) so a second script (`eval-selection-autopsy.ts`, spec
 * 2026-08-11 "Selection autopsy") does not need a third copy of it.
 *
 * DELIBERATELY NOT index.ts's own front half. Same tradeoff eval-arc-stability
 * and eval-arc-audit.ts already documented for rebuilding buildSentenceGraph
 * externally rather than threading a helper through index.ts: an exported
 * "run through selection" entry point would reshape the orchestrator for a
 * benefit only these scripts need. Two simplifications this module inherits
 * from eval-arc-stability.ts's original code, unchanged:
 *
 *   - `widenRangeToEvidence` (index.ts's own pre-snap evidence widening, up to
 *     EVIDENCE_BOUNDARY_SLACK_NODES=2 nodes) is skipped.
 *   - Copy repair (`scriptMismatch`/`repairCopy`) and the post-gate
 *     `regroundCopy` pass are skipped entirely - neither moves a node
 *     boundary, and `eligible` here is read for STRUCTURE (which candidate
 *     became which clip, at which nodes), never for the shipped copy.
 *   - Transcript hole filtering (`missingRanges`) is skipped: real fixtures
 *     recorded from a complete source video carry none.
 *
 * None of that changes what `eval-arc-stability.ts` measures - it never read
 * copy or hole-filtering either - so extracting this cost it nothing.
 */
import type OpenAI from "openai";
import { createReplayClient } from "../__tests__/helpers/replay-client";
import type { Fixture } from "../__tests__/helpers/eval-fixture";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { runScanner, type ScannerResult } from "../analyze-v2/scanner";
import { mergeCandidates, selectCriticCandidates } from "../analyze-v2/candidates";
import { runCritic, type CriticRunResult } from "../analyze-v2/critic";
import { evidenceGate, type GateResult } from "../analyze-v2/gates";
import { snapNodes } from "../analyze-v2/snap";
import { selectAndOrder, type SelectionResult } from "../analyze-v2/select";
import { detectTeaserRegion, isInTeaserRegion, type TeaserRegion } from "../analyze-v2/teaser";
import { newUsage } from "../analyze-v2/llm";
import type { AnalyzeConfig } from "../analyze-v2/config";
import type {
  CriticVerdict,
  MergedCandidate,
  SentenceNode,
  SnappedClip,
  SnapResult,
} from "../analyze-v2/types";

/** What happened to one critic verdict on the way to (or away from)
 *  eligibility. Present fields are exactly the stages the verdict reached:
 *  a verdict with `keep: false` has neither `gate` nor `snap`; a verdict the
 *  gate rejected has `gate` but no `snap`; `clip` is set if and only if
 *  `snap.ok` is true. */
export interface VerdictOutcome {
  verdict: CriticVerdict;
  gate?: GateResult;
  snap?: SnapResult;
  clip?: SnappedClip;
}

export interface FrontHalfResult {
  nodes: SentenceNode[];
  cfg: AnalyzeConfig;
  scan: ScannerResult;
  merged: MergedCandidate[];
  teaserRegion: TeaserRegion | null;
  /** merged candidates dropped for starting inside the detected teaser region. */
  teaserDropped: MergedCandidate[];
  /** merged, minus teaser drops - what selectCriticCandidates saw. */
  withoutTeasers: MergedCandidate[];
  /** selectCriticCandidates' own output - the ones actually judged. */
  criticCandidates: MergedCandidate[];
  critic: CriticRunResult;
  verdictOutcomes: VerdictOutcome[];
  eligible: SnappedClip[];
  selection: SelectionResult;
}

/**
 * Replays scanner -> merge -> teaser -> critic-candidate selection -> critic
 * -> evidence gate -> snap -> select against a fixture's recorded responses.
 * Every deterministic layer runs for real; the LLM layers replay from
 * `fixture.responses`.
 *
 * Throws if the fixture is missing a recorded scanner/critic response this
 * replay needs - same message `eval-arc-stability.ts` always threw, preserved
 * verbatim so its own behavior does not move.
 */
export async function runFrontHalf(
  fixture: Fixture,
  cfg: AnalyzeConfig
): Promise<FrontHalfResult> {
  const nodes = buildSentenceGraph(fixture.transcript.segments, cfg);
  const replay: OpenAI = createReplayClient(fixture.responses);
  const usage = newUsage();

  const scan = await runScanner(replay, usage, nodes, cfg, { retryDelayMs: 1 });
  const merged = mergeCandidates(scan.candidates, nodes, cfg);
  const teaserRegion = detectTeaserRegion(nodes, cfg);
  const teaserDropped: MergedCandidate[] = [];
  const withoutTeasers = merged.filter((c) => {
    if (!isInTeaserRegion(teaserRegion, nodes[c.startNode].start)) return true;
    teaserDropped.push(c);
    return false;
  });
  const criticCandidates = selectCriticCandidates(withoutTeasers, nodes, cfg);

  const languageIso = fixture.transcript.language ?? "en";
  const critic = await runCritic(replay, usage, nodes, criticCandidates, languageIso, cfg, {
    retryDelayMs: 1,
  });

  const verdictOutcomes: VerdictOutcome[] = [];
  const eligible: SnappedClip[] = [];
  for (const verdict of critic.verdicts) {
    if (!verdict.keep) {
      verdictOutcomes.push({ verdict });
      continue;
    }
    const gate = evidenceGate(verdict, nodes);
    if (!gate.ok) {
      verdictOutcomes.push({ verdict, gate });
      continue;
    }
    const snapped = snapNodes(verdict, nodes, cfg);
    if (!snapped.ok) {
      verdictOutcomes.push({ verdict, gate, snap: snapped });
      continue;
    }
    verdictOutcomes.push({ verdict, gate, snap: snapped, clip: snapped.clip });
    eligible.push(snapped.clip);
  }

  // Same check, same message, same position in the flow (after the eligible
  // loop, before selectAndOrder) as the original buildSelectedSet.
  const replayWithMissing = replay as OpenAI & { missing: string[] };
  if (replayWithMissing.missing.length > 0) {
    const unique = [...new Set(replayWithMissing.missing)];
    throw new Error(
      `fixture "${fixture.name}" is missing ${unique.length} recorded scanner/critic ` +
        `response(s) needed to reconstruct the selected set [${unique.join(", ")}] - ` +
        `re-record it or check whether a prompt changed.`
    );
  }

  const selection = selectAndOrder(eligible, cfg, cfg.softCap + cfg.finalizerHeadroom);

  return {
    nodes,
    cfg,
    scan,
    merged,
    teaserRegion,
    teaserDropped,
    withoutTeasers,
    criticCandidates,
    critic,
    verdictOutcomes,
    eligible,
    selection,
  };
}
