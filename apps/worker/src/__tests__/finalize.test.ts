import { describe, expect, it, vi } from "vitest";
import {
  applyFinalizerEntries,
  finalizeClips,
  finalizerMaxOutputTokens,
} from "../analyze-v2/finalize";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import type {
  FinalizerEntry,
  SentenceNode,
  SnappedClip,
} from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

/** 20 nodes, 3s apart, every one a clean start and a clean end. */
function nodes(count = 20, stepSec = 3, spanSec = 2.8): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * stepSec,
    end: i * stepSec + spanSec,
    text: `Предложение номер ${i}.`,
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
  }));
}

/** 100 nodes, 1s apart - lets a clip span many nodes inside the 90s cap. */
function denseNodes(count = 100): SentenceNode[] {
  return nodes(count, 1, 0.8);
}

function clip(
  id: string,
  score: number,
  startNode = 0,
  endNode = 6,
  graph: SentenceNode[] = nodes()
): SnappedClip {
  const s = graph[startNode];
  const e = graph[endNode];
  const prev = startNode > 0 ? graph[startNode - 1] : null;
  const next = endNode + 1 < graph.length ? graph[endNode + 1] : null;
  const startSec = Math.max(Math.min(prev ? prev.end : 0, s.start), s.start - cfg.leadInSec);
  const endSec = Math.max(Math.min(e.end + cfg.tailHoldSec, next ? next.start : Infinity), e.end);
  return {
    verdict: {
      id,
      keep: true,
      score,
      grounded: true,
      selfContained: true,
      startNode,
      payoffNode: endNode,
      endNode,
      hookStartNode: startNode,
      hookEndNode: startNode + 1,
      title: `Заголовок ${id}`,
      description: "Описание",
      titleEvidenceNodes: [startNode + 1],
      descriptionEvidenceNodes: [startNode + 1],
      language: "ru",
    },
    startSec,
    endSec,
    hookStartSec: s.start,
    hookEndSec: graph[startNode + 1].end,
    payoffSec: e.end,
    shortMoment: false,
  };
}

const entry = (p: Partial<FinalizerEntry> & { id: string }): FinalizerEntry => ({
  verdict: "ship",
  dropReason: null,
  duplicateOf: null,
  sharedClaim: null,
  title: null,
  titleEvidenceNodes: null,
  trimStartNode: null,
  ...p,
});

const ids = (clips: SnappedClip[]) => clips.map((c) => c.verdict.id);

