import type { Highlight, WhisperSegment } from "@clipclap/shared";
import { copyFile } from "node:fs/promises";
import { segmentsToCues, createAssFilter } from "../processors/subtitles";
import { computeCropPlan } from "../reframe";
import { buildFiltergraph } from "../reframe/filtergraph";
import { cutClips, type CutResult } from "../processors/cut";
import type { MaterializedCase } from "./promote";
import type { QualityCaseResult, QualityMetrics } from "./types";

export type RenderProbe = Readonly<{
  width: number; height: number; sar: number; duration: number; frameCount: number;
  blackTailSeconds: number; frozenTailSeconds: number;
  subtitleOverlap: number; requiredTextClipped: number; requiredSubjectClipped: number;
  focalFailures?: number;
}>;

export type RenderLaneOptions = Readonly<{
  sourcePath: string;
  highlight: Highlight;
  transcriptSegments: WhisperSegment[];
  language?: string | null;
  subtitlesOn?: boolean;
  reframeConfig?: Parameters<typeof computeCropPlan>[3];
  probe: (path: string, qualityCase: MaterializedCase) => Promise<RenderProbe>;
  segmentsToCues?: typeof segmentsToCues;
  createAssFilter?: typeof createAssFilter;
  computeCropPlan?: typeof computeCropPlan;
  buildFiltergraph?: typeof buildFiltergraph;
  cutClips?: typeof cutClips;
  musicFades?: boolean;
  blackTailTrim?: Parameters<typeof cutClips>[5];
  privateOutputPath?: string;
  copyOutput?: (sourcePath: string, destinationPath: string) => Promise<void>;
}>;

/** Stage-equivalent render order is intentionally visible in this function:
 * cues -> ASS -> crop plan -> filtergraph -> cut. */
export async function observeRenderCase(
  qualityCase: MaterializedCase,
  options: RenderLaneOptions,
): Promise<QualityCaseResult> {
  const cuesFn = options.segmentsToCues ?? segmentsToCues;
  const assFn = options.createAssFilter ?? createAssFilter;
  const cropFn = options.computeCropPlan ?? computeCropPlan;
  const graphFn = options.buildFiltergraph ?? buildFiltergraph;
  const cutFn = options.cutClips ?? cutClips;
  const cues = cuesFn(options.transcriptSegments, options.highlight.start, options.highlight.end, options.language);
  let ass: { filter: string; assPath: string } | undefined;
  if (options.subtitlesOn !== false && cues.length > 0) ass = await assFn(cues, options.language);
  const crop = await cropFn(options.sourcePath, options.highlight.start, options.highlight.end, options.reframeConfig);
  const graph = crop.plan ? graphFn(crop.plan, ass?.filter) : undefined;
  let cuts: Awaited<ReturnType<typeof cutClips>>;
  try {
    cuts = await cutFn(options.sourcePath, [options.highlight], ass?.filter, graph ?? null, options.musicFades, options.blackTailTrim);
  } catch (error) {
    // Match stages/render.ts: a failed reframe encode retries once with the
    // legacy crop. The retry is absent when no graph was requested.
    if (!graph) throw error;
    cuts = await cutFn(options.sourcePath, [options.highlight], ass?.filter, null, options.musicFades, options.blackTailTrim);
  }
  const output = cuts[0] as CutResult | undefined;
  if (!output?.clipPath) throw new Error("render output missing");
  const outputPath = options.privateOutputPath ?? output.clipPath;
  if (outputPath !== output.clipPath) await (options.copyOutput ?? copyFile)(output.clipPath, outputPath);
  const probe = await options.probe(outputPath, qualityCase);
  const expectedDuration = Math.max(0.001, options.highlight.end - options.highlight.start);
  const overlap = Math.max(0, Math.min(1, probe.duration / expectedDuration));
  const metrics: QualityMetrics = {
    approvedMomentRetained: qualityCase.expected.approvedMoment && probe.duration > 0 ? 1 : 0,
    approvedWindowOverlap: qualityCase.expected.approvedMoment ? overlap : 0,
    hardInvariantFailures: probe.width === 1080 && probe.height === 1920 && probe.sar === 1 ? 0 : 1,
    outputWidth: probe.width, outputHeight: probe.height, sar: probe.sar,
    durationDrift: Math.abs(probe.duration - expectedDuration),
    frameCount: probe.frameCount, blackTailSeconds: probe.blackTailSeconds, frozenTailSeconds: probe.frozenTailSeconds,
    subtitleOverlap: probe.subtitleOverlap, requiredTextClipped: probe.requiredTextClipped,
    requiredSubjectClipped: probe.requiredSubjectClipped,
    focalFailures: probe.focalFailures ?? 0,
  };
  return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "ok", metrics };
}
