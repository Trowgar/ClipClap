import type { CriticVerdict, SentenceNode, SnappedClip } from "./types";

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * How far outside a clip's node range a citation may sit before it stops being
 * a boundary artefact and becomes a lost premise. ONE constant for both
 * directions, because it answers one question:
 *
 * - BEFORE snap, `widenRangeToEvidence` pulls the critic's boundary OUT to
 *   swallow a citation this close, treating it as a boundary the critic set one
 *   node short rather than as a grounding failure.
 * - AFTER the boundaries stop moving, `regroundCopy` tolerates a citation this
 *   far outside the range that actually shipped, for the same reason.
 *
 * Measured on both sides, and 2 is where the two measurements separate.
 * podcast-ecology's only applied trim (332 -> 334) leaves the "Плейстоценовый
 * парк" title citing #332 while the title is still fully grounded in #334
 * ("Сергей Зимин ... парк ... в Якутии") and #348 ("когда генетики восстановят
 * мамонтов") - two nodes out, and nothing is wrong with the copy. Setting this
 * to 0 reds eval-snapshot by replacing that title with the verbatim
 * "Сергей Зимин который пристациновый парк пилит в Ягутии", transcription errors
 * and all. On job cms2c8ahm the compression that broke "Самые живучие на
 * планете" left #804 THREE nodes and 24.8s outside, and the description carrying
 * it narrated the previous clip.
 */
export const EVIDENCE_BOUNDARY_SLACK_NODES = 2;

/** Evidence-node grounding gate (spec §7): replaces lexical word-matching. */
export function evidenceGate(
  verdict: CriticVerdict,
  nodes: SentenceNode[]
): GateResult {
  if (!verdict.grounded) return { ok: false, reason: "critic_ungrounded" };
  if (!verdict.selfContained) return { ok: false, reason: "not_self_contained" };
  for (const [label, evidence] of [
    ["title", verdict.titleEvidenceNodes],
    ["description", verdict.descriptionEvidenceNodes],
  ] as const) {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return { ok: false, reason: `${label}_evidence_missing` };
    }
    for (const idx of evidence) {
      const node = nodes[idx];
      if (!Number.isInteger(idx) || !node) {
        return { ok: false, reason: `${label}_evidence_invalid` };
      }
      if (idx < verdict.startNode || idx > verdict.endNode) {
        return { ok: false, reason: `${label}_evidence_out_of_range` };
      }
      // NOTE: opaque nodes (hasWords=false) are VALID evidence - their segment
      // TEXT is real Whisper output; only the word TIMINGS are unreliable.
      // Grounding is about text; timing integrity belongs to snap's edge rules.
    }
  }
  return { ok: true };
}

/** Word-bearing node indices inside a range - the nodes a verbatim snippet can
 *  legitimately be built from and cite. */
function speechNodes(nodes: SentenceNode[], startNode: number, endNode: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, startNode); i <= endNode && i < nodes.length; i++) {
    if (nodes[i]?.hasWords) out.push(i);
  }
  return out;
}

/** Verbatim-snippet copy - grounded and correctly-languaged by construction. */
export function snippetFallbackCopy(
  nodes: SentenceNode[],
  startNode: number,
  endNode: number
): { title: string; description: string } {
  const texts = speechNodes(nodes, startNode, endNode).map((i) => nodes[i].text);
  const first = texts[0] ?? "";
  const title = first.length <= 70 ? first : first.slice(0, 69).trimEnd() + "…";
  const rest = texts.slice(1).join(" ");
  const description =
    rest.length > 0
      ? rest.length <= 140
        ? rest
        : rest.slice(0, 139).trimEnd() + "…"
      : title;
  return { title, description };
}

export interface RegroundResult {
  clip: SnappedClip;
  /** Fields whose copy was replaced; empty means the clip was left alone. */
  regrounded: Array<"title" | "description">;
}