describe("applyFinalizerEntries - drops", () => {
  it("ships everything when the finalizer approves", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(clips, [entry({ id: "a" }), entry({ id: "b" })], nodes(), cfg);
    expect(ids(r.clips)).toEqual(["a", "b"]);
    expect(r.telemetry.finalizerDrops).toEqual([]);
    expect(r.telemetry.semanticDedupDrops).toEqual([]);
    expect(r.telemetry.dropCapHits).toBe(0);
  });

  it("drops a clip with its reason recorded", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14), clip("c", 0.7, 16, 19)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a" }),
        entry({ id: "b", verdict: "drop", dropReason: "no_payoff" }),
        entry({ id: "c" }),
      ],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a", "c"]);
    expect(r.telemetry.finalizerDrops).toEqual([{ id: "b", reason: "no_payoff" }]);
  });

  it("keeps the stronger clip of a duplicate pair and records the shared claim", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a" }),
        entry({
          id: "b",
          verdict: "drop",
          dropReason: "duplicate",
          duplicateOf: "a",
          sharedClaim: "одно и то же",
        }),
      ],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a"]);
    expect(r.telemetry.semanticDedupDrops).toEqual([
      { id: "b", duplicateOf: "a", sharedClaim: "одно и то же" },
    ]);
    expect(r.telemetry.finalizerDrops).toEqual([]);
  });

  it("drops the weaker clip even when the judge points the claim the wrong way", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a", verdict: "drop", dropReason: "duplicate", duplicateOf: "b" }),
        entry({ id: "b" }),
      ],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a"]);
  });

  it("never empties the set: the drop cap holds", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a", verdict: "drop", dropReason: "incoherent" }),
        entry({ id: "b", verdict: "drop", dropReason: "incoherent" }),
      ],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a"]);
    expect(r.telemetry.dropCapHits).toBe(1);
  });

  it("spends the drop budget on duplicates before content drops", () => {
    // 4 clips -> cap 2. One duplicate claim plus two plain drops: the duplicate
    // is the cheapest possible loss (its claim still ships in the survivor), so
    // it must be taken first and only one plain drop may follow.
    const graph = nodes();
    const clips = [
      clip("a", 0.9, 0, 3, graph),
      clip("b", 0.8, 5, 8, graph),
      clip("c", 0.7, 10, 13, graph),
      clip("d", 0.6, 15, 18, graph),
    ];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a" }),
        entry({ id: "b", verdict: "drop", dropReason: "duplicate", duplicateOf: "a" }),
        entry({ id: "c", verdict: "drop", dropReason: "incoherent" }),
        entry({ id: "d", verdict: "drop", dropReason: "incoherent" }),
      ],
      graph,
      cfg
    );
    expect(ids(r.clips)).toEqual(["a", "c"]);
    expect(r.telemetry.semanticDedupDrops.map((d) => d.id)).toEqual(["b"]);
    expect(r.telemetry.finalizerDrops).toEqual([{ id: "d", reason: "incoherent" }]);
    expect(r.telemetry.dropCapHits).toBe(1);
  });

  it("protects the survivor of a duplicate group from a contradictory content drop", () => {
    // The judge says "b duplicates a" AND "a is incoherent". Honouring both
    // deletes the claim outright while telemetry calls it a duplicate.
    const graph = nodes();
    const clips = [
      clip("a", 0.9, 0, 3, graph),
      clip("b", 0.8, 5, 8, graph),
      clip("c", 0.7, 10, 13, graph),
      clip("d", 0.6, 15, 18, graph),
    ];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a", verdict: "drop", dropReason: "incoherent" }),
        entry({ id: "b", verdict: "drop", dropReason: "duplicate", duplicateOf: "a" }),
        entry({ id: "c" }),
        entry({ id: "d" }),
      ],
      graph,
      cfg
    );
    expect(ids(r.clips)).toEqual(["a", "c", "d"]);
    expect(r.telemetry.dropsProtected).toEqual(["a"]);
  });

  it("treats a duplicate_of naming an unknown clip as a plain drop", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a" }),
        entry({ id: "b", verdict: "drop", dropReason: "duplicate", duplicateOf: "ghost" }),
      ],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a"]);
    expect(r.telemetry.finalizerDrops).toEqual([{ id: "b", reason: "duplicate" }]);
  });

  it("defaults a drop with no reason to incoherent", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [entry({ id: "a" }), entry({ id: "b", verdict: "drop" })],
      nodes(),
      cfg
    );
    expect(r.telemetry.finalizerDrops).toEqual([{ id: "b", reason: "incoherent" }]);
  });

  it("ignores entries for unknown ids and ships clips with no entry", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [entry({ id: "zz", verdict: "drop", dropReason: "incoherent" })],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a", "b"]);
    expect(r.telemetry.finalizerDrops).toEqual([]);
  });

  it("honours the first entry when the judge returns an id twice", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "b" }),
        entry({ id: "b", verdict: "drop", dropReason: "incoherent" }),
        entry({ id: "a" }),
      ],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a", "b"]);
  });

  it("preserves the input order of the survivors", () => {
    const graph = nodes();
    const clips = [
      clip("a", 0.9, 0, 3, graph),
      clip("b", 0.5, 5, 8, graph),
      clip("c", 0.7, 10, 13, graph),
      clip("d", 0.6, 15, 18, graph),
    ];
    const r = applyFinalizerEntries(
      clips,
      [entry({ id: "b", verdict: "drop", dropReason: "redundant" })],
      graph,
      cfg
    );
    expect(ids(r.clips)).toEqual(["a", "c", "d"]);
  });
});

