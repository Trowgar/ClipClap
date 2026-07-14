import type { CriticVerdict, SentenceNode } from "./types";

export interface GateResult {
  ok: boolean;
  reason?: string;
}

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
      if (
        !Number.isInteger(idx) ||
        !node ||
        idx < verdict.startNode ||
        idx > verdict.endNode ||
        !node.hasWords
      ) {
        return { ok: false, reason: `${label}_evidence_invalid` };
      }
    }
  }
  return { ok: true };
}

/** Verbatim-snippet copy - grounded and correctly-languaged by construction. */
export function snippetFallbackCopy(
  nodes: SentenceNode[],
  startNode: number,
  endNode: number
): { title: string; description: string } {
  const texts: string[] = [];
  for (let i = startNode; i <= endNode && i < nodes.length; i++) {
    if (nodes[i]?.hasWords) texts.push(nodes[i].text);
  }
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