/**
 * Re-checks a clip's copy against the range that actually shipped.
 *
 * `evidenceGate` runs BEFORE snap, against the critic's proposed range. Snap
 * then owns the boundaries and moves them, and the finalizer's trim moves them
 * again - so by the time a clip ships, the range its copy was approved for may
 * no longer exist. That is not hypothetical: on job cms2c8ahm the clip "Самые
 * живучие на планете" shipped with `descriptionEvidenceNodes = [804, 812, 819]`
 * after compression had moved its start past #804, and its description narrated
 * the PREVIOUS clip's ending - nuclear war and climate - which the viewer never
 * hears. Every gate passed; none of them ran again.
 *
 * WHY REPLACE THE COPY RATHER THAN DROP THE CLIP. Pre-snap, a citation outside
 * the range costs the whole clip (`*_evidence_out_of_range`). Post-snap the
 * cause is different - the CODE moved the boundary, the critic did nothing
 * wrong - and the moment is still good, so only the narration is void. This is
 * deliberately the lenient branch of the rule the engine already enforces.
 *
 * WHY ALL-OR-NOTHING PER FIELD, and this is the uncomfortable part. A citation
 * list is the critic's claim about where a field is grounded, and the surviving
 * citations do NOT certify the text: the broken description above still cited
 * #812 and #819, both inside the clip, and was false anyway. There is no
 * deterministic way to tell a title that survives losing a citation from a
 * description that does not - the two fields shipped IDENTICAL citation lists on
 * that clip. So one stale citation voids the field, and the measured cost is
 * that clip's title, which was fine, being replaced along with its description,
 * which was not. `lexicalOverlap` would separate them and is not available: it
 * penalises paraphrase and inflection and is telemetry, never a gate.
 *
 * PURE, deterministic and free. This runs after the last stage that can move a
 * boundary, where an LLM repair would be a new failure mode with veto power over
 * copy that already passed every earlier gate.
 */
export function regroundCopy(clip: SnappedClip, nodes: SentenceNode[]): RegroundResult {
  const from = clip.finalStartNode;
  const to = clip.finalEndNode;
  const stale = (evidence: number[]): boolean =>
    evidence.some(
      (i) =>
        !Number.isInteger(i) ||
        i < from - EVIDENCE_BOUNDARY_SLACK_NODES ||
        i > to + EVIDENCE_BOUNDARY_SLACK_NODES
    );

  const regrounded: Array<"title" | "description"> = [];
  if (stale(clip.verdict.titleEvidenceNodes)) regrounded.push("title");
  if (stale(clip.verdict.descriptionEvidenceNodes)) regrounded.push("description");
  if (regrounded.length === 0) return { clip, regrounded };

  const snippet = snippetFallbackCopy(nodes, from, to);
  const speech = speechNodes(nodes, from, to);
  // An all-opaque range yields no speech node to cite; the range edge is still a
  // real Whisper boundary, and an empty citation list would be a worse lie than
  // a coarse one.
  const titleNodes = [speech[0] ?? from];
  const descriptionNodes = (speech.length > 1 ? speech.slice(1, 4) : speech.slice(0, 1)).concat(
    speech.length === 0 ? [from] : []
  );

  const verdict = { ...clip.verdict };
  if (regrounded.includes("title")) {
    verdict.title = snippet.title;
    verdict.titleEvidenceNodes = titleNodes;
  }
  if (regrounded.includes("description")) {
    verdict.description = snippet.description;
    verdict.descriptionEvidenceNodes = descriptionNodes;
  }
  return { clip: { ...clip, verdict }, regrounded };
}

/** Telemetry only - penalizes paraphrase and inflected languages, never gates. */
export function lexicalOverlap(copy: string, clipText: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter((w) => w.length > 2);
  const copyWords = norm(copy);
  if (copyWords.length === 0) return 0;
  const clipWords = new Set(norm(clipText));
  const hits = copyWords.filter((w) => clipWords.has(w)).length;
  return hits / copyWords.length;
}