describe("applyFinalizerEntries - trims", () => {
  it("applies a valid start trim and re-snaps the boundaries", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", trimStartNode: 2 })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(2);
    expect(r.clips[0].startSec).toBeGreaterThan(0);
    expect(r.clips[0].endSec).toBe(clip("a", 0.9).endSec);
    expect(r.telemetry.openingTrims).toEqual([{ id: "a", fromNode: 0, toNode: 2 }]);
  });

  it("rejects a trim at or past the payoff", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", trimStartNode: 6 })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.telemetry.trimRejected).toEqual([
      { id: "a", node: 6, reason: "at_or_past_payoff" },
    ]);
  });

  it("rejects a trim that does not move the start forward", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", trimStartNode: 0 })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.telemetry.trimRejected[0].reason).toBe("not_forward");
  });

  it("rejects a trim that would make the clip too short", () => {
    const graph = denseNodes();
    const r = applyFinalizerEntries(
      [clip("a", 0.9, 0, 6, graph)],
      [entry({ id: "a", trimStartNode: 2 })],
      graph,
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.telemetry.trimRejected).toEqual([
      { id: "a", node: 2, reason: "snap_rejected" },
    ]);
  });

  it("rejects a trim onto a node that is not a legal clip start", () => {
    const graph = nodes();
    // mid-sentence continuation: weak leading boundary + lowercase onset
    graph[2] = { ...graph[2], leadingStrength: 0.5, text: "и потом ещё вот это." };
    const r = applyFinalizerEntries(
      [clip("a", 0.9, 0, 6, graph)],
      [entry({ id: "a", trimStartNode: 2 })],
      graph,
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.telemetry.trimRejected[0].reason).toBe("not_clean_start");
  });

  it("rejects a trim index that is not an integer node of this clip", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", trimStartNode: 2.5 })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.telemetry.trimRejected[0].reason).toBe("not_an_index");
  });

  it("rejects a trim that would create a new NMS collision with another clip", () => {
    // a = [0, 41], b = [35.85, 81]. Their 5.15s overlap is 13% of the shorter
    // clip, so selection's NMS passed them. Trimming a's start to node 30 leaves
    // an 11.15s clip whose SAME 5.15s tail overlap is now 46% of it - a pair
    // selection would have rejected, created after selection ran.
    const graph = denseNodes();
    const a = clip("a", 0.9, 0, 40, graph);
    const b = clip("b", 0.8, 36, 80, graph);
    const untouched = applyFinalizerEntries([a, b], [], graph, cfg);
    expect(ids(untouched.clips)).toEqual(["a", "b"]);

    const r = applyFinalizerEntries(
      [a, b],
      [entry({ id: "a", trimStartNode: 30 })],
      graph,
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.clips[0].startSec).toBe(a.startSec);
    expect(r.telemetry.trimRejected).toEqual([
      { id: "a", node: 30, reason: "nms_collision" },
    ]);
    expect(r.telemetry.openingTrims).toEqual([]);
  });

  it("still applies a trim that leaves the set collision-free", () => {
    const graph = denseNodes();
    const a = clip("a", 0.9, 0, 40, graph);
    const b = clip("b", 0.8, 60, 90, graph);
    const r = applyFinalizerEntries(
      [a, b],
      [entry({ id: "a", trimStartNode: 30 })],
      graph,
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(30);
    expect(r.telemetry.openingTrims).toHaveLength(1);
  });
});

