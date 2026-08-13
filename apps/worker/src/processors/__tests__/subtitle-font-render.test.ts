import { execFile } from "child_process";
import { createHash } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubtitleCue } from "@clipclap/shared";
import { generateAss, resolveFontsDir } from "../subtitles";

const execFileAsync = promisify(execFile);

/** Two Arabic words, six characters each, no spaces.
 *
 *  Equal length and no spaces are both load-bearing. Under a face with no
 *  Arabic glyphs every character draws the SAME .notdef box, so two strings
 *  that differ only in which letters they use collapse to an identical raster
 *  - but only if they have the same number of boxes in the same places. A
 *  space at a different index would separate the rasters for the wrong
 *  reason and the test would pass over a broken font. */
const WORD_A = "التركي";
const WORD_B = "مواجهة";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipclap-fonttest-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Burns one cue onto a blank canvas through the real ass filter and returns
 *  the md5 of the resulting PNG. Same canvas, same position, same duration for
 *  every call, so the only thing that can move the hash is the drawn glyphs. */
async function renderHash(text: string, language: string): Promise<string> {
  // `id` is required by SubtitleCue and is never drawn, so a constant keeps
  // the two renders differing only in the glyphs.
  const cue: SubtitleCue = { id: "probe", text, start: 0, end: 1 };
  const assPath = join(dir, `${language}-${text}.ass`);
  const pngPath = join(dir, `${language}-${text}.png`);
  await writeFile(assPath, generateAss([cue], language), "utf-8");

  const escape = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
  await execFileAsync("ffmpeg", [
    "-nostdin",
    "-v", "error",
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=1080x1920:d=1",
    "-vf", `ass=filename=${escape(assPath)}:fontsdir=${escape(resolveFontsDir())}`,
    "-frames:v", "1",
    pngPath,
  ]);

  return createHash("md5").update(await readFile(pngPath)).digest("hex");
}

describe("burned Arabic is glyphs, not boxes", () => {
  // If ffmpeg is missing this test cannot say anything, and a silent skip is
  // how a guard becomes decorative. Fail loudly instead: worker containers
  // have ffmpeg, and that is where this suite is meant to run.
  it("has ffmpeg available", async () => {
    await expect(execFileAsync("ffmpeg", ["-version"])).resolves.toBeDefined();
  });

  it("draws two different Arabic words differently", async () => {
    const [a, b] = await Promise.all([
      renderHash(WORD_A, "ar"),
      renderHash(WORD_B, "ar"),
    ]);
    expect(a).not.toBe(b);
  });

  // The negative control, and the reason the assertion above means anything:
  // it demonstrates that the comparison DOES collapse when the face lacks the
  // glyphs, so a passing test above is evidence and not a coincidence.
  it("collapses those same two words to one raster under the Latin face", async () => {
    const [a, b] = await Promise.all([
      renderHash(WORD_A, "en"),
      renderHash(WORD_B, "en"),
    ]);
    expect(a).toBe(b);
  });
});
