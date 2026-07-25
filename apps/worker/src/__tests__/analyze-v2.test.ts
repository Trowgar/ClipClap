import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { AnalyzeTechnicalError } from "../analyze-v2/critic";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

const cfg = loadAnalyzeConfig({});

/** The 40-node transcript below is one window at default settings; shrinking the
 *  window splits it into 4, so "every window died" and "one window died" are
 *  distinguishable outcomes. */
const multiWindowCfg = loadAnalyzeConfig({ SCAN_WINDOW_SEC: "60", SCAN_OVERLAP_SEC: "10" });

/** 40 sentences x ~5s with word timings - enough for one window. */
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

const scanResponse = () => ({
  choices: [{
    message: {
      content: JSON.stringify({
        candidates: [
          { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
        ],
      }),
    },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 100, completion_tokens: 30 },
});

const criticResponse = (score: number) => ({
  choices: [{
    message: {
      content: JSON.stringify({
        results: [{
          id: "c0", keep: true, score, grounded: true, self_contained: true,
          start_node: 10, payoff_node: 13, end_node: 14,
          hook_start_node: 12, hook_end_node: 13,
          title: "Он назвал номер", description: "Спикер называет номер предложения.",
          title_evidence_nodes: [13], description_evidence_nodes: [13],
          language: "ru",
        }],
      }),
    },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 200, completion_tokens: 80 },
});

function client(...responses: any[]) {
  let n = 0;
  return {
    chat: { completions: { create: vi.fn(async () => responses[Math.min(n++, responses.length - 1)]) } },
  } as any;
}

describe("analyzeHighlightsV2", () => {
  it("produces a scored, described highlight from scan + critic", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.85)),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(1);
    const h = r.highlights[0];
    expect(h.title).toBe("Он назвал номер");
    expect(h.description).toBe("Спикер называет номер предложения.");
    expect(h.score).toBe(0.85);
    expect(h.language).toBe("ru");
    expect(h.start).toBeLessThan(h.hookStart!);
    expect(h.end).toBeGreaterThanOrEqual(h.payoffAt!);
    expect(h._startNode).toBe(10);
    expect(r.noClipsReason).toBeUndefined();
    expect(r.usage.requests).toBeGreaterThanOrEqual(2);
    expect(r.telemetry.tier).toBe("strong");
  });

  it("degenerate input returns NO_USABLE_SPEECH without any LLM call", async () => {
    const c = client();
    const r = await analyzeHighlightsV2(
      { text: "hi", segments: [{ start: 0, end: 1, text: "hi", words: [{ text: "hi", start: 0, end: 0.5 }] }] },
      { client: c, cfg, transcriptPartial: false }
    );
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_USABLE_SPEECH");
    expect(c.chat.completions.create).not.toHaveBeenCalled();
  });

  it("weak video ships top candidates flagged lowQuality", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.45)),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(true);
    expect(r.telemetry.tier).toBe("weak");
  });

  it("a judged rejection on a partial transcript stays a content outcome", async () => {
    // the critic heard every surviving candidate and rejected it. The transcribe
    // stage already ruled that this coverage is good enough to ship clips from
    // (TRANSCRIPT_MIN_COVERAGE), so a negative answer about audio we DID hear is
    // an opinion about the video - PARTIAL_TRANSCRIPT tells the user both halves
    const rejected = JSON.parse(criticResponse(0.9).choices[0].message.content);
    rejected.results[0].keep = false;
    const criticRejects = {
      choices: [{ message: { content: JSON.stringify(rejected) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };

    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticRejects),
      cfg,
      transcriptPartial: true,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("PARTIAL_TRANSCRIPT");
    expect(r.telemetry.criticVerdicts).toBe(1);
  });

  it("a partial transcript whose clips die in OUR filters stays a content outcome", async () => {
    // keep:true but score 0.1 - the critic judged it, selectAndOrder dropped it.
    // Our own quality bar rejecting a judged clip is not a technical failure
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.1)),
      cfg,
      transcriptPartial: true,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("PARTIAL_TRANSCRIPT");
  });

  it("a partial transcript with 0 candidates from healthy windows stays a content outcome", async () => {
    // no transcript hole removed anything - the scanner simply found nothing in
    // the audio we heard, which is the same content answer a complete transcript
    // would give. Only the lost audio itself can turn this technical
    const emptyScan = {
      choices: [{ message: { content: JSON.stringify({ candidates: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(emptyScan),
      cfg,
      transcriptPartial: true,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("PARTIAL_TRANSCRIPT");
  });

  it("a degenerate partial transcript stays a content outcome", async () => {
    // on record as a decision, not an oversight: <5 words in the audio we DID
    // hear is a measurement, and re-running reads the same cached transcript,
    // so FAILED could never heal - it would just burn 3 attempts
    const c = client();
    const r = await analyzeHighlightsV2(
      {
        text: "hi",
        segments: [{ start: 0, end: 1, text: "hi", words: [{ text: "hi", start: 0, end: 0.5 }] }],
        missingRanges: [{ start: 100, end: 1300, reason: "chunk_failed" }],
      },
      { client: c, cfg, transcriptPartial: true }
    );

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_USABLE_SPEECH");
    expect(c.chat.completions.create).not.toHaveBeenCalled();
  });

  it("throws when a transcript hole removes EVERY candidate unheard", async () => {
    const t = transcript();
    t.missingRanges = [{ start: 60, end: 70, reason: "chunk_failed" }]; // nodes 12-13 territory
    // the scanned candidate spans nodes 10-14 (50s-74.5s) which crosses 60-70 ->
    // filtered pre-critic. Nothing was judged, and the audio we lost is WHY:
    // technical, so FAILED leaves quota untouched instead of shipping DONE
    const run = analyzeHighlightsV2(t, {
      client: client(scanResponse(), criticResponse(0.9)),
      cfg,
      transcriptPartial: true,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
    // the message must carry real counts - a FAILED job has to be diagnosable
    await expect(run).rejects.toThrow(/all 1 candidate\(s\) .*1 missing range\(s\), ~10s/);
  });

  it("repairs wrong-script copy via repairCopy then snippet fallback", async () => {
    const badCopy = {
      ...JSON.parse(criticResponse(0.9).choices[0].message.content),
    };
    badCopy.results[0].title = "English title on russian clip";
    badCopy.results[0].description = "English description entirely.";
    const criticBad = {
      choices: [{ message: { content: JSON.stringify(badCopy) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };
    // repair call also returns wrong-script copy -> snippet fallback kicks in
    const repairBad = {
      choices: [{ message: { content: JSON.stringify({ title: "Still english", description: "Still english too." }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticBad, repairBad),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(1);
    // snippet fallback = verbatim clip text (cyrillic by construction)
    expect(r.highlights[0].title).toMatch(/предложение/);
    expect(r.telemetry.snippetFallbacks).toBe(1);
  });

  it("widens the range to contain evidence cited just outside the boundary", async () => {
    const verdict = JSON.parse(criticResponse(0.9).choices[0].message.content);
    verdict.results[0].title_evidence_nodes = [8]; // 2 nodes before start_node 10
    const criticWiden = {
      choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticWiden),
      cfg,
      transcriptPartial: false,
    });
    expect(r.telemetry.evidenceWidened).toBe(1);
    expect(r.highlights).toHaveLength(1);
    // the widened start pulled the clip back to node 8's onset (minus lead-in)
    expect(r.highlights[0].start).toBeLessThan(40.2);
    expect(r.highlights[0]._startNode).toBe(8);
  });

  it("drops far-outside evidence with a named gate reason", async () => {
    const verdict = JSON.parse(criticResponse(0.9).choices[0].message.content);
    verdict.results[0].title_evidence_nodes = [4]; // 6 nodes before start_node 10
    const criticBadEvidence = {
      choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticBadEvidence),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.telemetry.evidenceWidened).toBe(0);
    expect(r.telemetry.gateDropReasons).toEqual({ title_evidence_out_of_range: 1 });
    expect(r.telemetry.droppedVerdicts).toEqual([
      { id: "c0", stage: "gate", reason: "title_evidence_out_of_range", score: 0.9 },
    ]);
  });

  it("throws AnalyzeTechnicalError when EVERY scanner window fails", async () => {
    // total OpenAI outage: no window ever answers
    const dead = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw Object.assign(new Error("upstream unavailable"), { status: 503 });
          }),
        },
      },
    } as any;

    const run = analyzeHighlightsV2(transcript(), {
      client: dead,
      cfg: multiWindowCfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
    // the message must name the counts so the failed job is diagnosable
    await expect(run).rejects.toThrow(/4\/4 windows/);
  });

  it("does NOT throw when only SOME scanner windows fail", async () => {
    // window 0 is dead, windows 1-3 answer normally -> recall loss, not a failure
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            if (body.model === multiWindowCfg.scanModel) {
              if (user.includes("#0 Это")) {
                throw Object.assign(new Error("upstream unavailable"), { status: 503 });
              }
              return scanResponse();
            }
            return criticResponse(0.85);
          }),
        },
      },
    } as any;

    const r = await analyzeHighlightsV2(transcript(), {
      client,
      cfg: multiWindowCfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r).toBeTruthy();
    expect(r.telemetry.windowsTotal).toBe(4);
    expect(r.telemetry.windowsFailed).toBe(1);
  });

  it("throws AnalyzeTechnicalError when the critic judges NOTHING at all", async () => {
    // API answers 200 but the results array is empty: every candidate lands in
    // "omitted" and nothing was ever judged
    const emptyCritic = {
      choices: [{ message: { content: JSON.stringify({ results: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 5 },
    };

    const run = analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), emptyCritic),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
    // the message must name the counts so the failed job is diagnosable
    await expect(run).rejects.toThrow(/0 .*1 candidate/);
  });

  it("throws AnalyzeTechnicalError when EVERY candidate is refused", async () => {
    // Genuinely refusal-only, unlike the fixture 6434d4d gave that name to.
    // Nothing was judged, so the empty result is not an answer and the job must
    // fail (FAILED bills nothing). It stays the ordinary retryable failure: the
    // retry re-rolls the scanner, so the next attempt does not even present the
    // same candidate windows.
    const refusal = {
      choices: [{ message: { refusal: "I cannot help with that." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 5 },
    };

    const run = analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), refusal),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
  });

  it("real verdicts that all say keep:false stay a content outcome", async () => {
    // the critic DID judge every candidate and rejected them - that is an
    // opinion about the video, not an infrastructure failure
    const rejected = JSON.parse(criticResponse(0.9).choices[0].message.content);
    rejected.results[0].keep = false;
    const criticRejects = {
      choices: [{ message: { content: JSON.stringify(rejected) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };

    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticRejects),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry.criticVerdicts).toBe(1);
  });

  it("a partial critic omission stays a content outcome", async () => {
    // two scanned candidates, the critic answers about c0 only -> c1 is omitted
    const twoCandidateScan = {
      choices: [{
        message: {
          content: JSON.stringify({
            candidates: [
              { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
              { start_node: 25, end_node: 30, payoff_node: 28, interest: 0.7, type: "story", thread: null },
            ],
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    };

    const r = await analyzeHighlightsV2(transcript(), {
      client: client(twoCandidateScan, criticResponse(0.85)),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.telemetry.criticCandidates).toBe(2);
    expect(r.telemetry.criticVerdicts).toBe(1);
    expect(r.telemetry.omittedDrops).toBe(1);
    expect(r.highlights).toHaveLength(1);
  });

  it("healthy windows returning zero candidates stays a content outcome", async () => {
    const emptyScan = {
      choices: [{ message: { content: JSON.stringify({ candidates: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(emptyScan),
      cfg: multiWindowCfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry.windowsFailed).toBe(0);
    expect(r.telemetry.windowsTotal).toBe(4);
  });

  it("a partial transcript that DOES yield clips ships them", async () => {
    // those clips were judged on audio we really heard - losing a chunk costs
    // recall, it does not invalidate what survived
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.85)),
      cfg,
      transcriptPartial: true,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(1);
    expect(r.noClipsReason).toBeUndefined();
  });

  it("a COMPLETE transcript with 0 viable moments stays a content outcome", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.1)),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
  });

  it("a COMPLETE transcript with 0 candidates pre-critic stays a content outcome", async () => {
    const emptyScan = {
      choices: [{ message: { content: JSON.stringify({ candidates: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(emptyScan),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
  });

  // ---- unanswered candidates with zero survivors ------------------------
  // Two scanned candidates so "the critic answered about all of them" and "the
  // critic skipped one" are distinguishable outcomes.
  const twoCandidateScan = () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          candidates: [
            { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
            { start_node: 25, end_node: 30, payoff_node: 28, interest: 0.7, type: "story", thread: null },
          ],
        }),
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  });

  /** Four candidates so the critic runs TWO batches at criticBatchSize 2 - the
   *  only way to have one batch die whole while the other answers normally.
   *  Interest order fixes the batching: selectCriticCandidates takes the top
   *  perWindowMinCandidates (c1, c2) first, then the extras (c0, c3). */
  const fourCandidateScan = () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          candidates: [
            { start_node: 0, end_node: 5, payoff_node: 3, interest: 0.7, type: "story", thread: null },
            { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.9, type: "story", thread: null },
            { start_node: 25, end_node: 30, payoff_node: 28, interest: 0.85, type: "story", thread: null },
            { start_node: 33, end_node: 38, payoff_node: 36, interest: 0.6, type: "story", thread: null },
          ],
        }),
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  });

  const verdictRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    keep: true,
    score: 0.85,
    grounded: true,
    self_contained: true,
    start_node: 10, payoff_node: 13, end_node: 14,
    hook_start_node: 12, hook_end_node: 13,
    title: "Он назвал номер",
    description: "Спикер называет номер предложения.",
    title_evidence_nodes: [13],
    description_evidence_nodes: [13],
    language: "ru",
    ...over,
  });

  const criticRows = (...rows: Array<Record<string, unknown>>) => ({
    choices: [{ message: { content: JSON.stringify({ results: rows }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 200, completion_tokens: 80 },
  });

  it("throws when a candidate went unanswered and nothing survived", async () => {
    // the critic answered about c0 only and rejected it; c1 was never judged by
    // anything. "No viable moments" would be a statement about a video half of
    // whose best moments no model ever looked at - and it would bill the user
    const run = analyzeHighlightsV2(transcript(), {
      client: client(twoCandidateScan(), criticRows(verdictRow("c0", { keep: false }))),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
    // diagnosable counts, same as the sibling guards
    await expect(run).rejects.toThrow(/1 of 2 candidate\(s\) never got a verdict/);
  });

  it("throws when the one judged verdict dies at a gate and a candidate went unanswered", async () => {
    // c0 is kept by the critic but its cited evidence sits far outside the clip,
    // so our grounding bar drops it; c1 never came back at all -> zero clips
    const run = analyzeHighlightsV2(transcript(), {
      client: client(
        twoCandidateScan(),
        criticRows(verdictRow("c0", { title_evidence_nodes: [4] }))
      ),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
    await expect(run).rejects.toThrow(/omitted 1/);
  });

  it("throws on a partial transcript too when a candidate went unanswered", async () => {
    // partialness is orthogonal: a candidate the critic never answered about is
    // unjudged whether or not we also lost audio elsewhere
    const run = analyzeHighlightsV2(transcript(), {
      client: client(twoCandidateScan(), criticRows(verdictRow("c0", { keep: false }))),
      cfg,
      transcriptPartial: true,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
  });

  // ---- GUARDS: every candidate judged, clips lost for content reasons ----

  it("does NOT throw when every candidate was judged and rejected", async () => {
    // THE guard on both failure paths: every candidate came back with a real
    // verdict and every verdict says keep:false. That is the critic's
    // considered opinion about the video, so it must ship as a content answer -
    // DONE, zero clips, NO_VIABLE_MOMENTS - and neither the retryable failure
    // nor the refusal one may fire, no matter how they are split.
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(
        twoCandidateScan(),
        criticRows(
          verdictRow("c0", { keep: false }),
          verdictRow("c1", { keep: false, start_node: 25, payoff_node: 28, end_node: 30, hook_start_node: 26, hook_end_node: 28, title_evidence_nodes: [28], description_evidence_nodes: [28] })
        )
      ),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry.criticVerdicts).toBe(2);
    expect(r.telemetry.omittedDrops).toBe(0);
    expect(r.telemetry.refusalDrops).toBe(0);
    expect(r.telemetry.truncatedDrops).toBe(0);
  });

  it("does NOT throw when EVERY candidate across both batches was judged and rejected", async () => {
    // The honest content answer, and the one this guard must never break: the
    // critic read all four candidates over two batches and said no to each. No
    // truncation, no refusal, no omission - nothing to promote. A weak video is
    // the commonest answer there is and a retry could never change it.
    const answering = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.scanModel) return fourCandidateScan();
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            const ids = [...user.matchAll(/CANDIDATE (c\d+)/g)].map((m) => m[1]);
            return criticRows(...ids.map((id) => verdictRow(id, { keep: false })));
          }),
        },
      },
    };

    const r = await analyzeHighlightsV2(transcript(), {
      client: answering as any,
      cfg: { ...cfg, criticBatchSize: 2 },
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry.criticVerdicts).toBe(4);
    expect(r.telemetry.omittedDrops).toBe(0);
    expect(r.telemetry.truncatedDrops).toBe(0);
    expect(r.telemetry.refusalDrops).toBe(0);
  });

  it("does NOT throw when the critic rejects everything in its live blank-copy shape", async () => {
    // The real model writes no title/description for a clip it is killing -
    // there is nothing to name. Every rejection in the recorded eval fixture
    // podcast-answer-arc (c0, c7, c16) came back exactly like this. Those rows
    // ARE verdicts: the critic looked at each candidate and said no. Treating
    // blank copy on keep:false as a malformed row turns the commonest content
    // answer there is - a weak video - into a hard FAILED that 3 retries can
    // never heal, because the critic will reject the same moments every time.
    const rejected = (id: string, over: Record<string, unknown> = {}) =>
      verdictRow(id, {
        keep: false,
        grounded: false,
        self_contained: false,
        score: 0.5,
        title: "",
        description: "",
        title_evidence_nodes: [],
        description_evidence_nodes: [],
        ...over,
      });

    const r = await analyzeHighlightsV2(transcript(), {
      client: client(
        twoCandidateScan(),
        criticRows(
          rejected("c0"),
          rejected("c1", { start_node: 25, payoff_node: 28, end_node: 30, hook_start_node: 26, hook_end_node: 28 })
        )
      ),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry.criticVerdicts).toBe(2);
    expect(r.telemetry.invariantDrops).toBe(0);
    expect(r.telemetry.omittedDrops).toBe(0);
  });

  it("throws when a truncated candidate is the only one missing", async () => {
    // REVERSED on purpose (was "does NOT throw"). The old expectation encoded
    // the reasoning of 2bb036b: truncation is a content-shaped anomaly of the
    // candidate that reproduces on a re-run, so promoting it would burn three
    // BullMQ attempts for nothing. Two facts sank that reasoning:
    //   - it is not reliably reproducible. critic.ts's own measurement note
    //     records per-call variance the same order as the budget headroom (2184
    //     completion at 6/6000, BELOW the 2857 seen at 6/5000), so a candidate
    //     that truncates at the margin can complete on the next roll.
    //   - the user pays either way. DONE with 0 clips bills the job
    //     (usage.service sums every non-FAILED job) and hands back "no viable
    //     moments" - a claim about a moment no model ever read. FAILED bills
    //     nothing and retries.
    // A wasted retry is cheap; charging for an answer we never obtained is not.
    const truncating = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.scanModel) return twoCandidateScan();
            // critic batches are single-candidate under this cfg: answer for
            // c0, truncate forever on c1 (initial + doubled retry both cut off)
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            if (user.includes("c0")) return criticRows(verdictRow("c0", { keep: false }));
            return {
              choices: [{ message: { content: '{"results":[{"id":"c1"' }, finish_reason: "length" }],
              usage: { prompt_tokens: 200, completion_tokens: 80 },
            };
          }),
        },
      },
    };

    const run = analyzeHighlightsV2(transcript(), {
      client: truncating as any,
      cfg: { ...cfg, criticBatchSize: 1 },
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
    await expect(run).rejects.toThrow(/1 of 2 candidate\(s\) never got a verdict/);
    await expect(run).rejects.toThrow(/truncated 1/);
  });

  it("throws when a whole critic batch truncates away and the rest all say no", async () => {
    // The hole 2bb036b re-opened, in the shape it takes in production: batch A
    // truncates, splits, and every single still truncates, so all of its
    // candidates land in truncatedDrops AND in accountedDropIds - which means
    // omittedDrops never sees them. Batch B answers with real keep:false rows,
    // so verdicts.length > 0 and the upstream "nothing was judged" guard does
    // not fire either. Result under the old guard: highlights 0, omittedDrops
    // 0, job DONE, user BILLED, and told "no viable moments" about half a video
    // no model ever read.
    const truncating = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.scanModel) return fourCandidateScan();
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            const ids = [...user.matchAll(/CANDIDATE (c\d+)/g)].map((m) => m[1]);
            // c1/c2 are the batch that dies; whatever they are batched with on
            // the way down the split cascade dies with them
            if (ids.some((id) => id === "c1" || id === "c2")) {
              return {
                choices: [{ message: { content: '{"results":[{"id":"c1"' }, finish_reason: "length" }],
                usage: { prompt_tokens: 200, completion_tokens: 80 },
              };
            }
            return criticRows(...ids.map((id) => verdictRow(id, { keep: false })));
          }),
        },
      },
    };

    const run = analyzeHighlightsV2(transcript(), {
      client: truncating as any,
      cfg: { ...cfg, criticBatchSize: 2 },
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
    await expect(run).rejects.toThrow(/2 of 4 candidate\(s\) never got a verdict/);
    await expect(run).rejects.toThrow(/truncated 2/);
  });

  it("one refusal among judged candidates fails, and stays retryable", async () => {
    // Renamed from "a refusal-only run fails as a refusal, not as a temporary
    // problem" (6434d4d), which never was refusal-only: it returned a real
    // keep:false verdict for c0 and refused only c1, so the name and the
    // rationale under it described a population the fixture did not build.
    // Widened to 3 judged + 1 refused, which is the shape that made the point
    // unmissable: 39-of-40 read and rejected is not "we could not read this".
    //
    // The THROW is unchanged and still right: a refusal is not a verdict, so
    // "no viable moments" cannot speak for that candidate, and DONE would bill
    // the user for a claim about material nobody judged.
    //
    // What must NOT happen is the run being called settled. Most of this video
    // WAS judged, and judged against; the honest answer is the weak-video one,
    // and the one candidate that was refused could come back differently on the
    // next attempt - the scanner is itself a model call, so a re-run does not
    // even put the same windows in front of the critic. The error class is
    // therefore the plain retryable one, exactly, not a subclass that some
    // caller could promote into a cancelled retry.
    const refusing = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.scanModel) return fourCandidateScan();
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            const ids = [...user.matchAll(/CANDIDATE (c\d+)/g)].map((m) => m[1]);
            if (ids.includes("c3")) {
              return {
                choices: [
                  { message: { refusal: "I cannot help with that." }, finish_reason: "stop" },
                ],
                usage: { prompt_tokens: 200, completion_tokens: 5 },
              };
            }
            return criticRows(...ids.map((id) => verdictRow(id, { keep: false })));
          }),
        },
      },
    };

    const error = await analyzeHighlightsV2(transcript(), {
      client: refusing as any,
      cfg: { ...cfg, criticBatchSize: 1 },
      transcriptPartial: false,
      retryDelayMs: 1,
    }).catch((e) => e);

    // exactly AnalyzeTechnicalError - a subclass would be a distinction the
    // stage boundary is free to act on, and the only act available there is
    // cancelling the retries this failure needs
    expect(error.constructor.name).toBe("AnalyzeTechnicalError");
    expect(error).toBeInstanceOf(AnalyzeTechnicalError);
    expect(error.message).toMatch(/1 of 4 candidate\(s\) never got a verdict/);
    expect(error.message).toMatch(/refused 1/);
  });

  it("an upstream outage answered by a fallback refusal stays retryable", async () => {
    // The path that has nothing to do with the material at all. The primary
    // critic model is down: llm.ts retries the 503 itself, gives up with kind
    // "error", and critic.ts degrades to the fallback model - which refuses
    // once. Nothing has been refused twice; the primary model never expressed
    // an opinion about this video. If that lands in the refusal bucket and the
    // refusal bucket cancels retries, a 503 has permanently condemned a
    // perfectly good video with the attempts that would have rescued it unspent.
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const outage = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.scanModel) return twoCandidateScan();
            if (body.model === cfg.criticModel) {
              primaryCalls += 1;
              throw new Error("503 Service Unavailable");
            }
            fallbackCalls += 1;
            return {
              choices: [{ message: { refusal: "I cannot help with that." }, finish_reason: "stop" }],
              usage: { prompt_tokens: 200, completion_tokens: 5 },
            };
          }),
        },
      },
    };

    const error = await analyzeHighlightsV2(transcript(), {
      client: outage as any,
      cfg: { ...cfg, criticBatchSize: 2 },
      transcriptPartial: false,
      retryDelayMs: 1,
    }).catch((e) => e);

    expect(primaryCalls).toBeGreaterThan(1); // llm.ts retried the 503 on its own
    expect(fallbackCalls).toBeGreaterThan(0); // and the fallback model answered
    expect(error.constructor.name).toBe("AnalyzeTechnicalError");
    expect(error).toBeInstanceOf(AnalyzeTechnicalError);
    expect(error.message).toMatch(/0 usable verdicts for 2 candidates/);
    expect(error.message).toMatch(/refused 2/);
  });

  it("truncation alone stays the retryable failure", async () => {
    // critic.ts's budget note records per-call variance the same order as the
    // headroom (2184 completion tokens at 6/6000 on one run, below the 2857
    // seen at 6/5000), so a candidate that truncated at the margin really can
    // complete on the next roll and ship a clip.
    const truncating = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.scanModel) return twoCandidateScan();
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            if (user.includes("c0")) return criticRows(verdictRow("c0", { keep: false }));
            return {
              choices: [{ message: { content: '{"results":[{"id":"c1"' }, finish_reason: "length" }],
              usage: { prompt_tokens: 200, completion_tokens: 80 },
            };
          }),
        },
      },
    };

    const error = await analyzeHighlightsV2(transcript(), {
      client: truncating as any,
      cfg: { ...cfg, criticBatchSize: 1 },
      transcriptPartial: false,
      retryDelayMs: 1,
    }).catch((e) => e);

    expect(error.constructor.name).toBe("AnalyzeTechnicalError");
    expect(error.message).toMatch(/truncated 1/);
  });

  it("a refusal mixed with a truncation stays the retryable failure", async () => {
    // Every unjudged population is retryable, and this one visibly so: the
    // truncated candidate may complete on the next attempt and ship a clip, so
    // telling the user "try a different file" would send them away from a video
    // that may well work.
    const mixed = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.scanModel) return twoCandidateScan();
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            if (user.includes("CANDIDATE c0")) {
              return {
                choices: [{ message: { refusal: "I cannot help with that." }, finish_reason: "stop" }],
                usage: { prompt_tokens: 200, completion_tokens: 5 },
              };
            }
            return {
              choices: [{ message: { content: '{"results":[{"id":"c1"' }, finish_reason: "length" }],
              usage: { prompt_tokens: 200, completion_tokens: 80 },
            };
          }),
        },
      },
    };

    const error = await analyzeHighlightsV2(transcript(), {
      client: mixed as any,
      cfg: { ...cfg, criticBatchSize: 1 },
      transcriptPartial: false,
      retryDelayMs: 1,
    }).catch((e) => e);

    expect(error.constructor.name).toBe("AnalyzeTechnicalError");
    expect(error.message).toMatch(/refused 1/);
    expect(error.message).toMatch(/truncated 1/);
  });


  it("does NOT throw when a candidate was skipped but a clip survived", async () => {
    // The guard is about the WHOLE answer being empty. With a shipped clip an
    // unjudged candidate is ordinary recall loss - we hand the user something
    // real and say nothing false about the moment we missed.
    const truncating = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.scanModel) return twoCandidateScan();
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            if (user.includes("c0")) return criticRows(verdictRow("c0"));
            return {
              choices: [{ message: { content: '{"results":[{"id":"c1"' }, finish_reason: "length" }],
              usage: { prompt_tokens: 200, completion_tokens: 80 },
            };
          }),
        },
      },
    };

    const r = await analyzeHighlightsV2(transcript(), {
      client: truncating as any,
      cfg: { ...cfg, criticBatchSize: 1 },
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(1);
    expect(r.telemetry.truncatedDrops).toBe(1);
  });

  it("does NOT throw when every judged clip is dropped by snap for content reasons", async () => {
    // both verdicts are keeps the critic believes in; both collapse to a single
    // sentence and snap refuses them as too short. That is the engine's own
    // quality bar on moments it really judged - a content answer, not a failure
    const single = (node: number) => ({
      start_node: node, payoff_node: node, end_node: node,
      hook_start_node: node, hook_end_node: node,
      title_evidence_nodes: [node], description_evidence_nodes: [node],
    });
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(
        twoCandidateScan(),
        criticRows(verdictRow("c0", single(13)), verdictRow("c1", single(28)))
      ),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry.snapDrops).toBe(2);
    expect(r.telemetry.droppedVerdicts).toEqual([
      { id: "c0", stage: "snap", reason: "too_short", score: 0.85 },
      { id: "c1", stage: "snap", reason: "too_short", score: 0.85 },
    ]);
  });

  it("does NOT throw when every judged clip is dropped by the evidence gate", async () => {
    // far-outside evidence is a grounding failure our gate is DESIGNED to catch;
    // every candidate still got a real verdict, so the emptiness is an answer
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(
        twoCandidateScan(),
        criticRows(
          verdictRow("c0", { title_evidence_nodes: [4] }),
          verdictRow("c1", { start_node: 25, payoff_node: 28, end_node: 30, hook_start_node: 26, hook_end_node: 28, title_evidence_nodes: [4], description_evidence_nodes: [28] })
        )
      ),
      cfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry.evidenceDrops).toBe(2);
  });
});
