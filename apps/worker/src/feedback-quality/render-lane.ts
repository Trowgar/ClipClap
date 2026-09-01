import type { Highlight, WhisperSegment } from "@clipclap/shared";
import { copyFile, unlink } from "node:fs/promises";
import { segmentsToCues, createAssFilter } from "../processors/subtitles";
import { computeCropPlan } from "../reframe";
import type { ReframeConfig } from "../reframe/config";
import { buildFiltergraph } from "../reframe/filtergraph";
import type { MusicDirectionOpts } from "../reframe/types";
import { cutClips, type CutResult } from "../processors/cut";
import type { MaterializedCase } from "./promote";
import type { QualityCaseResult, QualityMetrics } from "./types";
import type { CropPlan } from "../reframe/types";

export type RenderProbe = Readonly<{
  approvedMomentRetained: number; approvedWindowOverlap: number; contentMatch: number;
  width: number; height: number; sar: number; duration: number; frameCount: number;
  blackTailSeconds: number; frozenTailSeconds: number;
  subtitleOverlap: number; requiredTextClipped: number; requiredSubjectClipped: number;
  focalFailures?: number;
  visualMeasured: boolean;
}>;

export type RenderLaneOptions = Readonly<{
  sourcePath: string;
  highlight: Highlight;
  transcriptSegments: WhisperSegment[];
  language?: string | null;
  subtitlesOn?: boolean;
  reframeConfig?: ReframeConfig;
  musicDirection?: MusicDirectionOpts;
  probe: (path: string, qualityCase: MaterializedCase, context?: Readonly<{ cropPlan: CropPlan | null; assPath?: string; cues: readonly unknown[]; samples: MaterializedCase["expected"]["visualSamples"]; referencePath: string; highlightStart: number }>) => Promise<RenderProbe>;
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
  let ass: { filter: string; assPath: string } | undefined;
  let outputPath: string | undefined;
  let cutOutputPath: string | undefined;
  let referencePath: string | undefined;
  let referenceCutPath: string | undefined;
  try {
    const cues = cuesFn(options.transcriptSegments, options.highlight.start, options.highlight.end, options.language);
    if (options.subtitlesOn !== false && cues.length > 0) ass = await assFn(cues, options.language);
    const crop = options.reframeConfig?.engine === "off" ? { plan: null, shotCount: 0, detectMs: 0 } : await cropFn(options.sourcePath, options.highlight.start, options.highlight.end, options.reframeConfig);
    const graph = crop.plan ? graphFn(crop.plan, ass?.filter, options.musicDirection) : undefined;
    const cutWithFallback = async (subtitleFilter: string | undefined, graphForCut = graph): Promise<Awaited<ReturnType<typeof cutClips>>> => {
      try {
        return await cutFn(options.sourcePath, [options.highlight], subtitleFilter, graphForCut ?? null, options.musicFades, options.blackTailTrim);
      } catch (error) {
        // Match stages/render.ts: a failed reframe encode retries once with the
        // legacy crop. The retry is absent when no graph was requested.
        if (!graph) throw error;
        return await cutFn(options.sourcePath, [options.highlight], subtitleFilter, null, options.musicFades, options.blackTailTrim);
      }
    };
    const cuts = await cutWithFallback(ass?.filter);
    const output = cuts[0] as CutResult | undefined;
    if (!output?.clipPath) throw new Error("render output missing");
    cutOutputPath = output.clipPath;
    outputPath = options.privateOutputPath ?? output.clipPath;
    if (outputPath !== output.clipPath) await (options.copyOutput ?? copyFile)(output.clipPath, outputPath);
    // A no-subtitle reference uses the exact candidate source/highlight/crop
    // path. It is private and bounded to one additional cut, then removed in
    // finally; pixel comparison can therefore distinguish wrong content from
    // a duration-preserving render.
    if (qualityCase.expected.visualSamples.length > 0) {
      const referenceGraph = crop.plan ? graphFn(crop.plan, undefined, options.musicDirection) : undefined;
      const referenceCuts = await cutWithFallback(undefined, referenceGraph);
      const reference = referenceCuts[0] as CutResult | undefined;
      if (!reference?.clipPath) throw new Error("visual reference output missing");
      referenceCutPath = reference.clipPath;
      referencePath = reference.clipPath;
    } else referencePath = outputPath;
    const probe = await options.probe(outputPath, qualityCase, { cropPlan: crop.plan, assPath: ass?.assPath, cues, samples: qualityCase.expected.visualSamples, referencePath, highlightStart: options.highlight.start });
    if (!probe.visualMeasured) throw new Error("visual probe unavailable");
    const expectedDuration = Math.max(0.001, options.highlight.end - options.highlight.start);
    const overlap = probe.approvedWindowOverlap;
    const metrics: QualityMetrics = {
      approvedMomentRetained: qualityCase.expected.approvedMoment ? probe.approvedMomentRetained : 0,
      approvedWindowOverlap: qualityCase.expected.approvedMoment ? overlap : 0,
      hardInvariantFailures: probe.width === 1080 && probe.height === 1920 && probe.sar === 1 && probe.contentMatch === 1 ? 0 : 1,
      outputWidth: probe.width, outputHeight: probe.height, sar: probe.sar,
      durationDrift: Math.abs(probe.duration - expectedDuration),
      frameCount: probe.frameCount, blackTailSeconds: probe.blackTailSeconds, frozenTailSeconds: probe.frozenTailSeconds,
      subtitleOverlap: probe.subtitleOverlap, requiredTextClipped: probe.requiredTextClipped,
      requiredSubjectClipped: probe.requiredSubjectClipped,
      focalFailures: probe.focalFailures ?? 0,
    };
    return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "ok", metrics };
  } finally {
    if (ass?.assPath) await unlink(ass.assPath).catch(() => undefined);
    if (cutOutputPath) await unlink(cutOutputPath).catch(() => undefined);
    if (referenceCutPath) await unlink(referenceCutPath).catch(() => undefined);
    if (outputPath && outputPath !== cutOutputPath) await unlink(outputPath).catch(() => undefined);
  }
}
