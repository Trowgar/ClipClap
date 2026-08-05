import type { CriticVerdict, SentenceNode, SnappedClip } from "./types";

export interface GateResult {
  ok: boolean;
  reason?: string;
  /**
   * Fields whose citations sit outside the critic's own proposed range. NOT a
   * rejection - see `evidenceGate` - and absent on any `ok: false` result,
   * because a dropped verdict has no copy left to report on.
   */
  outOfRange?: Array<"title" | "description">;
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

/**
 * Evidence-node grounding gate (spec §7): replaces lexical word-matching.
 *
 * WHAT IT DROPS, and it is one category: the critic broke the protocol. It said
 * the clip is not grounded or not self-contained; it cited nothing; or it cited
 * something that is not a node of this graph. None of those has a repair, and
 * none of them is about the copy being wrong - they are about there being no
 * usable answer at all.
 *
 * WHAT IT ONLY REPORTS, since 2026-08-04: a citation OUTSIDE the critic's own
 * proposed range. This used to cost the whole clip, and it contradicted
 * engine-notes §4 - a clip is never dropped for its copy - for as long as it
 * existed. Two things make dropping the wrong answer:
 *
 * - The repair already exists and runs immediately afterwards. `regroundCopy`
 *   asks the SAME question against a strictly better range (the one that shipped,
 *   after snap and any trim, rather than the one the critic proposed) and answers
 *   it by voiding the offending field's copy while keeping the moment. Every clip
 *   that leaves this gate alive and survives snap goes through it; a clip that
 *   does not survive snap was never going to ship anyway.
 * - The cases are bookkeeping, not lost premises. On sitcom-friends the critic
 *   tightened its own range and reused the citations it had written for the wider
 *   one - c8 moved start 443 -> 447 still citing 443, c6 moved end 276 -> 267
 *   still citing 274 - and the ca8dfec prompt change took this reason from 2 to 9
 *   across the eval suite, costing that fixture 3 of 12 clips including two a
 *   reviewer wanted to publish. The moment was never the thing that was wrong.
 *
 * A citation far outside is not a separate case needing a separate answer: it is
 * stale for `regroundCopy` too, and the field it grounds is replaced with the
 * clip's own speech, verbatim. Losing the copy is the whole cost either way.
 *
 * The count is NOT lost. It comes back as `outOfRange`, lands in telemetry as
 * `evidenceOutOfRange` and in the eval snapshots as `outOfRange`, which is the
 * signal the 2 -> 9 regression was found with.
 */
export function evidenceGate(
  verdict: CriticVerdict,
  nodes: SentenceNode[]
): GateResult {
  if (!verdict.grounded) return { ok: false, reason: "critic_ungrounded" };
  if (!verdict.selfContained) return { ok: false, reason: "not_self_contained" };
  const outOfRange: Array<"title" | "description"> = [];
  for (const [label, evidence] of [
    ["title", verdict.titleEvidenceNodes],
    ["description", verdict.descriptionEvidenceNodes],
  ] as const) {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return { ok: false, reason: `${label}_evidence_missing` };
    }
    for (const idx of evidence) {
      const node = nodes[idx];
      // ORDER MATTERS: a citation outside the GRAPH is invalid and fatal, and it
      // is also outside the range. Reporting it as drift instead would ship a
      // clip whose copy is grounded in a node that does not exist.
      if (!Number.isInteger(idx) || !node) {
        return { ok: false, reason: `${label}_evidence_invalid` };
      }
      // NOTE: opaque nodes (hasWords=false) are VALID evidence - their segment
      // TEXT is real Whisper output; only the word TIMINGS are unreliable.
      // Grounding is about text; timing integrity belongs to snap's edge rules.
    }
    // Once per FIELD, not once per citation: the unit `regroundCopy` repairs is
    // the field, so a field with three stale citations is one thing gone wrong.
    if (evidence.some((idx) => idx < verdict.startNode || idx > verdict.endNode)) {
      outOfRange.push(label);
    }
  }
  return { ok: true, outOfRange };
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
 * WHY REPLACE THE COPY RATHER THAN DROP THE CLIP. Because the moment is still
 * good and only the narration is void, whichever stage broke it - the code
 * moving a boundary here, or the critic editing its range without re-reading its
 * own citations before the gate. This is now the ONLY answer the engine gives to
 * an out-of-range citation: `evidenceGate` used to drop the clip for the same
 * condition and stopped on 2026-08-04, because a clip is never dropped for its
 * copy (engine-notes §4) and because this function is a strictly better place to
 * ask - it knows the range the viewer actually hears.
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
