import { describe, expect, it, vi } from "vitest";
import {
  buildFiltergraph,
  piecewiseX,
  planKeyframes,
  rampX,
} from "../reframe/filtergraph";
import type { CropPlan } from "../reframe/types";

const base = (shots: CropPlan["shots"]): CropPlan => ({
  version: 1,
  engine: "faces",
  source: { width: 1920, height: 1080 },
  shots,
});

describe("piecewiseX", () => {
  it("renders a single segment as a bare number", () => {
    expect(piecewiseX([{ end: 30, x: 496 }])).toBe("496");
  });

  it("nests if(lt(t,end)) with 2-decimal times, last x as the else", () => {
    expect(
      piecewiseX([
        { end: 12.4, x: 496 },
        { end: 31, x: 656 },
        { end: 57.5, x: 412 },
      ])
    ).toBe("if(lt(t,12.40),496,if(lt(t,31.00),656,412))");
  });
});

describe("buildFiltergraph", () => {
  it("stays -vf for a single static shot", () => {
    expect(buildFiltergraph(base([{ start: 0, end: 30, layout: "single", x: 496 }])))
      .toEqual({
        kind: "vf",
        graph: "crop=w=608:h=ih:x='496':y=0,scale=1080:1920",
      });
  });

  it("appends the ass snippet in vf mode", () => {
    const spec = buildFiltergraph(
      base([{ start: 0, end: 30, layout: "center", x: 656 }]),
      "ass=filename=/tmp/x.ass"
    );
    expect(spec.graph).toBe(
      "crop=w=608:h=ih:x='656':y=0,scale=1080:1920,ass=filename=/tmp/x.ass"
    );
  });

  it("uses a piecewise x for multiple non-split shots", () => {
    const spec = buildFiltergraph(
      base([
        { start: 0, end: 12.4, layout: "single", x: 496 },
        { start: 12.4, end: 30, layout: "center", x: 656 },
      ])
    );
    expect(spec).toEqual({
      kind: "vf",
      graph: "crop=w=608:h=ih:x='if(lt(t,12.40),496,656)':y=0,scale=1080:1920",
    });
  });

  it("builds the full complex graph for split shots", () => {
    const spec = buildFiltergraph(
      base([
        { start: 0, end: 12.4, layout: "single", x: 496 },
        { start: 12.4, end: 31, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
        { start: 31, end: 57.5, layout: "center", x: 656 },
      ])
    );
    expect(spec.kind).toBe("complex");
    expect(spec.graph).toBe(
      [
        "[0:v]split=3[b0][t0][m0]",
        "[b0]crop=w=608:h=ih:x='if(lt(t,12.40),496,if(lt(t,31.00),656,656))':y=0,scale=1080:1920[base]",
        "[t0]crop=w=1216:h=ih:x='if(lt(t,12.40),0,if(lt(t,31.00),0,0))':y=0,scale=1080:960[top]",
        "[m0]crop=w=1216:h=ih:x='if(lt(t,12.40),704,if(lt(t,31.00),704,704))':y=0,scale=1080:960[bottom]",
        "[base][top]overlay=x=0:y=0:enable='gte(t,12.40)*lt(t,31.00)'[o1]",
        "[o1][bottom]overlay=x=0:y=960:enable='gte(t,12.40)*lt(t,31.00)'[vout]",
      ].join(";")
    );
  });

  it("chains the ass snippet after the overlays in complex mode", () => {
    const spec = buildFiltergraph(
      base([{ start: 0, end: 20, layout: "split", top: { x: 100 }, bottom: { x: 600 } }]),
      "ass=filename=/tmp/x.ass"
    );
    expect(spec.kind).toBe("complex");
    expect(spec.graph.endsWith("[o2];[o2]ass=filename=/tmp/x.ass[vout]")).toBe(true);
    expect(spec.graph).toContain("overlay=x=0:y=960:enable='gte(t,0.00)*lt(t,20.00)'[o2]");
  });

  it("joins multiple split windows with + in enable", () => {
    const spec = buildFiltergraph(
      base([
        { start: 0, end: 10, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
        { start: 10, end: 20, layout: "single", x: 496 },
        { start: 20, end: 30, layout: "split", top: { x: 100 }, bottom: { x: 600 } },
      ])
    );
    expect(spec.graph).toContain(
      "enable='gte(t,0.00)*lt(t,10.00)+gte(t,20.00)*lt(t,30.00)'"
    );
  });
});

describe("stream filtergraph", () => {
  // 1280x720 -> cropW 406, centre 438. Geometry as solveStreamGeometry returns
  // it for the CS2 fixture at camShare 0.40.
  const streamPlan = (): CropPlan => ({
    version: 2,
    engine: "faces",
    source: { width: 1280, height: 720 },
    stream: {
      camCrop: { w: 336, h: 240, y: 0 },
      contentCrop: { w: 676, h: 720 },
      outCamH: 770,
      outContentH: 1150,
    },
    shots: [
      { start: 0, end: 10, layout: "stream", cam: { x: 32 }, content: { x: 428 } },
      { start: 10, end: 20, layout: "center", x: 302 },
    ],
  });

  it("emits a complex graph with both tiles", () => {
    const spec = buildFiltergraph(streamPlan());
    expect(spec.kind).toBe("complex");
    expect(spec.graph).toContain("crop=w=336:h=240");
    expect(spec.graph).toContain("scale=1080:770");
    expect(spec.graph).toContain("crop=w=676:h=ih");
    expect(spec.graph).toContain("scale=1080:1150");
  });

  it("builds the exact stream graph, base crop centred on stream windows", () => {
    expect(buildFiltergraph(streamPlan()).graph).toBe(
      [
        "[0:v]split=3[b0][c0][m0]",
        "[b0]crop=w=406:h=ih:x='if(lt(t,10.00),438,302)':y=0,scale=1080:1920[base]",
        "[c0]crop=w=336:h=240:x='if(lt(t,10.00),32,32)':y=0,scale=1080:770,setsar=1[cam]",
        "[m0]crop=w=676:h=ih:x='if(lt(t,10.00),428,428)':y=0,scale=1080:1150,setsar=1[cont]",
        "[base][cam]overlay=x=0:y=0:enable='gte(t,0.00)*lt(t,10.00)'[o1]",
        "[o1][cont]overlay=x=0:y=770:enable='gte(t,0.00)*lt(t,10.00)'[vout]",
      ].join(";")
    );
  });

  it("pins SAR on every scaled tile", () => {
    // Without this the two tiles carry the SAR `scale` derives from their own
    // crop aspect, so a stacked frame is composed of three different pixel
    // aspects. The design also recorded an ffmpeg 8.x segfault here.
    const graph = buildFiltergraph(streamPlan()).graph;
    expect(graph.match(/setsar=1/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("stacks the content tile directly under the cam tile", () => {
    expect(buildFiltergraph(streamPlan()).graph).toContain("overlay=x=0:y=770");
  });

  it("emits tile heights that sum to the full 1920 output", () => {
    const graph = buildFiltergraph(streamPlan()).graph;
    const heights = [...graph.matchAll(/scale=1080:(\d+),setsar=1/g)].map((m) =>
      Number(m[1])
    );
    expect(heights).toHaveLength(2);
    expect(heights[0] + heights[1]).toBe(1920);
  });

  it("enables the tiles only on stream windows, half-open", () => {
    const graph = buildFiltergraph(streamPlan()).graph;
    expect(graph).toContain("gte(t,0.00)*lt(t,10.00)");
    expect(graph).not.toContain("between(");
  });

  it("joins multiple stream windows and carries the nearest tile geometry", () => {
    const plan = streamPlan();
    plan.shots = [
      { start: 0, end: 10, layout: "stream", cam: { x: 32 }, content: { x: 428 } },
      { start: 10, end: 20, layout: "center", x: 302 },
      { start: 20, end: 30, layout: "stream", cam: { x: 40 }, content: { x: 430 } },
    ];
    const graph = buildFiltergraph(plan).graph;
    expect(graph).toContain(
      "enable='gte(t,0.00)*lt(t,10.00)+gte(t,20.00)*lt(t,30.00)'"
    );
    // The gap window is disabled, so it carries the previous stream geometry.
    expect(graph).toContain("x='if(lt(t,10.00),32,if(lt(t,20.00),32,40))'");
    expect(graph).toContain("x='if(lt(t,10.00),428,if(lt(t,20.00),428,430))'");
  });

  it("appends the subtitle burn last", () => {
    const graph = buildFiltergraph(streamPlan(), "ass=x.ass").graph;
    expect(graph.endsWith("[o2]ass=x.ass[vout]")).toBe(true);
    expect(graph).toContain("overlay=x=0:y=770:enable='gte(t,0.00)*lt(t,10.00)'[o2]");
  });

  it("degrades to the base crop when the stream geometry is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plan = streamPlan();
    delete plan.stream;
    // A stream shot with no geometry cannot be drawn; the base chain's centre
    // crop is the fallback, and it must not throw on the way there.
    expect(buildFiltergraph(plan)).toEqual({
      kind: "vf",
      graph: "crop=w=406:h=ih:x='if(lt(t,10.00),438,302)':y=0,scale=1080:1920",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never mutates the plan or its nested stream geometry", () => {
    // render.ts hands the SAME object to buildFiltergraph and then persists it
    // to Clip.cropPlan, and sliceCropPlan shares `stream` by reference, so any
    // in-place normalisation here would be written to the database.
    const plan = streamPlan();
    const snapshot = structuredClone(plan);
    Object.freeze(plan);
    Object.freeze(plan.source);
    Object.freeze(plan.stream);
    Object.freeze(plan.stream?.camCrop);
    Object.freeze(plan.stream?.contentCrop);
    for (const shot of plan.shots) Object.freeze(shot);
    Object.freeze(plan.shots);
    expect(() => buildFiltergraph(plan)).not.toThrow();
    expect(plan).toEqual(snapshot);
  });

  it("leaves a plan with no stream shots on the existing path", () => {
    const v1: CropPlan = {
      version: 1,
      engine: "faces",
      source: { width: 1920, height: 1080 },
      shots: [{ start: 0, end: 10, layout: "center", x: 656 }],
    };
    expect(buildFiltergraph(v1).kind).toBe("vf");
  });

  it("ignores stream geometry a plan carries without any stream shot", () => {
    const plan = streamPlan();
    plan.shots = [{ start: 0, end: 20, layout: "center", x: 302 }];
    expect(buildFiltergraph(plan)).toEqual({
      kind: "vf",
      graph: "crop=w=406:h=ih:x='302':y=0,scale=1080:1920",
    });
  });
});

describe("rampX", () => {
  it("is a flat sum, never nested, so av_expr depth stays at 1", () => {
    const expr = rampX([
      { t: 0, x: 100 },
      { t: 1, x: 200 },
      { t: 2, x: 150 },
    ]);
    expect(expr).not.toContain("if(");
    expect(expr.startsWith("100")).toBe(true);
  });

  it("emits no term for a flat run", () => {
    expect(
      rampX([
        { t: 0, x: 100 },
        { t: 1, x: 100 },
        { t: 2, x: 100 },
      ])
    ).toBe("100");
  });

  it("expresses an instantaneous step without dividing by zero", () => {
    // Exact output on purpose. This string is not an implementation detail, it
    // is the contract with ffmpeg's expression parser, so if the emitted form
    // ever changes someone should have to look at it and re-measure against
    // real ffmpeg rather than have a loose toContain wave it through.
    //
    // This assertion replaced three not.toContain guards - "/0)", "/0.00)",
    // "NaN", "Infinity" - that were unfalsifiable from the day they were
    // written. They were shaped as a "/0" followed immediately by a CLOSING
    // PAREN, but rampX always emits ",0,1)" after the denominator, so no input
    // could ever produce the substring they looked for. They read as coverage
    // in a test whose name promises exactly the property they did not check.
    // Mutation testing found the test, not the code: deleting STEP_SEC from
    // the denominator left the whole suite green. The three-decimal formatter
    // did not weaken them; they never worked.
    //
    // 0.001 is small enough, measured rather than assumed. At 200fps - five
    // times this step window - the transition on a luma-encoded source read
    // x=499.9 at t=4.495 and t=4.500, then x=200.0 at t=4.505, with no
    // intermediate value at any frame. That is what "sub-frame at any frame
    // rate this product encodes" rests on.
    expect(
      rampX([
        { t: 1, x: 100 },
        { t: 1, x: 400 },
      ])
    ).toBe("100+300*clip((t-1.000)/0.001,0,1)");
  });

  it("throws on an empty trajectory rather than emitting an empty expression", () => {
    expect(() => rampX([])).toThrow("rampX: empty");
  });
});

describe("planKeyframes", () => {
  it("uses the centre for split and stream shots, whose tiles cover the frame", () => {
    const keys = planKeyframes(
      {
        version: 2,
        engine: "faces",
        source: { width: 1280, height: 720 },
        shots: [
          { start: 0, end: 5, layout: "split", top: { x: 0 }, bottom: { x: 800 } },
        ],
      },
      437
    );
    expect(keys.every((k) => k.x === 437)).toBe(true);
  });

  it("carries a trajectory through and a plain single as a flat pair", () => {
    const keys = planKeyframes(
      {
        version: 3,
        engine: "faces",
        source: { width: 1280, height: 720 },
        shots: [
          { start: 0, end: 5, layout: "single", x: 100 },
          {
            start: 5,
            end: 10,
            layout: "single",
            x: 300,
            xs: [
              { t: 5, x: 300 },
              { t: 10, x: 500 },
            ],
          },
        ],
      },
      437
    );
    expect(keys[0]).toEqual({ t: 0, x: 100 });
    expect(keys.at(-1)).toEqual({ t: 10, x: 500 });
  });

  it("still emits a flat pair for a shot whose xs is empty next to one that has a trajectory", () => {
    // The empty array is not a trajectory, it is the absence of one, so the
    // shot falls back to its own `x`. Drop the `.length > 0` guard and this
    // shot contributes NO keyframes at all: the ramp holds the previous shot's
    // 500 straight across 10..15 and the window it asked for never happens.
    // The `buildFiltergraph` empty-xs test cannot see this - there the only
    // shot has xs: [], so hasTrajectory is false and planKeyframes is never
    // entered. It has to be asserted here, on a MIXED plan.
    const keys = planKeyframes(
      {
        version: 3,
        engine: "faces",
        source: { width: 1280, height: 720 },
        shots: [
          {
            start: 0,
            end: 10,
            layout: "single",
            x: 300,
            xs: [
              { t: 0, x: 300 },
              { t: 10, x: 500 },
            ],
          },
          { start: 10, end: 15, layout: "single", x: 120, xs: [] },
        ],
      },
      437
    );
    expect(keys).toEqual([
      { t: 0, x: 300 },
      { t: 10, x: 500 },
      { t: 10, x: 120 },
      { t: 15, x: 120 },
    ]);
  });
});

describe("buildFiltergraph motion selection", () => {
  const planWithXs = {
    version: 3 as const,
    engine: "faces" as const,
    source: { width: 1280, height: 720 },
    shots: [
      {
        start: 0,
        end: 10,
        layout: "single" as const,
        x: 100,
        xs: [
          { t: 0, x: 100 },
          { t: 10, x: 500 },
        ],
      },
    ],
  };
  const planWithout = {
    version: 1 as const,
    engine: "faces" as const,
    source: { width: 1280, height: 720 },
    shots: [{ start: 0, end: 10, layout: "single" as const, x: 100 }],
  };

  it("uses the nested piecewise form when no shot has a trajectory", () => {
    const spec = buildFiltergraph(planWithout);
    expect(spec.graph).toContain("x='100'");
    expect(spec.graph).not.toContain("clip(");
  });

  it("uses the ramp form when a shot has a trajectory", () => {
    const spec = buildFiltergraph(planWithXs);
    expect(spec.graph).toContain("clip(");
    expect(spec.graph).not.toContain("if(lt(t,");
  });

  it("a plan with xs stripped compiles byte-identically to the legacy plan", () => {
    // The rollback invariant: a consumer that ignores xs must render v2 output,
    // and 96 crop plans already persisted must keep rendering identically.
    const stripped = {
      ...planWithXs,
      shots: planWithXs.shots.map(({ xs, ...rest }) => rest),
    };
    expect(buildFiltergraph(stripped).graph).toBe(buildFiltergraph(planWithout).graph);
  });

  it("ignores an empty xs array and stays on the legacy form", () => {
    const empty = {
      ...planWithXs,
      shots: [{ ...planWithXs.shots[0], xs: [] }],
    };
    expect(buildFiltergraph(empty).graph).toBe(buildFiltergraph(planWithout).graph);
  });
});
