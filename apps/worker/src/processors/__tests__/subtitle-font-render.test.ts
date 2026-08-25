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

/** Two Japanese strings, three characters each, no spaces - same reasoning as
 *  WORD_A/WORD_B above. "だめか" is the real defect string from the spec
 *  (job cmt8gxsx4: "だめか" rendered as three .notdef boxes under Montserrat). */
const JA_WORD_A = "だめか";
const JA_WORD_B = "今日は";

/** One Hindi word. Real running text (with a virama and a vowel matra, not
 *  bare consonants), from the second job in the spec's blast radius
 *  (cmt7e24cl). Only one word is needed here - the two-different-words half
 *  of the guard is already covered by Arabic and Japanese above; this one
 *  exists to prove Devanagari specifically isn't still landing on Montserrat
 *  tofu. */
const HI_WORD = "नमस्ते";

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

describe("burned Japanese is glyphs, not boxes (spec 2026-08-25-cjk-subtitles)", () => {
  // The mechanism-overcomes-default guard from the spec: a Japanese string
  // burned with the JP face must differ from the SAME string under
  // Montserrat - proof the face fix actually changes the raster, not just
  // the ASS Fontname field.
  it("draws a Japanese word differently under the JP face than under Montserrat", async () => {
    const [ja, latin] = await Promise.all([
      renderHash(JA_WORD_A, "ja"),
      renderHash(JA_WORD_A, "en"),
    ]);
    expect(ja).not.toBe(latin);
  });

  // Two DIFFERENT Japanese strings under the JP face must themselves produce
  // different rasters - proof the face is drawing real glyphs (kana/kanji),
  // not one uniform substitute box per character the way Montserrat did.
  it("draws two different Japanese words differently under the JP face", async () => {
    const [a, b] = await Promise.all([
      renderHash(JA_WORD_A, "ja"),
      renderHash(JA_WORD_B, "ja"),
    ]);
    expect(a).not.toBe(b);
  });

  // The negative control for the pair above: same two words, Montserrat has
  // no CJK glyphs at all, so if the JP-face comparison above were passing by
  // accident (e.g. both strings quietly rendering as nothing) this would
  // catch it by demonstrating the collapse actually happens under a face
  // that truly lacks the glyphs.
  it("collapses those same two Japanese words to one raster under the Latin face", async () => {
    const [a, b] = await Promise.all([
      renderHash(JA_WORD_A, "en"),
      renderHash(JA_WORD_B, "en"),
    ]);
    expect(a).toBe(b);
  });
});

describe("burned Hindi is glyphs, not boxes (spec 2026-08-25-cjk-subtitles)", () => {
  it("draws a Hindi word differently under the Devanagari face than under Montserrat", async () => {
    const [hi, latin] = await Promise.all([
      renderHash(HI_WORD, "hi"),
      renderHash(HI_WORD, "en"),
    ]);
    expect(hi).not.toBe(latin);
  });
});