describe("applyFinalizerEntries - title rewrites", () => {
  it("applies a grounded title rewrite", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "Честный заголовок", titleEvidenceNodes: [3] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Честный заголовок");
    expect(r.clips[0].verdict.titleEvidenceNodes).toEqual([3]);
    expect(r.telemetry.titleRewrites).toEqual([
      { id: "a", from: "Заголовок a", to: "Честный заголовок" },
    ]);
  });

  it("rejects a rewrite whose evidence lies outside the clip", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "Заголовок из другого клипа", titleEvidenceNodes: [17] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.rewriteRejected).toEqual([
      { id: "a", reason: "evidence_out_of_range" },
    ]);
  });

  it("rejects a rewrite whose evidence falls outside only AFTER a trim", () => {
    // The ordering that matters: node 1 is inside [0..6] but outside [3..6].
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", trimStartNode: 3, title: "Новый", titleEvidenceNodes: [1] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(3);
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.openingTrims).toHaveLength(1);
    expect(r.telemetry.rewriteRejected).toEqual([
      { id: "a", reason: "evidence_out_of_range" },
    ]);
  });

  it("judges the rewrite against the range a trim reverted for NMS restores", () => {
    // The trim is proposed and then withdrawn by the collision gate, so the
    // clip's FINAL range is the original one and evidence inside it is valid.
    const graph = denseNodes();
    const a = clip("a", 0.9, 0, 40, graph);
    const b = clip("b", 0.8, 36, 80, graph);
    const r = applyFinalizerEntries(
      [a, b],
      [
        entry({
          id: "a",
          trimStartNode: 30,
          title: "Опирается на начало",
          titleEvidenceNodes: [5],
        }),
      ],
      graph,
      cfg
    );
    expect(r.telemetry.trimRejected[0].reason).toBe("nms_collision");
    expect(r.clips[0].verdict.title).toBe("Опирается на начало");
    expect(r.telemetry.rewriteRejected).toEqual([]);
  });

  it("rejects an over-length title", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "х".repeat(90), titleEvidenceNodes: [3] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.rewriteRejected).toEqual([{ id: "a", reason: "too_long" }]);
  });

  it("rejects a blank title", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "   ", titleEvidenceNodes: [3] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.rewriteRejected).toEqual([{ id: "a", reason: "blank" }]);
  });

  it("rejects a rewrite with no evidence at all", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "Без опоры" })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.rewriteRejected).toEqual([{ id: "a", reason: "no_evidence" }]);
  });

  it("rejects a rewrite written in the wrong script", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "An English title for a Russian clip", titleEvidenceNodes: [3] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.rewriteRejected).toEqual([{ id: "a", reason: "script_mismatch" }]);
  });
});

describe("applyFinalizerEntries - drop plus repair on one entry", () => {
  it("ignores the repairs of a clip it actually drops", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a" }),
        entry({
          id: "b",
          verdict: "drop",
          dropReason: "broken_opening",
          trimStartNode: 10,
          title: "Не пригодится",
          titleEvidenceNodes: [10],
        }),
      ],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a"]);
    expect(r.telemetry.openingTrims).toEqual([]);
    expect(r.telemetry.titleRewrites).toEqual([]);
  });

  it("ships a clip whose drop the cap refused UNCHANGED, repairs and all", () => {
    // The judge said this clip should not ship; its trim was never offered as
    // "this makes it good". A capped drop is a no-op, never a half-application.
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({
          id: "a",
          verdict: "drop",
          dropReason: "incoherent",
          trimStartNode: 2,
          title: "Починенный",
          titleEvidenceNodes: [3],
        }),
        entry({ id: "b", verdict: "drop", dropReason: "incoherent" }),
      ],
      nodes(),
      cfg
    );
    expect(ids(r.clips)).toEqual(["a"]);
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.openingTrims).toEqual([]);
    expect(r.telemetry.titleRewrites).toEqual([]);
    expect(r.telemetry.dropCapHits).toBe(1);
  });
});

describe("applyFinalizerEntries - purity", () => {
  it("never mutates the clips or the entries it was given", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const entries = [
      entry({ id: "a", trimStartNode: 2, title: "Новый", titleEvidenceNodes: [3] }),
      entry({ id: "b", verdict: "drop", dropReason: "duplicate", duplicateOf: "a" }),
    ];
    const graph = nodes();
    const before = JSON.stringify({ clips, entries, graph });
    applyFinalizerEntries(clips, entries, graph, cfg);
    expect(JSON.stringify({ clips, entries, graph })).toBe(before);
  });
});

