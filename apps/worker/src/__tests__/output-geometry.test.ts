/**
 * The output-geometry invariant: every `scale` that produces output pixels is
 * immediately followed by `setsar=1`.
 *
 * Spec `docs/superpowers/specs/2026-08-08-output-geometry-design.md`, measured
 * in `docs/engine-notes.md` §7h. A 9:16 slice of a 1080-tall frame is 607.5px
 * wide, `cropWidthFor` rounds it to an even 608, and scaling that to exactly
 * 1080x1920 leaves ffmpeg to absorb the 0.08% by tagging the output
 * `SAR 1216:1215` rather than stretching it. All 62 delivered clips and all
 * five filter paths carried that tag.
 *
 * This file is the cheap half of the guard. `eval-clip-geometry.ts` renders and
 * probes real files, which is the only proof that the tag is actually square;
 * this one is what fails in CI the day somebody adds a `scale` without a
 * `setsar` beside it, years from now and in a branch nobody re-renders.
 *
 * WHY IT IS WRITTEN AS "EVERY scale IS FOLLOWED BY setsar", NOT AS AN EXPECTED
 * STRING
 * ----------------------------------------------------------------------------
 *
 * The neighbouring suites already pin the exact graph text, and those pins are
 * worth keeping - but a pin only guards the construction it names. A new tile
 * added to a future layout would be caught by neither, because no existing pin
 * mentions it. Enumerating the `scale=` occurrences and requiring each to be
 * followed by `setsar=1` covers constructions that do not exist yet, which is
 * the only kind of coverage worth having for a rule of the form "always".
 */
import { describe, expect, it } from "vitest";
import { buildCutArgs } from "../processors/cut";
import { buildFiltergraph } from "../reframe/filtergraph";
import type { CropPlan, FilterSpec } from "../reframe/types";

const source = { width: 1920, height: 1080 };

const plans: Record<string, CropPlan> = {
  center: {
    version: 1,
    engine: "faces",
    source,
    shots: [{ start: 0, end: 5, layout: "center", x: 656 }],
  },
  single: {
    version: 1,
    engine: "faces",
    source,
    shots: [{ start: 0, end: 5, layout: "single", x: 600 }],
  },
  split: {
    version: 1,
    engine: "faces",
    source,
    shots: [
      { start: 0, end: 5, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
    ],
  },
  stream: {
    version: 1,
    engine: "faces",
    source,
    stream: {
      camCrop: { w: 1080, h: 608, y: 0 },
      contentCrop: { w: 1080, h: 1080 },
      outCamH: 608,
      outContentH: 1312,
    },
    shots: [
      { start: 0, end: 5, layout: "stream", cam: { x: 0 }, content: { x: 420 } },
    ],
  },
};

/**
 * Every `scale=...` in a graph, paired with the text that follows it.
 *
 * The scale argument itself is matched as "not a comma, semicolon or bracket"
 * rather than as digits: `scale=1080:1920` and a future `scale=w=...:h=...`
 * must both be found. Matching digits only would make this assertion quietly
 * stop seeing a scale it was written to police.
 */
function scaleOccurrences(graph: string): Array<{ scale: string; rest: string }> {
  return [...graph.matchAll(/scale=[^,;[\]]+/g)].map((m) => ({
    scale: m[0],
    rest: graph.slice(m.index! + m[0].length),
  }));
}

function graphsUnderTest(): Array<{ name: string; graph: string }> {
  const rows = Object.entries(plans).map(([name, plan]) => {
    const spec: FilterSpec = buildFiltergraph(plan);
    return { name: `reframe ${name}`, graph: spec.graph };
  });
  // The legacy fallback builds its own filter string that `buildFiltergraph`
  // never sees, and it renders real clips whenever detection fails or
  // REFRAME_ENGINE is off. Reading it out of `buildCutArgs` rather than
  // retyping it is the difference between testing the fallback and testing this
  // file's opinion of the fallback.
  const args = buildCutArgs("in.mp4", 0, 1, "out.mp4");
  const i = args.indexOf("-vf");
  expect(i, "buildCutArgs no longer emits -vf; this test is stale").toBeGreaterThan(-1);
  rows.push({ name: "legacy centre crop", graph: args[i + 1] });
  return rows;
}

describe("output geometry", () => {
  it("finds a scale in every path, so the assertion below cannot pass vacuously", () => {
    for (const { name, graph } of graphsUnderTest()) {
      expect(scaleOccurrences(graph).length, name).toBeGreaterThan(0);
    }
  });

  it.each(graphsUnderTest())(
    "$name: every scale is immediately followed by setsar=1",
    ({ graph }) => {
      for (const { scale, rest } of scaleOccurrences(graph)) {
        expect(
          rest.startsWith(",setsar=1"),
          `"${scale}" is not followed by ",setsar=1" - it is followed by "${rest.slice(0, 24)}"`
        ).toBe(true);
      }
    }
  );

  it("keeps the subtitle burn after the geometry, not between scale and setsar", () => {
    // `ass` draws on the scaled raster. Landing it between the scale and the
    // setsar would still produce a square output but would change what the burn
    // is composited onto, which is a rendering change hiding inside a metadata
    // change.
    const spec = buildFiltergraph(plans.single, "ass=filename=/tmp/x.ass");
    expect(spec.graph).toBe(
      "crop=w=608:h=ih:x='600':y=0,scale=1080:1920,setsar=1,ass=filename=/tmp/x.ass"
    );
  });

  it("the split tiles and the base beneath them all declare square pixels", () => {
    // Specifically pinned because this is the composite case: the tiles are
    // overlaid onto the base and the FINAL tag comes from the base, so a base
    // without setsar ships a non-square file however careful the tiles are.
    // That is exactly the state the stream branch was in before this change.
    const graph = buildFiltergraph(plans.split).graph;
    expect(graph).toContain("scale=1080:1920,setsar=1[base]");
    expect(graph).toContain("scale=1080:960,setsar=1[top]");
    expect(graph).toContain("scale=1080:960,setsar=1[bottom]");
  });
});
