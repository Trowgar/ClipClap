import { describe, expect, it } from "vitest";
import { buildCutArgs } from "../processors/cut";

const OUT = "/tmp/out.mp4";
const LEGACY_CROP = "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920";

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
    expect(args[args.indexOf("-map", firstMap + 1) + 1]).toBe("0:a?");
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
