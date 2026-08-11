import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, and why it is not snap.test.ts or finalize.test.ts
//
// The mechanism pieces (snap's deferral, compressToFit's walk, the finalizer's
// LENGTH EXCEPTION line, the defence-in-depth gate) are each covered next door
// in isolation. This file only asserts things that are FALSE about a
// disconnected policy: that a real overLength candidate coming out of the real
// pipeline ends up blessed-and-wide, compressed, or dropped depending on real
// arc-audit flags; that the policy runs between arc-audit and start-extension;
// that "LONG_CLIPS alone degrades to today's behaviour" is actually true of the
// shipped clip, not merely asserted in a comment; and that the telemetry block
// is present/absent exactly when the design promises.
//
// One candidate, spanning nodes 10..28 at 5s/node (94.95s - inside the
// measured 90-150s long-clip band), is reused across every test with a
// per-test hookStartNode that decides whether compressToFit has anywhere to
// land. Modeled on arc-audit-wiring.test.ts's own stub-by-schema-name client.
// ---------------------------------------------------------------------------

/** 60 sentences x 5s with word timings - one scan window, no scene cuts.
 *  Identical shape to arc-audit-wiring.test.ts's own fixture (every node a
 *  clean start/end by construction), just longer so a candidate can span
 *  past the 90s cap without running out of graph. */