describe("finalizerMaxOutputTokens", () => {
  // Deliberately NOT criticMaxOutputTokens: that curve was measured at batch
  // sizes 1/3/6 in a stage that recovers from truncation by splitting. This call
  // is one shot over the whole set and cannot split.
  it("clears the estimated demand for a full finalizer set", () => {
    // ~7k reasoning + ~2.4k JSON for 16 clips (softCap 12 + headroom 4)
    expect(finalizerMaxOutputTokens(16)).toBeGreaterThan(9400);
  });

  it("scales with the number of clips judged", () => {
    const marginal = finalizerMaxOutputTokens(2) - finalizerMaxOutputTokens(1);
    expect(marginal).toBeGreaterThanOrEqual(450 + 150);
    expect(finalizerMaxOutputTokens(0)).toBeGreaterThan(0);
  });
});

// --- finalizeClips ---------------------------------------------------------

const ok = (clips: unknown[]) => ({
  choices: [{ message: { content: JSON.stringify({ clips }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 900, completion_tokens: 400 },
});

const truncated = () => ({
  choices: [{ message: { content: null }, finish_reason: "length" }],
  usage: { prompt_tokens: 900, completion_tokens: 1 },
});

const refusal = () => ({
  choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 900, completion_tokens: 1 },
});

function seqClient(handlers: Array<(body: any) => any>) {
  let n = 0;
  const create = vi.fn(async (body: any) => {
    const h = handlers[Math.min(n, handlers.length - 1)];
    n += 1;
    return h(body);
  });
  return { chat: { completions: { create } } } as any;
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  verdict: "ship",
  drop_reason: null,
  duplicate_of: null,
  shared_claim: null,
  title: null,
  title_evidence_nodes: null,
  trim_start_node: null,
  ...over,
});

const run = (client: any, clips: SnappedClip[], graph = nodes(), config = cfg) =>
  finalizeClips(client, newUsage(), clips, graph, "ru", "Russian", config, {
    retryDelayMs: 1,
  });

describe("finalizeClips", () => {
  it("applies the judge's decisions end to end", async () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const client = seqClient([
      () =>
        ok([
          row("a", { trim_start_node: 2, title: "Новый", title_evidence_nodes: [3] }),
          row("b", {
            verdict: "drop",
            drop_reason: "duplicate",
            duplicate_of: "a",
            shared_claim: "то же самое",
          }),
        ]),
    ]);
    const r = await run(client, clips);
    expect(ids(r.clips)).toEqual(["a"]);
    expect(r.clips[0].verdict.title).toBe("Новый");
    expect(r.clips[0].verdict.startNode).toBe(2);
    expect(r.telemetry.semanticDedupDrops).toHaveLength(1);
    expect(r.telemetry.finalizerSkipped).toBeUndefined();
  });

  it("runs hook dedup BEFORE the call, so it survives an LLM outage", async () => {
    const graph = nodes();
    graph[0] = { ...graph[0], text: "Человек - это зло для планеты Земля." };
    graph[8] = { ...graph[8], text: "Человек, это зло для планеты земля!" };
    const clips = [clip("a", 0.9, 0, 6, graph), clip("b", 0.8, 8, 14, graph)];
    const client = seqClient([
      () => {
        throw new Error("upstream is down");
      },
    ]);
    const r = await run(client, clips, graph);
    expect(ids(r.clips)).toEqual(["a"]);
    expect(r.telemetry.hookDedupDrops).toEqual([{ id: "b", duplicateOf: "a" }]);
    expect(r.telemetry.finalizerSkipped).toBe("error");
  });

  it("skips the call when the finalizer is disabled but still dedups hooks", async () => {
    const graph = nodes();
    graph[0] = { ...graph[0], text: "Человек - это зло для планеты Земля." };
    graph[8] = { ...graph[8], text: "Человек, это зло для планеты земля!" };
    const clips = [clip("a", 0.9, 0, 6, graph), clip("b", 0.8, 8, 14, graph)];
    const client = seqClient([() => ok([])]);
    const r = await run(client, clips, graph, loadAnalyzeConfig({ ANALYZE_FINALIZER: "off" }));
    expect(ids(r.clips)).toEqual(["a"]);
    expect(r.telemetry.hookDedupDrops).toHaveLength(1);
    expect(r.telemetry.finalizerSkipped).toBe("disabled");
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("makes no call and returns the input for an empty set", async () => {
    const client = seqClient([() => ok([])]);
    const r = await run(client, []);
    expect(r.clips).toEqual([]);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("ships the set unchanged when the judge refuses twice", async () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const client = seqClient([refusal, refusal]);
    const r = await run(client, clips);
    expect(ids(r.clips)).toEqual(["a", "b"]);
    expect(r.telemetry.finalizerSkipped).toBe("refusal");
  });

  it("retries a truncated call once with a bigger cap", async () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const caps: number[] = [];
    const client = seqClient([
      (body) => {
        caps.push(body.max_completion_tokens);
        return truncated();
      },
      (body) => {
        caps.push(body.max_completion_tokens);
        return ok([row("a"), row("b", { verdict: "drop", drop_reason: "no_payoff" })]);
      },
    ]);
    const r = await run(client, clips);
    expect(caps[1]).toBeGreaterThan(caps[0]);
    expect(ids(r.clips)).toEqual(["a"]);
  });

  it("ships unchanged when the retry truncates too - one call cannot split", async () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const client = seqClient([truncated, truncated]);
    const r = await run(client, clips);
    expect(ids(r.clips)).toEqual(["a", "b"]);
    expect(r.telemetry.finalizerSkipped).toBe("truncated");
  });

  it("degrades to the fallback model on a hard error", async () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const models: string[] = [];
    const client = seqClient([
      () => {
        throw new Error("503");
      },
      () => {
        throw new Error("503");
      },
      (body) => {
        models.push(body.model);
        return ok([row("a"), row("b", { verdict: "drop", drop_reason: "redundant" })]);
      },
    ]);
    const r = await run(client, clips);
    expect(models).toEqual([cfg.criticModelFallback]);
    expect(ids(r.clips)).toEqual(["a"]);
  });

  it("never throws on malformed rows - it ignores what it cannot read", async () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const client = seqClient([
      () =>
        ok([
          null,
          "nonsense",
          { id: 42 },
          row("a", { verdict: "banana", drop_reason: "made_up" }),
          row("b", { verdict: "drop", drop_reason: "not_a_reason" }),
        ]),
    ]);
    const r = await run(client, clips);
    expect(ids(r.clips)).toEqual(["a", "b"]);
  });

  it("honours a schema-legal drop with a null reason but not an off-enum one", async () => {
    const graph = nodes();
    const clips = [
      clip("a", 0.9, 0, 3, graph),
      clip("b", 0.8, 5, 8, graph),
      clip("c", 0.7, 10, 13, graph),
      clip("d", 0.6, 15, 18, graph),
    ];
    const client = seqClient([
      () =>
        ok([
          row("a"),
          row("b"),
          row("c", { verdict: "drop", drop_reason: null }),
          row("d", { verdict: "drop", drop_reason: "vibes" }),
        ]),
    ]);
    const r = await run(client, clips, graph);
    expect(ids(r.clips)).toEqual(["a", "b", "d"]);
    expect(r.telemetry.finalizerDrops).toEqual([{ id: "c", reason: "incoherent" }]);
  });

  it("never throws when the payload has no clips array at all", async () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const client = seqClient([
      () => ({
        choices: [{ message: { content: '{"nope":1}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ]);
    const r = await run(client, clips);
    expect(ids(r.clips)).toEqual(["a", "b"]);
  });

  it("sends the finalizer model and one call for the whole set", async () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14), clip("c", 0.7, 16, 19)];
    const client = seqClient([() => ok([row("a"), row("b"), row("c")])]);
    await run(client, clips);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    const body = client.chat.completions.create.mock.calls[0][0];
    expect(body.model).toBe(cfg.finalizerModel);
    expect(body.messages[1].content).toContain("CLIP a");
    expect(body.messages[1].content).toContain("CLIP c");
  });
});
