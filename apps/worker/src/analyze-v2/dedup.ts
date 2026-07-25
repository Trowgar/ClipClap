/**
 * Pure dedup primitives for the clip finalizer (spec 2026-07-24 §4.2, §4.4).
 *
 * No LLM, no I/O, no config reads - the finalizer wires these up. Two consumers
 * share `resolveDuplicates`: the deterministic hook pass below, and the
 * finalizer's `duplicate_of` output. Cycles, chains and the drop cap are
 * therefore handled in exactly one place, and an LLM outage degrades to the
 * lexical pass alone rather than losing the guarantees.
 */

export interface DuplicateClaim {
  id: string;
  duplicateOf: string;
}

export interface HookClip {
  id: string;
  score: number;
  hook: string;
}

/**
 * Distinct tokens a normalized opening must have before the lexical pass will
 * call two clips duplicates.
 *
 * Two clips that both open on "Слушай" or "Ну вот" are not duplicates - they
 * share a filler, not a claim. The real defect (a montage quoting a later
 * moment) reproduces a whole spoken line, so requiring three distinct tokens
 * costs nothing there while removing the entire class of one- and two-word
 * false positives. Paraphrase and short-opening cases are the semantic
 * finalizer's job; it sees the full speech, this pass sees one line.
 */
export const MIN_HOOK_TOKENS = 3;

/** Lowercase, drop everything that is not a letter or digit, collapse space. */
export function normalizeHook(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function hookTokens(text: string): Set<string> {
  return new Set(normalizeHook(text).split(" ").filter(Boolean));
}

/**
 * Token Jaccard over normalized opening lines: |A ∩ B| / |A ∪ B|, 0 if either
 * side is empty.
 *
 * Jaccard is symmetric on purpose. A containment/overlap coefficient would
 * catch more one-node-offset openings, but it fires on any short generic
 * opening that happens to be a subset of a longer one ("а вот это интересно"),
 * and this pass drops clips with no LLM in the loop - it must be the
 * conservative half of the pair.
 */
export function hookSimilarity(a: string, b: string): number {
  const setA = hookTokens(a);
  const setB = hookTokens(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

function byScoreDesc(
  a: { id: string; score: number },
  b: { id: string; score: number }
): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Deterministic pass: identical or near-identical opening lines. The teaser
 * montage quotes the real moment verbatim, so this fires without an LLM.
 *
 * Every clip in a similar-opening group is claimed against the single strongest
 * member, so the higher-scored clip always survives and the claim graph the
 * caller gets is a star, never a chain.
 *
 * On offsets: Jaccard is length-sensitive, so a clip that starts one node
 * earlier on a SHORT lead-in ("Знаешь, ...") still clears 0.8 and is caught,
 * while one that carries a whole extra sentence does not. That is the intended
 * line - an extra sentence is a materially different first three seconds for
 * the viewer, and calling it a duplicate on lexical evidence alone would drop a
 * genuine clip. The semantic finalizer, which sees full speech, covers the rest.
 */
export function findHookDuplicates(clips: HookClip[], threshold: number): DuplicateClaim[] {
  const byScore = [...clips].sort(byScoreDesc);
  const claims: DuplicateClaim[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < byScore.length; i++) {
    const anchor = byScore[i];
    if (taken.has(anchor.id)) continue;
    if (hookTokens(anchor.hook).size < MIN_HOOK_TOKENS) continue;
    for (let j = i + 1; j < byScore.length; j++) {
      const other = byScore[j];
      if (taken.has(other.id)) continue;
      if (hookTokens(other.hook).size < MIN_HOOK_TOKENS) continue;
      if (hookSimilarity(anchor.hook, other.hook) >= threshold) {
        claims.push({ id: other.id, duplicateOf: anchor.id });
        taken.add(other.id);
      }
    }
  }
  return claims;
}

/**
 * Total clips a duplicate resolution may drop: `floor(n / 2)`.
 *
 * A truthful duplicate pass on n clips pairs them up, so n/2 drops is already
 * the honest ceiling for anything but a set where every clip says the same
 * thing - and a set like that is a scanning failure, not something to fix by
 * shipping one clip. Half the batch always survives, so no confused judge and
 * no runaway similarity threshold can empty the set.
 */
export function duplicateDropCap(clipCount: number): number {
  return Math.max(0, Math.floor(clipCount / 2));
}

export interface DuplicateResolution {
  /** Ids to drop, weakest first (the order the cap was applied in). */
  drops: string[];
  /** Drops the cap withheld - telemetry, spec §7. */
  dropCapHits: number;
}

/**
 * Turns duplicate claims into a drop list.
 *
 * Claims are treated as UNDIRECTED evidence that two clips are the same moment:
 * direction is the judge's advice, score is the authority. Each connected group
 * of claims keeps exactly one survivor - its highest-scored member, ties broken
 * by id - and drops the rest. That is what makes chains collapse to one clip
 * and makes cycles safe: "survivor" is chosen per group, not per claim, so
 * A→B→A drops exactly one clip even when the two scores are equal, and no group
 * can ever be wiped out.
 *
 * Self-references and claims naming an unknown id carry no information and are
 * discarded. At most `maxDrops` clips are dropped, weakest first.
 */
export function resolveDuplicatesDetailed(
  claims: DuplicateClaim[],
  scores: Record<string, number>,
  maxDrops: number
): DuplicateResolution {
  const valid = claims.filter(
    (c) =>
      c.id !== c.duplicateOf &&
      scores[c.id] !== undefined &&
      scores[c.duplicateOf] !== undefined
  );

  // Union-find over the claim graph: one survivor per connected group.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor) ?? cursor;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  for (const claim of valid) {
    if (!parent.has(claim.id)) parent.set(claim.id, claim.id);
    if (!parent.has(claim.duplicateOf)) parent.set(claim.duplicateOf, claim.duplicateOf);
    union(claim.id, claim.duplicateOf);
  }

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const members = groups.get(root);
    if (members) members.push(id);
    else groups.set(root, [id]);
  }

  const candidates: string[] = [];
  for (const members of groups.values()) {
    const ranked = members
      .map((id) => ({ id, score: scores[id] }))
      .sort(byScoreDesc);
    // ranked[0] survives; every other member of the group is droppable.
    for (const member of ranked.slice(1)) candidates.push(member.id);
  }

  const ordered = candidates.sort(
    (a, b) => scores[a] - scores[b] || (a < b ? -1 : a > b ? 1 : 0)
  );
  const cap = Math.max(0, maxDrops);
  return { drops: ordered.slice(0, cap), dropCapHits: Math.max(0, ordered.length - cap) };
}

/** Drop list only - see {@link resolveDuplicatesDetailed}. */
export function resolveDuplicates(
  claims: DuplicateClaim[],
  scores: Record<string, number>,
  maxDrops: number
): string[] {
  return resolveDuplicatesDetailed(claims, scores, maxDrops).drops;
}