function transcript(): TranscriptionResult {
  const segments: WhisperSegment[] = Array.from({ length: 60 }, (_, i) => {
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

// startSec = n[10].start - leadInSec = 50 - 0.15 = 49.85
// endSec   = n[28].end + tailHoldSec, capped at n[29].start = min(144.8, 145) = 144.8
// duration = 144.8 - 49.85 = 94.95s - over maxSec(90), inside longClipMaxSec(150)
const C0_START = 49.85;
const C0_END = 144.8;
const C0_DURATION = C0_END - C0_START; // 94.95
// Compressed onto node 11 (the only candidate when hookStartNode=11):
// candidateStart = startSecFor(11) = max(min(n[10].end=54.5, 55), 55-0.15=54.85) = 54.85
const COMPRESSED_START = 54.85;
const COMPRESSED_DURATION = C0_END - COMPRESSED_START; // 89.95

/** `hookStartNode` controls whether compressToFit has anywhere to land:
 *  11 gives it exactly one legal candidate (node 11 itself); 10 (== the
 *  clip's own start) gives it none at all. */
const scanResponse = {
  candidates: [
    { start_node: 10, end_node: 28, payoff_node: 28, interest: 0.8, type: "story", thread: null },
  ],
};

const criticResponse = (hookStartNode: number) => ({
  results: [
    {
      id: "c0",
      keep: true,
      score: 0.85,
      grounded: true,
      self_contained: true,
      start_node: 10,
      payoff_node: 28,
      end_node: 28,
      hook_start_node: hookStartNode,
      hook_end_node: 28,
      title: "Заголовок c0",
      description: "Спикер называет номер предложения 28.",
      title_evidence_nodes: [28],
      description_evidence_nodes: [28],
      language: "ru",
    },
  ],
});

const shipRow = { id: "c0", verdict: "ship", drop_reason: null, duplicate_of: null, shared_claim: null, title: null, title_evidence_nodes: null, trim_start_node: null };
const finalizerResponse = { clips: [shipRow] };

const okAuditRow = {
  id: "c0",
  entry: { ok: true, defect: null, fix_start_node: null },
  exit: { ok: true, defect: null, fix_end_node: null },
  standalone: { ok: true, missing: null },
};
const flaggedAuditRow = {
  id: "c0",
  entry: { ok: false, defect: "dangling_reference", fix_start_node: null },
  exit: { ok: true, defect: null, fix_end_node: null },
  standalone: { ok: true, missing: null },
};

const THROW = Symbol("stub throws");
type Reply = Record<string, unknown> | typeof THROW;

interface Recorded {
  schema: string;
  model: string;
  system: string;
  user: string;
}

/** Minimal OpenAI stand-in that answers per STAGE, keyed by the response
 *  schema callJsonSchema sends - same shape as arc-audit-wiring.test.ts's own
 *  stubClient. */
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
    const completionTokens =
      { scan_candidates: 30, critic_verdicts: 80, arc_audit: 60, clip_finalizer: 90 }[schema] ?? 0;
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

const schemasOf = (requests: Recorded[]) => requests.map((r) => r.schema);
const userFor = (requests: Recorded[], schema: string) =>
  requests.find((r) => r.schema === schema)?.user ?? "";
const longClipsOf = (telemetry: Record<string, unknown>) =>
  telemetry.longClips as
    | { overLength: number; blessed: number; compressed: number; dropped: number }
    | undefined;

describe("long-clips policy wiring", () => {
  it("compresses today, exactly as before this task, while LONG_CLIPS is dark", async () => {
    const darkCfg = loadAnalyzeConfig({});
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse(11), // one legal compression candidate
      clip_finalizer: finalizerResponse,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: darkCfg });

    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "clip_finalizer"]);
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].start).toBeCloseTo(COMPRESSED_START, 6);
    expect(r.highlights[0].end - r.highlights[0].start).toBeCloseTo(COMPRESSED_DURATION, 6);
    expect("longClips" in r.telemetry).toBe(false);
  });

  it("degrades to today's shipped result when the flag is on but nothing can ever be blessed (ARC_AUDIT off)", async () => {
    const flagOnlyCfg = loadAnalyzeConfig({ LONG_CLIPS: "on" });
    expect(flagOnlyCfg.arcAuditEnabled).toBe(false);
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse(11),
      clip_finalizer: finalizerResponse,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: flagOnlyCfg });

    // no arc_audit call: the master switch never ran
    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "clip_finalizer"]);
    // SAME numbers as the dark run above - the deferral-then-compress path and
    // the direct snap-time compression path are the same algorithm
    expect(r.highlights[0].start).toBeCloseTo(COMPRESSED_START, 6);
    expect(r.highlights[0].end - r.highlights[0].start).toBeCloseTo(COMPRESSED_DURATION, 6);
    expect(longClipsOf(r.telemetry)).toEqual({
      overLength: 1,
      blessed: 0,
      compressed: 1,
      dropped: 0,
    });
  });

  it("ships a clip wide when arc-audit blesses it on all three axes, with the LENGTH EXCEPTION line in the finalizer prompt", async () => {
    const liveCfg = loadAnalyzeConfig({ LONG_CLIPS: "on", ARC_AUDIT: "on" });
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse(11),
      arc_audit: { results: [okAuditRow] },
      clip_finalizer: finalizerResponse,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "clip_finalizer",
    ]);
    expect(r.highlights).toHaveLength(1);
    // UNCOMPRESSED - the full 94.95s clip shipped wide
    expect(r.highlights[0].start).toBeCloseTo(C0_START, 6);
    expect(r.highlights[0].end - r.highlights[0].start).toBeCloseTo(C0_DURATION, 6);
    expect(longClipsOf(r.telemetry)).toEqual({
      overLength: 1,
      blessed: 1,
      compressed: 0,
      dropped: 0,
    });

    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).toContain(
      `LENGTH EXCEPTION: this clip runs ${Math.round(C0_DURATION)}s, over the 90s standard`
    );
  });

  it("compresses a clip arc-audit flagged on any axis, not blessed", async () => {
    const liveCfg = loadAnalyzeConfig({ LONG_CLIPS: "on", ARC_AUDIT: "on" });
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse(11),
      arc_audit: { results: [flaggedAuditRow] },
      clip_finalizer: finalizerResponse,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights[0].start).toBeCloseTo(COMPRESSED_START, 6);
    expect(r.highlights[0].end - r.highlights[0].start).toBeCloseTo(COMPRESSED_DURATION, 6);
    expect(longClipsOf(r.telemetry)).toEqual({
      overLength: 1,
      blessed: 0,
      compressed: 1,
      dropped: 0,
    });
    // no LENGTH EXCEPTION line - the clip is no longer overLength by the time
    // the finalizer sees it
    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).not.toContain("LENGTH EXCEPTION");
  });

  it("drops a clip that cannot be compressed, visibly, and it never reaches the finalizer", async () => {
    const liveCfg = loadAnalyzeConfig({ LONG_CLIPS: "on", ARC_AUDIT: "on" });
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse(10), // hookStartNode == startNode: no room to compress
      arc_audit: { results: [flaggedAuditRow] },
      clip_finalizer: finalizerResponse,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights).toHaveLength(0);
    // dropped before the finalizer ever ran - it had nothing left to judge
    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "arc_audit"]);
    expect(longClipsOf(r.telemetry)).toEqual({
      overLength: 1,
      blessed: 0,
      compressed: 0,
      dropped: 1,
    });
    const drop = (r.telemetry.droppedVerdicts as Array<{ id: string; stage: string; reason: string }>).find(
      (d) => d.id === "c0"
    );
    expect(drop).toEqual({ id: "c0", stage: "long_clip_policy", reason: "too_long", score: 0.85 });
  });

  it("runs the policy between arc-audit and start-extension - no extra model call of its own", async () => {
    const liveCfg = loadAnalyzeConfig({
      LONG_CLIPS: "on",
      ARC_AUDIT: "on",
      START_EXTENSION: "on",
    });
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse(11),
      arc_audit: { results: [okAuditRow] },
      clip_finalizer: finalizerResponse,
    });
    await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    // start-extension makes no call of its own either (arc-audit already
    // asked), so the schema sequence is unchanged by either stage being live
    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "clip_finalizer",
    ]);
  });
});

