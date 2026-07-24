import { describe, expect, it } from "vitest";
import { buildFiltergraph, piecewiseX } from "../reframe/filtergraph";
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
        "[base][top]overlay=x=0:y=0:enable='between(t,12.40,31.00)'[o1]",
        "[o1][bottom]overlay=x=0:y=960:enable='between(t,12.40,31.00)'[vout]",
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
    expect(spec.graph).toContain("overlay=x=0:y=960:enable='between(t,0.00,20.00)'[o2]");
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
      "enable='between(t,0.00,10.00)+between(t,20.00,30.00)'"
    );
  });
});
