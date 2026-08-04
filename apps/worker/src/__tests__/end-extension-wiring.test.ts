import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { ExtensionTelemetry } from "../analyze-v2/end-extension";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, and why it is not end-extension.test.ts
//
// The stage itself is covered next door: gates, windows, telemetry, every
// failure mode. All of it ran against a caller that did not exist - the stage
// was dead code, and every one of those tests passed just as happily while
// nothing in the engine called it.
//
// So this file only ever asserts things that are FALSE about a disconnected
// stage: that a proposal the gates accept comes back out of analyzeHighlightsV2
// as a longer shipped clip, that the finalizer is handed the extended clips and
// not the ones selection chose, that the stage sits between those two, that the
// whole telemetry object reaches the job record, and that none of it can turn a
// content answer into a failed job.
//
// The single most valuable assertion here is the end SECONDS and the end NODE of
// a shipped highlight (`applies a proposal ...`). A wiring that computes an
// extension and then quietly drops it - the likeliest way to get this commit
// wrong - passes every other test in the repo, including all of the stage's own.
//
// The stub routes on the SCHEMA NAME rather than call order or prompt text: the
// scanner runs its windows concurrently, and a prompt edit must not silently
// re-route a response to the wrong stage.
// ---------------------------------------------------------------------------

const darkCfg = loadAnalyzeConfig({});
const liveCfg = loadAnalyzeConfig({ END_EXTENSION: "on" });

/** 40 sentences x 5s with word timings - one scan window at default settings.
 *  Node i runs [5i, 5i+4.5], so consecutive nodes leave a 0.5s hole: well under
 *  sceneGapSec, i.e. this source has no scene cuts and the rail is inert. */
function transcript(): TranscriptionResult {
  const segments: WhisperSegment[] = Array.from({ length: 40 }, (_, i) => {
    const base = i * 5;
    return {
      start: base,
      end: base + 4.5,
      text: `Это предложение номер ${i}.`,
      words: [
        { text: "Это", start: base, end: base + 1 },
        { text: "предложение", start: base + 1.1, end: base + 2.5 },
        { text: "номер", start: base + 2.6, end: base + 3.4 },
        { text: `${i}.`, start: base + 3.5, end: base + 4.5 },
      ],
    };
  });
  return { text: segments.map((s) => s.text).join(" "), segments, language: "ru" };
}