// ---------------------------------------------------------------------------
// THE EXTENSION ASYMMETRY, CLOSED (2026-08-11 follow-up to the task 5 report).
//
// A clip that starts UNDER maxSec but is pushed OVER it by a blessed-ceiling
// widening in an extension stage never went through snap's deferral (it was
// never overLength there - it was never over maxSec there) and never went
// through the long-clip POLICY (which only ever looks at clips already marked
// overLength coming out of selection). Without the sweep in index.ts, such a
// clip would reach the finalizer with no mark at all: no LENGTH EXCEPTION
// line, no explicit ratification - the owner's first condition silently
// unmet for a clip that is, by construction, over the 90s standard.
//
// NOTE ON WHICH PATH REACHES THIS: the scenario name says "end-extension
// hint", but a HINTED clip's `exit.ok` is FALSE by construction (that is what
// makes it eligible for a hint at all - see end-extension.ts's own offered-
// set logic), and `isFullyOk` (blessed) requires all three axes `ok: true`.
// So a hint-driven widening can NEVER be blessed - the exact same structural
// asymmetry already documented on start-extension.ts's own fitsMaxSec (a
// pointer-eligible clip there is never blessed either, since eligibility
// requires `entry.ok: false`). The reachable path or a FULLY-OK clip is
// end-extension's SELF-MOTIVATED offer (`END_EXTENSION=on`), which - unlike
// the hint path - offers every clip with a non-empty window regardless of
// its flags. This test uses that path; the comment above end-extension.ts's
// own fitsMaxSec already says so.
// ---------------------------------------------------------------------------

