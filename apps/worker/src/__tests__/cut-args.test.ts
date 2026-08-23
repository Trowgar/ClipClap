import { describe, expect, it } from "vitest";
import { buildCutArgs } from "../processors/cut";

const OUT = "/tmp/out.mp4";
// `,setsar=1` since 2026-08-08: ih*9/16 is 607.5 on a 1080-tall source, so the
// scale to 1080x1920 tags a non-square SAR unless it is overridden. Spec
// `2026-08-08-output-geometry-design.md`, measurement in engine-notes §7h.
const LEGACY_CROP =
  "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920,setsar=1";

describe("buildCutArgs", () => {
  it("keeps the legacy center crop when no FilterSpec is given", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT);
    expect(args).toContain("-vf");
    expect(args[args.indexOf("-vf") + 1]).toBe(LEGACY_CROP);
    expect(args).not.toContain("-filter_complex");
  });

  it("appends the extra filter to the legacy crop (subtitles path)", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT, "ass=x.ass");
    expect(args[args.indexOf("-vf") + 1]).toBe(`${LEGACY_CROP},ass=x.ass`);
  });

  it("uses the FilterSpec graph verbatim in vf mode, ignoring extraFilter", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT, "ass=x.ass", {
      kind: "vf",
      graph: "crop=w=608:h=ih:x='496':y=0,scale=1080:1920,ass=x.ass",
    });
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "crop=w=608:h=ih:x='496':y=0,scale=1080:1920,ass=x.ass"
    );
  });

  it("switches to -filter_complex with explicit maps in complex mode", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT, undefined, {
      kind: "complex",
      graph: "[0:v]split=3[a][b][c]",
    });
    expect(args).toContain("-filter_complex");
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[0:v]split=3[a][b][c]");
    const firstMap = args.indexOf("-map");
    expect(args[firstMap + 1]).toBe("[vout]");
    expect(args[args.indexOf("-map", firstMap + 1) + 1]).toBe("0:a:0?");
    expect(args).not.toContain("-vf");
  });

  it("always seeks before the input and encodes with the house settings", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT);
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
    expect(args[args.length - 1]).toBe("-y");
    expect(args[args.length - 2]).toBe(OUT);
  });
});

// spec 2026-08-23-music-shorts, task R4: 0.25s video+audio fade in/out, gated
// on the SAME `musicDirection.fades` bit R1/R3 use - the `musicFades` 7th
// param, always undefined above this point, which is the byte-identical
// proof: nothing above this line passes it, and every one of those tests
// still passes.
describe("buildCutArgs music fades (R4)", () => {
  it("adds no fade at all when musicFades is falsy - byte-identical to every existing call", () => {
    const withFalse = buildCutArgs("/tmp/in.mp4", 10, 40, OUT, undefined, null, false);
    const withUndefined = buildCutArgs("/tmp/in.mp4", 10, 40, OUT);
    expect(withFalse).toEqual(withUndefined);
    expect(withFalse).not.toContain("-af");
    expect(withFalse.join(" ")).not.toContain("fade=");
  });

  it("appends a 0.25s in/out video fade to the legacy crop and adds an -af audio fade, timed off (end-start)", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT, undefined, null, true);
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toBe(`${LEGACY_CROP},fade=t=in:st=0:d=0.25,fade=t=out:st=29.750:d=0.25`);
    expect(args[args.indexOf("-af") + 1]).toBe(
      "afade=t=in:st=0:d=0.25,afade=t=out:st=29.750:d=0.25"
    );
  });

  it("appends the fade to a vf-mode FilterSpec's own graph rather than replacing it", () => {
    const args = buildCutArgs("/tmp/in.mp4", 0, 5, OUT, undefined, {
      kind: "vf",
      graph: "crop=w=608:h=ih:x='496':y=0,scale=1080:1920,setsar=1",
    }, true);
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "crop=w=608:h=ih:x='496':y=0,scale=1080:1920,setsar=1,fade=t=in:st=0:d=0.25,fade=t=out:st=4.750:d=0.25"
    );
  });

  it("in complex mode, appends a labelled fade stage and remaps video+audio to it", () => {
    const args = buildCutArgs("/tmp/in.mp4", 0, 5, OUT, undefined, {
      kind: "complex",
      graph: "[0:v]split=3[a][b][c];[a][b]overlay[vout]",
    }, true);
    expect(args).toContain("-filter_complex");
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toBe(
      "[0:v]split=3[a][b][c];[a][b]overlay[vout];[vout]fade=t=in:st=0:d=0.25,fade=t=out:st=4.750:d=0.25[voutfaded];[0:a]afade=t=in:st=0:d=0.25,afade=t=out:st=4.750:d=0.25[aoutfaded]"
    );
    const firstMap = args.indexOf("-map");
    expect(args[firstMap + 1]).toBe("[voutfaded]");
    expect(args[args.indexOf("-map", firstMap + 1) + 1]).toBe("[aoutfaded]");
  });

  it("in complex mode without musicFades, keeps the exact legacy maps ([vout] / 0:a:0?)", () => {
    const args = buildCutArgs("/tmp/in.mp4", 0, 5, OUT, undefined, {
      kind: "complex",
      graph: "[0:v]split=3[a][b][c];[a][b]overlay[vout]",
    });
    const firstMap = args.indexOf("-map");
    expect(args[firstMap + 1]).toBe("[vout]");
    expect(args[args.indexOf("-map", firstMap + 1) + 1]).toBe("0:a:0?");
  });

  it("floors the fade-out start at 0 rather than going negative on a clip shorter than the fade", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 10.1, OUT, undefined, null, true);
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("fade=t=out:st=0.000:d=0.25");
  });
});