// The four candidates, in start order - which is the order ids are assigned in.
// c0..c2 ship; c3 exists to be dropped BY SELECTION (score below threshold while
// a strong tier exists) and nowhere earlier, which is what makes "the stage runs
// after selection" a testable claim rather than a comment.
const scanResponse = {
  candidates: [
    { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
    { start_node: 20, end_node: 24, payoff_node: 23, interest: 0.8, type: "story", thread: null },
    { start_node: 30, end_node: 34, payoff_node: 33, interest: 0.8, type: "story", thread: null },
    { start_node: 36, end_node: 38, payoff_node: 37, interest: 0.7, type: "story", thread: null },
  ],
};

const verdict = (
  id: string,
  startNode: number,
  endNode: number,
  payoffNode: number,
  score: number,
  title: string
) => ({
  id,
  keep: true,
  score,
  grounded: true,
  self_contained: true,
  start_node: startNode,
  payoff_node: payoffNode,
  end_node: endNode,
  hook_start_node: startNode + 1,
  hook_end_node: payoffNode,
  title,
  description: `Спикер называет номер предложения ${payoffNode}.`,
  title_evidence_nodes: [payoffNode],
  description_evidence_nodes: [payoffNode],
  language: "ru",
});

const criticResponse = {
  results: [
    verdict("c0", 10, 14, 13, 0.85, "Он назвал номер тринадцать"),
    verdict("c1", 20, 24, 23, 0.82, "Спикер продолжает счёт"),
    verdict("c2", 30, 34, 33, 0.8, "Счёт доходит до конца"),
    verdict("c3", 36, 38, 37, 0.45, "Короткая вставка про номер"),
  ],
};

const shipRow = (id: string) => ({
  id,
  verdict: "ship",
  drop_reason: null,
  duplicate_of: null,
  shared_claim: null,
  title: null,
  title_evidence_nodes: null,
  trim_start_node: null,
});

const finalizerResponse = { clips: [shipRow("c0"), shipRow("c1"), shipRow("c2")] };

const extensionRow = (id: string, endNode: number, extend = true) => ({
  id,
  reason: "the next beat lands here",
  extend,
  end_node: endNode,
});

// Where the shipped clips sit, in the seconds the engine derives from the graph.
// Named because half the assertions below are "this did not move" and reading a
// bare 69.8 twice tells you nothing about which of the two it is.
//
// Every clip ends on its PAYOFF node rather than the critic's proposed end node:
// each of these candidates asks for one sentence past the payoff, and that is
// 5s of tail against payoffMaxTailSec of 4, so snap pulls the end back. Which is
// this stage's whole subject - the engine ends clips the moment the payoff lands
// (0.3s of tail, i.e. exactly tailHoldSec) and this is that fixture in miniature.
const C0_START = 49.85; // node 10 start, minus leadInSec
const C0_END = 69.8; // node 13 (the payoff) end + tailHoldSec, under node 14's onset
const C0_END_EXTENDED = 89.8; // node 17 end + tailHoldSec
const C1_END = 119.8; // node 23
const C2_END = 169.8; // node 33
/** c0's window: 25s past node 13's end reaches node 18, so 14..18 are offered. */
const C0_LAST_OFFERED = 18;

const THROW = Symbol("stub throws");

interface Recorded {
  schema: string;
  model: string;
  system: string;
  user: string;
}

type Reply = Record<string, unknown> | typeof THROW;

/**
 * Minimal OpenAI stand-in that answers per STAGE, keyed by the response schema
 * callJsonSchema sends. Records every request so the tests can assert what each
 * stage was shown and in which order.
 *
 * Token usage differs per stage on purpose: it is the only way to tell whether
 * the extension call was billed to the job's usage object or to one the caller
 * threw away.
 */
function stubClient(replies: Record<string, Reply>) {
  const requests: Recorded[] = [];
  const create = vi.fn(async (body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format: { json_schema: { name: string } };
  }) => {
    const schema = body.response_format.json_schema.name;
    requests.push({
      schema,
      model: body.model,
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    });
    const reply = replies[schema];
    if (reply === undefined) throw new Error(`stub has no reply for schema "${schema}"`);
    if (reply === THROW) throw new Error("stub outage");
    const completionTokens = { scan_candidates: 30, critic_verdicts: 80, end_extension: 42, clip_finalizer: 90 }[
      schema
    ] ?? 0;
    return {
      choices: [
        { message: { content: JSON.stringify(reply), refusal: null }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: completionTokens },
    };
  });
  return {
    requests,
    client: { chat: { completions: { create } } } as never,
  };
}

const baseReplies = (extension: Reply): Record<string, Reply> => ({
  scan_candidates: scanResponse,
  critic_verdicts: criticResponse,
  end_extension: extension,
  clip_finalizer: finalizerResponse,
});

const schemasOf = (requests: Recorded[]) => requests.map((r) => r.schema);
const userFor = (requests: Recorded[], schema: string) =>
  requests.find((r) => r.schema === schema)?.user ?? "";
const telemetryOf = (telemetry: Record<string, unknown>) =>
  telemetry.endExtension as ExtensionTelemetry;

describe("end-extension wiring", () => {
  it("makes no call and answers exactly as before while the stage is dark", async () => {
    // The default. Every eval fixture in the repo was recorded like this, and
    // this commit is the first time the default-off path is a live code path
    // rather than an absent one - a stage that leaks a request here would move
    // ends on every production job before the measurement that authorises it.
    const { client, requests } = stubClient(baseReplies({ results: [] }));
    const r = await analyzeHighlightsV2(transcript(), {
      client,
      cfg: darkCfg,
      transcriptPartial: false,
    });

    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "clip_finalizer",
    ]);
    expect(r.highlights).toHaveLength(3);
    expect(r.highlights[0].end).toBeCloseTo(C0_END, 6);
    expect(r.highlights[0]._endNode).toBe(13);
    expect(r.highlights[1].end).toBeCloseTo(C1_END, 6);
    expect(r.highlights[2].end).toBeCloseTo(C2_END, 6);
    // Nothing billed for a stage that did not run.
    expect(r.usage.requests).toBe(3);
    expect(r.usage.outputTokens).toBe(200);
  });

  it("still publishes the whole telemetry object while dark, saying it was skipped", async () => {
    // Zeros alone cannot say whether the stage ran. `skipped: "disabled"` is the
    // only thing separating "never asked" from "asked and every clip declined",
    // and those two ask for opposite follow-ups.
    const { client } = stubClient(baseReplies({ results: [] }));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: darkCfg });

    expect(telemetryOf(r.telemetry)).toEqual({
      offered: 0,
      proposed: 0,
      applied: 0,
      refused: 0,
      refusedBy: {},
      contradicted: 0,
      secondsGained: 0,
      fallbackModelUsed: false,
      skipped: "disabled",
    });
  });

  it("applies a proposal the gates accept to the clip that actually ships", async () => {
    // THE POINT OF THE TASK. Both halves of the end are asserted - the seconds a
    // viewer gets and the node the diagnostics report - because a wiring that
    // updated one and not the other would be a clip whose telemetry describes a
    // range it does not have (job cms2c8ahm, the wrong-nodes investigation).
    const { client, requests } = stubClient(
      baseReplies({ results: [extensionRow("c0", 17)] })
    );
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(requests.filter((q) => q.schema === "end_extension")).toHaveLength(1);
    expect(r.highlights).toHaveLength(3);
    expect(r.highlights[0].end).toBeCloseTo(C0_END_EXTENDED, 6);
    expect(r.highlights[0]._endNode).toBe(17);
    expect(r.highlights[0].start).toBeCloseTo(C0_START, 6);
    // The clips nobody proposed anything for are untouched, so an "extension"
    // that just moved every end would not pass here.
    expect(r.highlights[1].end).toBeCloseTo(C1_END, 6);
    expect(r.highlights[2].end).toBeCloseTo(C2_END, 6);

    const telemetry = telemetryOf(r.telemetry);
    expect(telemetry.applied).toBe(1);
    expect(telemetry.secondsGained).toBeCloseTo(C0_END_EXTENDED - C0_END, 6);
    // The stage's call is billed to the job, not to a usage object the caller
    // dropped on the floor - the free-tier settlement charges these tokens.
    expect(r.usage.requests).toBe(4);
    expect(r.usage.outputTokens).toBe(242);
  });

  it("hands the finalizer the extended clips, not the ones selection chose", async () => {
    // The finalizer's prompt prints each clip's DURATION, so its own request is
    // the evidence of which set it judged: 25s is the clip selection picked, 40s
    // is the clip the extension made. A finalizer still reading selection.selected
    // would trim, dedup and veto a set that is not the one being shipped.
    const { client, requests } = stubClient(
      baseReplies({ results: [extensionRow("c0", 17)] })
    );
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).toContain("CLIP c0 | score 0.85 | 40s");
    expect(finalizerUser).not.toContain("CLIP c0 | score 0.85 | 20s");
    // And the counter published beside it counts THAT set. `selectedForFinalizer`
    // is read as "what the finalizer was given"; the only reading that stays true
    // if this stage ever returns a different number of clips is the argument it
    // was actually handed, so the prompt is the oracle.
    expect((finalizerUser.match(/^CLIP c\d+ \| score/gm) ?? []).length).toBe(
      r.telemetry.selectedForFinalizer
    );
  });

  it("runs after selection - a clip selection dropped is never offered an extension", async () => {
    // c3 clears every gate and dies at selection (0.45, under the threshold while
    // a strong tier exists). Offering it an extension would spend output budget
    // on a clip nobody will see, and would price the whole stage against the
    // wrong denominator in the measurement.
    const { client, requests } = stubClient(
      baseReplies({ results: [extensionRow("c0", 17)] })
    );
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    const extensionUser = userFor(requests, "end_extension");
    expect(extensionUser).toContain("CLIP c0");
    expect(extensionUser).toContain("CLIP c1");
    expect(extensionUser).toContain("CLIP c2");
    expect(extensionUser).not.toContain("CLIP c3");
    expect(telemetryOf(r.telemetry).offered).toBe(3);
    // and it is offered the window the config allows, not the rest of the graph
    expect(extensionUser).toContain(`#${C0_LAST_OFFERED} `);
    expect(extensionUser).not.toContain(`#${C0_LAST_OFFERED + 1} `);
  });

  it("runs before the finalizer, after the critic", async () => {
    // Order, not just presence. Widening after the finalizer would put a boundary
    // beyond the stage that owns trimming, and widening before the critic would
    // extend clips that are not judged yet.
    const { client, requests } = stubClient(
      baseReplies({ results: [extensionRow("c0", 17)] })
    );
    await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "end_extension",
      "clip_finalizer",
    ]);
  });

  it("publishes every field the measurement reads, refusals and contradictions included", async () => {
    // One run that exercises all three outcomes at once: c0 accepted, c1 naming a
    // node past its window, c2 answered twice. A telemetry object assembled by
    // hand from a few counters would lose exactly the two fields that make the
    // zeros readable, which is why this is an exact match on the whole object.
    const { client } = stubClient(
      baseReplies({
        results: [
          extensionRow("c0", 17),
          extensionRow("c1", 35),
          extensionRow("c2", 36),
          extensionRow("c2", 37),
        ],
      })
    );
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(telemetryOf(r.telemetry)).toEqual({
      offered: 3,
      proposed: 2,
      applied: 1,
      refused: 1,
      refusedBy: { outside_window: 1 },
      contradicted: 1,
      secondsGained: expect.closeTo(C0_END_EXTENDED - C0_END, 6),
      fallbackModelUsed: false,
    });
    // toEqual treats an explicit undefined as absent, and "the stage ran" is the
    // one thing this object has to be able to say.
    expect("skipped" in telemetryOf(r.telemetry)).toBe(false);
    expect(r.highlights[0]._endNode).toBe(17);
    expect(r.highlights[1]._endNode).toBe(23);
    expect(r.highlights[2]._endNode).toBe(33);
  });

  it("ships the whole set unchanged when the stage's call dies, and says so", async () => {
    // Billing invariant (engine-notes §6): these clips already passed every gate.
    // An outage in a stage that only ever improves them must cost the improvement
    // and nothing else - not the clips, not the job.
    const { client, requests } = stubClient(baseReplies(THROW));
    const started = Date.now();
    const r = await analyzeHighlightsV2(transcript(), {
      client,
      cfg: liveCfg,
      retryDelayMs: 1,
    });
    const elapsed = Date.now() - started;

    expect(r.noClipsReason).toBeUndefined();
    expect(r.highlights).toHaveLength(3);
    expect(r.highlights[0].end).toBeCloseTo(C0_END, 6);
    expect(r.highlights[0]._endNode).toBe(13);
    const telemetry = telemetryOf(r.telemetry);
    expect(telemetry.skipped).toBe("error");
    expect(telemetry.fallbackModelUsed).toBe(true);
    expect(telemetry.offered).toBe(3);
    expect(telemetry.applied).toBe(0);
    // The finalizer still ran on the unchanged set: one dead stage is not a dead
    // pipeline.
    expect(schemasOf(requests)).toContain("clip_finalizer");
    // retryDelayMs has to reach the stage. Unforwarded, llm.ts falls back to its
    // real backoff: DEFAULT_RETRY_BASE_MS doubling over MAX_ATTEMPTS is 2s + 4s
    // per model, primary then fallback, so about 12s of sleeping (less up to 25%
    // of jitter) while a user waits. Visible only as a slow test, which is
    // exactly how it would ship.
    expect(elapsed).toBeLessThan(2000);
  });
});
