import { describe, expect, it, vi } from "vitest";
import { reviewPublishability } from "../analyze-v2/publishability";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import type { SentenceNode, SnappedClip } from "../analyze-v2/types";

const nodes: SentenceNode[] = Array.from({ length: 5 }, (_, index) => ({
  index, start: index * 5, end: index * 5 + 4.8,
  text: `Это полное предложение номер ${index}.`, hasWords: true,
  leadingStrength: 1, trailingStrength: 1,
}));
function clip(id = "c0"): SnappedClip {
  return {
    verdict: { id, keep: true, grounded: true, selfContained: true, score: 0.9,
      startNode: 0, endNode: 4, payoffNode: 3, hookStartNode: 1, hookEndNode: 2,
      title: "Кто забрал башню?", description: "Старая копия.",
      titleEvidenceNodes: [2], descriptionEvidenceNodes: [2], language: "ru" },
    finalStartNode: 1, finalEndNode: 3, startSec: 5, endSec: 19.8,
    hookStartSec: 5, hookEndSec: 14.8, payoffSec: 19, shortMoment: false,
  };
}
const row = (patch: Record<string, unknown> = {}) => ({
  id: "c0", value_reason: "A useful explanation.", value: "substantive",
  title_reason: "The speaker answers the question.", title_supported: true,
  corrected_title: null, title_evidence_nodes: [], ...patch,
});
async function run(data: unknown, clips = [clip()], enabled = true) {
  const create = vi.fn(async (..._args: any[]) => ({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 20 } }));
  const usage = newUsage();
  const result = await reviewPublishability({ chat: { completions: { create } } } as any,
    usage, clips, nodes, loadAnalyzeConfig({ ANALYZE_PUBLISHABILITY: enabled ? "on" : "off" }));
  return { result, create, usage };
}
describe("finished clip review", () => {
  it("can reject a sole generic clip without a minimum-output escape", async () => {
    const { result, create } = await run({ clips: [row({ value: "generic" })] });
    expect(result.clips).toEqual([]);
    expect(result.telemetry.dropped).toEqual(["c0"]);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("repairs a useful clip's title without changing its content or boundaries", async () => {
    const original = clip();
    const { result, create, usage } = await run({ clips: [row({ title_supported: false,
      corrected_title: "Кто оставил башню без защиты?", title_evidence_nodes: [2] })] }, [original]);
    expect(result.clips).toEqual([{ ...original, verdict: { ...original.verdict,
      title: "Кто оставил башню без защиты?", titleEvidenceNodes: [2] } }]);
    expect(original.verdict.title).toBe("Кто забрал башню?");
    const body = create.mock.calls[0][0] as any;
    expect(JSON.parse(body.messages[1].content)).toEqual([{ id: "c0", speech_language: "ru",
      speech: nodes.slice(1, 4).map(({ index, text }) => ({ index, text })), title: original.verdict.title }]);
    expect(create.mock.calls[0][1]).toEqual({ maxRetries: 0 });
    expect(usage.requests).toBe(1);
  });
  it("preserves an uncertain visual moment", async () => {
    const { result } = await run({ clips: [row({ value: "uncertain" })] });
    expect(result.clips).toEqual([clip()]);
    expect(result.telemetry.evaluated).toBe(1);
  });
  it.each([
    { corrected_title: "Новый заголовок", title_evidence_nodes: [0] },
    { corrected_title: "Wrong language title", title_evidence_nodes: [2] },
    { corrected_title: " ", title_evidence_nodes: [2] },
    { corrected_title: "Кто забрал башню?", title_evidence_nodes: [2] },
    { corrected_title: "я".repeat(71), title_evidence_nodes: [2] },
  ])("does not drop a useful clip on an invalid title repair: %j", async (patch) => {
    const { result } = await run({ clips: [row({ title_supported: false, ...patch })] });
    expect(result.clips).toEqual([clip()]);
    expect(result.telemetry.rewriteRejected).toHaveLength(1);
  });
  it.each([
    {}, { clips: [] }, { clips: [row(), row()] }, { clips: [row({ id: "unknown" })] },
    { clips: [row({ value: "delete" })] }, { clips: [row({ title_supported: "false" })] },
    { clips: [null] },
  ])("fails open on incomplete or malformed replies: %j", async (data) => {
    const { result } = await run(data);
    expect(result.clips).toEqual([clip()]);
    expect(result.telemetry.skipped).toBe("malformed");
    expect(result.telemetry.evaluated).toBe(0);
  });
  it("validates the whole batch before applying any veto", async () => {
    const { result } = await run({ clips: [row({ value: "generic" })] }, [clip(), clip("c1")]);
    expect(result.clips).toHaveLength(2);
    expect(result.telemetry.skipped).toBe("malformed");
  });
  it("makes no request when disabled or empty", async () => {
    for (const { result, create } of [await run({}, [clip()], false), await run({}, [])]) {
      expect(create).not.toHaveBeenCalled();
      expect(result.telemetry.evaluated).toBe(0);
    }
  });
});
