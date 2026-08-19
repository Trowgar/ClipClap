import type { AnalyzeConfig } from "./config";
import { compressToFit, snapNodes } from "./snap";
import { regroundCopy, snippetFallbackCopy } from "./gates";
import { scriptMismatch } from "./language";
import type { CriticVerdict, SentenceNode, SnappedClip } from "./types";

/**
 * SHORT-SOURCE RESCUE (spec 2026-08-19-short-source-rescue).
 *
 * Runs only at analyzeHighlightsV2's final empty exit, for a source at or
 * under cfg.shortSourceRescueMaxSec, AFTER the unjudged guard has ruled the
 * emptiness a real judgement. Every kill point below the critic - keep:false,
 * the evidence gate, snap, selection, the finalizer - funnels into that one
 * exit, which is why the rescue lives there and not in selectAndOrder: the
 * measured population (17 short NO_VIABLE_MOMENTS jobs) never reached
 * selection with a non-empty pool, so a lower selection bar would have
 * rescued nothing.
 *
 * The contract: take the best-scoring verdict - keep:true and keep:false
 * alike, because keep:false is exactly the judgement being overridden for a
 * demo clip - that snap can realize, and ship it marked lowQuality so the
 * existing "best available" caption travels with it. Deterministic and free:
 * no LLM call on any path in this module.
 *
 * What is deliberately SKIPPED and what is NOT:
 * - The evidence gate is skipped: it protects copy quality, and failing copy
 *   is replaced below (reground, then verbatim snippet) instead of dropping
 *   the clip.
 * - snapNodes is NOT skipped: it is the boundary-existence proof. A verdict
 *   that cannot snap cannot be rendered honestly and is counted, not shipped.
 * - The long-clip blessing is not available here (no arc audit ran for this
 *   clip), so an overLength snap is resolved the way the policy resolves an
 *   UNBLESSED clip: compressToFit, or the verdict is skipped when even that
 *   fails - never shipped wide.
 */
export interface RescueTelemetry {
  /** Verdicts snap actually ran on - the failure counts + 1 when shipped,
   *  their sum when nothing could be realized. */
  attempted: number;
  /** No clean boundaries exist for the moment at all. */
  snapFailures: number;
  /** Boundaries exist but the moment is over maxSec and no clean start
   *  inside it fits the cap. Kept apart from snapFailures because the two
   *  argue for different engine work at the measurement checkpoint. */
  compressFailures: number;
  shipped: boolean;
  verdictId?: string;
  score?: number;
  /** What the critic had said about the shipped verdict - false is the
   *  expected common case and the whole point of the rescue. */
  keptByCritic?: boolean;
  /** Where the shipped copy came from: the critic's own words, reground
   *  citations, or the verbatim snippet replacement. */
  copySource?: "model" | "reground" | "snippet";
}

export interface RescueOutcome {
  clip: SnappedClip | null;
  telemetry: RescueTelemetry;
}

export function rescueShortSource(
  verdicts: CriticVerdict[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): RescueOutcome {
  // Score decides, id breaks ties - the critic re-rolls between runs, and a
  // rescue that ships a different clip for the same verdict set would make
  // the telemetry unreadable.
  const ordered = [...verdicts].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id)
  );

  let snapFailures = 0;
  let compressFailures = 0;
  for (const verdict of ordered) {
    const snapped = snapNodes(verdict, nodes, cfg);
    if (!snapped.ok) {
      snapFailures += 1;
      continue;
    }

    // An overLength snap deferred its compression expecting the long-clip
    // policy to bless or compress it. No blessing exists here, so resolve it
    // exactly as the policy resolves an unblessed clip - same call, same
    // fields (index.ts long-clip policy block).
    let clip = snapped.clip;
    if (clip.overLength) {
      const compressed = compressToFit(
        {
          startNode: clip.finalStartNode,
          endSec: clip.endSec,
          hookStartNode: clip.verdict.hookStartNode,
        },
        nodes,
        cfg
      );
      if (!compressed.ok) {
        compressFailures += 1;
        continue;
      }
      clip = {
        ...clip,
        startSec: compressed.startSec,
        finalStartNode: compressed.startNode,
        overLength: false,
        shortMoment: clip.endSec - compressed.startSec < cfg.targetMinSec,
      };
    }

    // Copy hygiene, the main loop's own sequence minus the LLM repair call:
    // reground citations to the shipped range, then verify the words against
    // the speech the viewer will actually hear and fall back to the verbatim
    // snippet - grounded and correctly-languaged by construction - when they
    // do not match. A demo clip does not earn a model call.
    const reground = regroundCopy(clip, nodes);
    clip = reground.clip;
    const clipText = nodes
      .slice(clip.finalStartNode, clip.finalEndNode + 1)
      .filter((n) => n.hasWords)
      .map((n) => n.text)
      .join(" ");
    let copySource: NonNullable<RescueTelemetry["copySource"]> =
      reground.regrounded.length > 0 ? "reground" : "model";
    let { title, description } = clip.verdict;
    if (
      title.trim().length === 0 ||
      scriptMismatch(`${title} ${description}`, clipText)
    ) {
      ({ title, description } = snippetFallbackCopy(
        nodes,
        clip.finalStartNode,
        clip.finalEndNode
      ));
      copySource = "snippet";
    }

    return {
      // lowQuality is the existing weak-tier flag: render carries it and the
      // bot caption prints the "best available" note - zero new copy.
      clip: {
        ...clip,
        verdict: { ...clip.verdict, title, description, lowQuality: true },
      },
      telemetry: {
        attempted: snapFailures + compressFailures + 1,
        snapFailures,
        compressFailures,
        shipped: true,
        verdictId: verdict.id,
        score: verdict.score,
        keptByCritic: verdict.keep,
        copySource,
      },
    };
  }

  return {
    clip: null,
    telemetry: {
      attempted: ordered.length,
      snapFailures,
      compressFailures,
      shipped: false,
    },
  };
}