describe("the extension asymmetry - a blessed clip widened past maxSec is marked before the finalizer sees it", () => {
  // Candidate [10, 20]: startSec 49.85, original endSec (node 20) 104.8 -
  // 54.95s, comfortably under maxSec on its own. snap never marks it
  // overLength, and the long-clip policy never touches it (it only inspects
  // clips already carrying the mark).
  const scanResponse2 = {
    candidates: [
      { start_node: 10, end_node: 20, payoff_node: 20, interest: 0.8, type: "story", thread: null },
    ],
  };
  const criticResponse2 = {
    results: [
      {
        id: "c0",
        keep: true,
        score: 0.85,
        grounded: true,
        self_contained: true,
        start_node: 10,
        payoff_node: 20,
        end_node: 20,
        hook_start_node: 11,
        hook_end_node: 20,
        title: "Заголовок c0",
        description: "Спикер называет номер предложения 20.",
        title_evidence_nodes: [20],
        description_evidence_nodes: [20],
        language: "ru",
      },
    ],
  };
  const okAuditRow2 = {
    id: "c0",
    entry: { ok: true, defect: null, fix_start_node: null },
    exit: { ok: true, defect: null, fix_end_node: null },
    standalone: { ok: true, missing: null },
  };
  const shipRow2 = { id: "c0", verdict: "ship", drop_reason: null, duplicate_of: null, shared_claim: null, title: null, title_evidence_nodes: null, trim_start_node: null };
  const finalizerResponse2 = { clips: [shipRow2] };
  // Self-motivated proposal to node 30: endSecFor(30) = 154.8 (capped at node
  // 31's onset), so the widened span is 154.8 - 49.85 = 104.95s - over
  // maxSec(90), inside longClipMaxSec(150). Only reachable at all because the
  // window and the gate both raise their ceiling to longClipMaxSec for THIS
  // blessed clip (fitsMaxSec's `cfg.longClipsEnabled && blessed`).
  const extensionResponse = {
    results: [{ id: "c0", reason: "the story keeps going", extend: true, end_node: 30 }],
  };
  const WIDENED_START = 49.85;
  const WIDENED_END = 154.8;
  const WIDENED_DURATION = WIDENED_END - WIDENED_START; // 104.95

  it("marks the widened clip, renders the LENGTH EXCEPTION line, and ships it wide through the defence-in-depth gate", async () => {
    const liveCfg = loadAnalyzeConfig({
      LONG_CLIPS: "on",
      ARC_AUDIT: "on",
      END_EXTENSION: "on",
      END_EXTENSION_WINDOW_SEC: "1000",
    });
    const { client, requests } = stubClient({
      scan_candidates: scanResponse2,
      critic_verdicts: criticResponse2,
      arc_audit: { results: [okAuditRow2] },
      end_extension: extensionResponse,
      clip_finalizer: finalizerResponse2,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "end_extension",
      "clip_finalizer",
    ]);

    // shipped wide, not compressed
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].start).toBeCloseTo(WIDENED_START, 6);
    expect(r.highlights[0].end - r.highlights[0].start).toBeCloseTo(WIDENED_DURATION, 6);
    expect(r.highlights[0].end - r.highlights[0].start).toBeGreaterThan(liveCfg.maxSec);

    // the sweep marked it: the finalizer's prompt carries the explicit
    // ratification line, at the WIDENED duration (105s, not the original 55s)
    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).toContain(
      `LENGTH EXCEPTION: this clip runs ${Math.round(WIDENED_DURATION)}s, over the 90s standard`
    );

    // the defence-in-depth gate did NOT compress it - finalize.ts's own
    // isFullyOk check reads this clip as blessed (all three axes really are
    // ok), so it passes through unchanged
    expect(("longClipsCompressed" in r.telemetry)).toBe(false);
    expect(("longClipsDropped" in r.telemetry)).toBe(false);
  });

  it("never marks the clip when it is not blessed, even though the same widen still succeeds under the plain maxSec-refusing gate", async () => {
    // Sanity control: with arc-audit OFF (nothing can ever be blessed), the
    // self-motivated window and gate both fall back to the plain maxSec
    // ceiling, so a proposal to node 30 - which needs the raised ceiling to
    // fit - is refused outright and the clip ships at its ORIGINAL,
    // unwidened length. No mark, because nothing ever crossed maxSec.
    const auditOffCfg = loadAnalyzeConfig({
      LONG_CLIPS: "on",
      END_EXTENSION: "on",
      END_EXTENSION_WINDOW_SEC: "1000",
    });
    expect(auditOffCfg.arcAuditEnabled).toBe(false);
    const { client } = stubClient({
      scan_candidates: scanResponse2,
      critic_verdicts: criticResponse2,
      end_extension: extensionResponse,
      clip_finalizer: finalizerResponse2,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: auditOffCfg });

    expect(r.highlights).toHaveLength(1);
    // unwidened - node 30 was refused (outside the 90s-ceiling window), so
    // the clip ships at its original 104.8 - 49.85 = 54.95s
    expect(r.highlights[0].end - r.highlights[0].start).toBeCloseTo(104.8 - 49.85, 6);
    expect(r.highlights[0].end - r.highlights[0].start).toBeLessThanOrEqual(auditOffCfg.maxSec);
  });
});
