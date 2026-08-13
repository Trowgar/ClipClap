# Arabic Locale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arabic-language clips get readable burned subtitles, and the Telegram bot speaks Arabic.

**Architecture:** Two independently shippable parts. Part A (Tasks 1-8) makes the subtitle font a value
of the clip's *script* rather than a module constant, and vendors an Arabic-capable font; every
non-Arabic render stays byte-identical because the lookup returns the same literal `"Montserrat"`.
Part A was also going to make the cue-length budget script-keyed - Task 7 measured that premise and
refuted it, so it does not. Part B (Tasks 9-15) adds `"ar"` to the single `LOCALES` list,
which turns three `Record<Locale, ...>` sites into compile errors and fourteen existing assertions red,
then fills them in.

**Tech Stack:** TypeScript, vitest, ffmpeg/libass (with fribidi + harfbuzz), Prisma, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-13-arabic-locale-design.md`

---

## Environment: how to run anything

Host Node is v18 and **cannot run vitest**. Every test, typecheck and script runs inside a container.
The repo is bind-mounted at `/app`, so edits on the host are visible immediately.

```bash
# worker tests (ffmpeg is available in this container - the pixel test needs it)
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . <path>'

# bot tests
docker compose exec -T bot sh -c 'cd /app && ./node_modules/.bin/vitest run --root . <path>'

# typecheck
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
docker compose exec -T bot sh -c 'cd /app/apps/bot && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```

Always end a typecheck with `; echo "tsc=$?"`. Piping `tsc` into `tail` reports `tail`'s exit code and
has already produced a false "OK" over two real type errors in this repo.

**Do not edit files under `apps/worker/src/` or `apps/bot/src/` while a real user's job is running.**
`tsx watch` restarts the worker on every save and kills the render mid-encode. Check first:

```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c \
  "SELECT id, status FROM jobs WHERE status NOT IN ('DONE','FAILED');"
```

Empty result means it is safe to work.

---

## File structure

| file | responsibility |
|---|---|
| `apps/worker/assets/fonts/Tajawal-Bold.ttf` | new. The Arabic face. Vendored, like Montserrat. |
| `apps/worker/assets/OFL.txt` | modify. Add Tajawal's copyright line. |
| `apps/worker/src/processors/subtitle-script.ts` | new. The only place that knows a language maps to a font. Pure, no I/O. |
| `apps/worker/src/processors/__tests__/subtitle-script.test.ts` | new. Unit tests for the lookup. |
| `apps/worker/src/processors/__tests__/subtitle-font-render.test.ts` | new. The pixel oracle: proves the burn is not `.notdef` boxes. |
| `apps/worker/src/processors/subtitles.ts` | modify. Threads an optional `language` through `generateAss`, `createAssFilter`, `burnSubtitles`. `chunkWords` is NOT touched - see Task 7. |
| `apps/worker/src/stages/render.ts` | modify. Supplies the language on both the clips path and the trim path. |
| `apps/worker/src/scripts/eval-rerender.ts` | modify. Same language, so a re-render reproduces the original. |
| `apps/worker/src/scripts/measure-arabic-width.ts` | temporary. Produced the width measurement in Task 7, then deleted. |
| `packages/shared/src/i18n/bidi.ts` | new. `isolate()` for interpolating non-Arabic runs into RTL text. |
| `packages/shared/src/i18n/index.ts` | modify. Export the new module. |
| `packages/shared/src/__tests__/bidi.test.ts` | new. |
| `packages/shared/src/i18n/locales.ts` | modify. One string: `"ar"`. |
| `apps/bot/src/i18n/ar.ts` | new. 104 `Dict` keys + a 5-entry `JobErrorCode` map, MSA. |
| `apps/bot/src/i18n/index.ts` | modify. Register `ar`; add `LANG_ALIASES`. |
| `packages/shared/src/services/telegram-notification.service.ts` | modify. `PAYMENT_COPY.ar`. |
| `apps/bot/src/__tests__/i18n.test.ts` | modify. Four new assertions. |

---

# PART A - the render path

## Task 1: Vendor the Arabic font

**Files:**
- Create: `apps/worker/assets/fonts/Tajawal-Bold.ttf`
- Modify: `apps/worker/assets/OFL.txt`

- [ ] **Step 1: Fetch the font**

```bash
cd /srv/dev/clipclap.io
curl -sL -o apps/worker/assets/fonts/Tajawal-Bold.ttf \
  "https://github.com/google/fonts/raw/main/ofl/tajawal/Tajawal-Bold.ttf"
```

- [ ] **Step 2: Verify what landed**

```bash
ls -l apps/worker/assets/fonts/Tajawal-Bold.ttf
file apps/worker/assets/fonts/Tajawal-Bold.ttf
```

Expected: 59988 bytes, and `file` reports `TrueType Font data`. If the size is ~300000 and `file` says
`HTML`, the fetch got a GitHub 404 page - stop and fix the URL rather than committing an HTML file
with a `.ttf` name.

- [ ] **Step 3: Confirm the container sees it**

The repo is bind-mounted, so no rebuild is needed:

```bash
docker compose exec -T worker-render ls -l /app/apps/worker/assets/fonts/
```

Expected: both `Montserrat-Bold.ttf` and `Tajawal-Bold.ttf`.

- [ ] **Step 4: Record the licence**

Append to the end of `apps/worker/assets/OFL.txt`:

```
================================================================================
Tajawal - Copyright (c) 2016 The Tajawal Project Authors
(https://github.com/google/fonts/tree/main/ofl/tajawal)

Licensed under the SIL Open Font License, Version 1.1, reproduced above.
Vendored for burned-in Arabic subtitles: libass cannot fall back to a second
face because fontconfig has no font database inside the worker image, so the
Arabic face has to be named explicitly. See
docs/superpowers/specs/2026-08-13-arabic-locale-design.md §2.2.
================================================================================
```

- [ ] **Step 5: Commit**

```bash
git add apps/worker/assets/fonts/Tajawal-Bold.ttf apps/worker/assets/OFL.txt
git commit -m "assets(render): vendor Tajawal Bold for Arabic subtitles"
```

---

## Task 2: The script lookup module

One module owns the language-to-font decision, so no caller has to know the rule and there is exactly
one place to change when a fourth script arrives.

> **Superseded in part.** As written below this task also builds `maxChunkCharsForLanguage` and
> `ARABIC_MAX_CHUNK_CHARS`. Task 7 measured the premise behind those and refuted it, and commit
> `97b4cc5` removed them. The steps are left intact because they are what was actually run; read Task 7
> before treating them as current.

**Files:**
- Create: `apps/worker/src/processors/subtitle-script.ts`
- Test: `apps/worker/src/processors/__tests__/subtitle-script.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/processors/__tests__/subtitle-script.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ARABIC_FONT_NAME,
  DEFAULT_FONT_NAME,
  DEFAULT_MAX_CHUNK_CHARS,
  fontForLanguage,
  maxChunkCharsForLanguage,
} from "../subtitle-script";

describe("fontForLanguage", () => {
  it("uses the Arabic face for every language written in Arabic script", () => {
    for (const code of ["ar", "fa", "ur", "ps"]) {
      expect(fontForLanguage(code)).toBe(ARABIC_FONT_NAME);
    }
  });

  it("uses the default face for everything else", () => {
    for (const code of ["en", "ru", "uk", "es", "pt", "id", "hi", "km", "he"]) {
      expect(fontForLanguage(code)).toBe(DEFAULT_FONT_NAME);
    }
  });

  // Job.language is nullable and Whisper has returned region tags and mixed
  // case. An unknown value must land on today's behaviour, never throw.
  it("falls back to the default face for missing or unknown values", () => {
    expect(fontForLanguage(undefined)).toBe(DEFAULT_FONT_NAME);
    expect(fontForLanguage(null)).toBe(DEFAULT_FONT_NAME);
    expect(fontForLanguage("")).toBe(DEFAULT_FONT_NAME);
    expect(fontForLanguage("zzz")).toBe(DEFAULT_FONT_NAME);
  });

  it("normalises case and region subtags", () => {
    expect(fontForLanguage("AR")).toBe(ARABIC_FONT_NAME);
    expect(fontForLanguage("ar-SA")).toBe(ARABIC_FONT_NAME);
    expect(fontForLanguage("fa_IR")).toBe(ARABIC_FONT_NAME);
    expect(fontForLanguage("  ar  ")).toBe(ARABIC_FONT_NAME);
  });
});

describe("maxChunkCharsForLanguage", () => {
  it("keeps today's budget for non-Arabic languages", () => {
    expect(maxChunkCharsForLanguage("en")).toBe(DEFAULT_MAX_CHUNK_CHARS);
    expect(maxChunkCharsForLanguage("ru")).toBe(DEFAULT_MAX_CHUNK_CHARS);
    expect(maxChunkCharsForLanguage(null)).toBe(DEFAULT_MAX_CHUNK_CHARS);
  });

  // The number itself is set in Task 7 from a measurement. What this pins is
  // that Arabic gets a LARGER budget than the Cyrillic-calibrated default -
  // Arabic runs about half the width per character, so reusing 18 splits
  // phrases that would fit.
  it("gives Arabic script a wider budget than the default", () => {
    expect(maxChunkCharsForLanguage("ar")).toBeGreaterThan(DEFAULT_MAX_CHUNK_CHARS);
    expect(maxChunkCharsForLanguage("fa")).toBe(maxChunkCharsForLanguage("ar"));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src/processors/__tests__/subtitle-script.test.ts'
```

Expected: FAIL, `Failed to resolve import "../subtitle-script"`.

- [ ] **Step 3: Write the module**

Create `apps/worker/src/processors/subtitle-script.ts`:

```ts
/** Which face draws a clip's subtitles, and how many characters fit on a line.
 *
 *  Both used to be constants in subtitles.ts, and both were calibrated on
 *  Latin and Cyrillic alone. That was invisible until an Arabic source came
 *  through: Montserrat has no Arabic glyphs, fontconfig inside the worker
 *  image has NO font database at all, and libass therefore cannot fall back -
 *  it draws .notdef boxes. Measured, both branches, see the spec §2.2. The
 *  only fix is to name the face explicitly, which is what this module is for.
 *
 *  Keyed on SCRIPT rather than on language: one file serves Arabic, Persian,
 *  Urdu and Pashto, and `fa` has already appeared in this database. */

export const DEFAULT_FONT_NAME = "Montserrat";
export const ARABIC_FONT_NAME = "Tajawal";

/** The Cyrillic-calibrated budget, unchanged. Its derivation lives in the
 *  comment on MAX_CHUNK_WORDS in subtitles.ts. */
export const DEFAULT_MAX_CHUNK_CHARS = 18;

/** Set by measurement in Task 7 of the Arabic plan. Placeholder value here is
 *  deliberately just above the default so the intent is visible; the real
 *  figure and the strings it came from replace this comment. */
export const ARABIC_MAX_CHUNK_CHARS = 19;

/** Primary subtags, lowercase. Whisper returns ISO-639-1, and all four of
 *  these are in its language set. */
const ARABIC_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set([
  "ar",
  "fa",
  "ur",
  "ps",
]);

/** Job.language is nullable and has held region tags. Anything unrecognised
 *  must land on the pre-existing behaviour: an unknown language rendering in
 *  Montserrat is exactly what shipped before, whereas a throw here would fail
 *  a render over a metadata value. */
function isArabicScript(language?: string | null): boolean {
  const primary = language?.trim().toLowerCase().split(/[-_]/)[0];
  return primary ? ARABIC_SCRIPT_LANGUAGES.has(primary) : false;
}

export function fontForLanguage(language?: string | null): string {
  return isArabicScript(language) ? ARABIC_FONT_NAME : DEFAULT_FONT_NAME;
}

export function maxChunkCharsForLanguage(language?: string | null): number {
  return isArabicScript(language)
    ? ARABIC_MAX_CHUNK_CHARS
    : DEFAULT_MAX_CHUNK_CHARS;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src/processors/__tests__/subtitle-script.test.ts'
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors/subtitle-script.ts apps/worker/src/processors/__tests__/subtitle-script.test.ts
git commit -m "feat(render): script-keyed subtitle font and cue budget lookup"
```

---

## Task 3: Thread the language into the ASS writer

**Files:**
- Modify: `apps/worker/src/processors/subtitles.ts`
- Test: `apps/worker/src/processors/__tests__/subtitles.test.ts`

The new parameter is **optional and trailing** on every function. That is what keeps the 92 existing
tests and the four eval scripts compiling unchanged, and it makes "language absent" mean exactly what
shipped before.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/processors/__tests__/subtitles.test.ts`, inside the existing
`describe("generateAss", ...)` block (it already has `const cues = segmentsToCues(segments, 10.0, 25.0);`
in scope):

```ts
  it("names the default face when no language is given", () => {
    expect(generateAss(cues)).toContain("Style: Default,Montserrat,");
  });

  it("names the default face for a non-Arabic language", () => {
    expect(generateAss(cues, "ru")).toContain("Style: Default,Montserrat,");
  });

  // The whole point of the change: an Arabic clip must not be drawn with a
  // face that has no Arabic glyphs.
  it("names the Arabic face for an Arabic-script language", () => {
    expect(generateAss(cues, "ar")).toContain("Style: Default,Tajawal,");
    expect(generateAss(cues, "fa")).toContain("Style: Default,Tajawal,");
  });

  // Byte-identity is the safety claim for every existing clip: the frozen
  // render baselines only stay valid if the style line does not move a
  // character when the language is not Arabic.
  it("produces a byte-identical file with no language and with a Latin one", () => {
    expect(generateAss(cues, "en")).toBe(generateAss(cues));
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src/processors/__tests__/subtitles.test.ts -t "Arabic face"'
```

Expected: FAIL. `generateAss(cues, "ar")` still contains `Montserrat` because the second argument is
ignored.

- [ ] **Step 3: Add the import**

In `apps/worker/src/processors/subtitles.ts`, next to the existing imports:

```ts
import { fontForLanguage } from "./subtitle-script";
```

- [ ] **Step 4: Take the language in `generateAss`**

Replace the `generateAss` signature and its first two lines. Find:

```ts
export function generateAss(cues: SubtitleCue[]): string {
  const s = DEFAULT_STYLE;
```

Replace with:

```ts
export function generateAss(
  cues: SubtitleCue[],
  // The clip's spoken language, not the user's interface locale. Optional and
  // trailing so every existing caller keeps compiling, and so an absent value
  // reproduces the pre-Arabic output character for character.
  language?: string | null
): string {
  const s = { ...DEFAULT_STYLE, fontName: fontForLanguage(language) };
```

`DEFAULT_STYLE.fontName` stays where it is: it is the value `fontForLanguage` returns for everything
that is not Arabic script, and leaving it there keeps the style's shape in one readable place.

- [ ] **Step 5: Pass it on from `createAssFilter`**

Find:

```ts
export async function createAssFilter(
  cues: SubtitleCue[]
): Promise<{ filter: string; assPath: string }> {
  const assPath = join(tmpdir(), `clipclap-subs-${randomUUID()}.ass`);
  await writeFile(assPath, generateAss(cues), "utf-8");
```

Replace with:

```ts
export async function createAssFilter(
  cues: SubtitleCue[],
  language?: string | null
): Promise<{ filter: string; assPath: string }> {
  const assPath = join(tmpdir(), `clipclap-subs-${randomUUID()}.ass`);
  await writeFile(assPath, generateAss(cues, language), "utf-8");
```

- [ ] **Step 6: Pass it on from `burnSubtitles`**

Find:

```ts
export async function burnSubtitles(
  videoPath: string,
  cues: SubtitleCue[]
): Promise<string> {
  const assContent = generateAss(cues);
```

Replace with:

```ts
export async function burnSubtitles(
  videoPath: string,
  cues: SubtitleCue[],
  language?: string | null
): Promise<string> {
  const assContent = generateAss(cues, language);
```

- [ ] **Step 7: Run the whole subtitles suite**

```bash
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: PASS, 96 tests (92 existing + 4 new). If any of the 92 fail, the change was not
behaviour-preserving - fix that before continuing rather than updating the assertion.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/processors/subtitles.ts apps/worker/src/processors/__tests__/subtitles.test.ts
git commit -m "feat(render): generateAss picks the face from the clip language"
```

---

## Task 4: The pixel oracle

The only test that would have caught the original bug. `.notdef` boxes are all the same glyph, so two
*different* Arabic words of the same length render to a byte-identical PNG under a face without Arabic,
and to different PNGs under one with it. Both branches were confirmed on this host before this plan was
written:

```
Montserrat  التركي / مواجهة  ->  md5 0857507efe41293964b6975563f771d2 for BOTH
Tajawal     التركي / مواجهة  ->  md5 7547eaa1... and bf0ea2b0...
```

**Files:**
- Create: `apps/worker/src/processors/__tests__/subtitle-font-render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it**

```bash
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src/processors/__tests__/subtitle-font-render.test.ts'
```

Expected: PASS, 3 tests. Task 3 already made the Arabic path pick Tajawal, so this goes green
immediately - which is exactly why Step 3 exists.

- [ ] **Step 3: Mutation-test the oracle**

A rendering assertion that passes for the wrong reason is worthless, and this repo has already shipped
two green tests that measured nothing. Break the implementation on purpose and require the failure.

In `apps/worker/src/processors/subtitle-script.ts`, temporarily change:

```ts
export const ARABIC_FONT_NAME = "Tajawal";
```

to:

```ts
export const ARABIC_FONT_NAME = "Montserrat";
```

Re-run the command from Step 2.

Expected: the test `draws two different Arabic words differently` **FAILS**. If it passes, the oracle is
broken - stop and fix the test, not the implementation.

- [ ] **Step 4: Restore**

```bash
git diff apps/worker/src/processors/subtitle-script.ts   # confirm only that line moved
git checkout apps/worker/src/processors/subtitle-script.ts
```

Re-run Step 2 and confirm all 3 pass again.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors/__tests__/subtitle-font-render.test.ts
git commit -m "test(render): pixel oracle proving Arabic subtitles are glyphs, not tofu

Mutation-tested: pointing ARABIC_FONT_NAME back at Montserrat fails it."
```

---

## Task 5: Supply the language on the clips render path

**Files:**
- Modify: `apps/worker/src/stages/render.ts`

`renderClips` loads the full job row (`prisma.job.findUniqueOrThrow` with no `select`), so `job.language`
is already in scope. Individual highlights also carry a language, which is the more precise value when a
source mixes languages.

- [ ] **Step 1: Declare the clip language at the top of the highlight loop**

It is declared here, above `segmentsToCues`, because Task 8 needs it there too. Find, inside
`for (const highlight of highlights) {`:

```ts
      // Derived even when subtitles are off so the editor can enable them later
      const cues = segmentsToCues(
```

Insert immediately **above** that comment:

```ts
      // The face is chosen from the language actually SPOKEN in this clip.
      // The highlight's own language wins over the job's because a source can
      // switch language partway through and the job carries only the dominant
      // one; both are nullable and an absent value keeps the Latin face.
      const clipLanguage = highlight.language ?? job.language;
```

- [ ] **Step 2: Pass it to `createAssFilter` on the clips path**

Around line 138, find:

```ts
        assFilter = await createAssFilter(cues);
```

Replace with:

```ts
        assFilter = await createAssFilter(cues, clipLanguage);
```

- [ ] **Step 3: Typecheck**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```

Expected: `tsc=0`. If `highlight.language` is not on the type, read the highlight type in
`apps/worker/src/stages/render.ts` where `language: highlight.language ?? null` is already written when
the clip row is created (around line 258) and use the same expression.

- [ ] **Step 4: Supply the language on the trim path**

`renderTrim` works from the queue payload and never loads the job. The clip row carries the language
(`clips.language` is populated: 115 `ru`, 68 `en`, 10 `pt`, 3 `ar`, 13 null in production today), and its
job is the fallback for the nulls.

Find, in `renderTrim`:

```ts
    const editedCues = payload.subtitleTrack?.cues ?? [];
    const windowedCues = sliceCues(editedCues, payload.start, payload.end);
    const wantSubs = payload.subtitles && windowedCues.length > 0;
```

Append immediately after:

```ts
    // The trim payload predates Arabic and carries no language, so read it.
    // One query, and only when something is actually going to be drawn.
    // clips.language is null on 13 rows in production, hence the job fallback.
    const trimLanguage = wantSubs
      ? await prisma.clip
          .findUnique({
            where: { id: payload.clipId },
            select: { language: true, job: { select: { language: true } } },
          })
          // Both `?.` are load-bearing. `row?.job.language` would THROW when
          // the row exists without its relation - which is exactly what a
          // mocked findUnique returns - and the catch below would swallow it
          // into a silent null, i.e. the Latin face on every trim, passing
          // every test.
          .then((row) => row?.language ?? row?.job?.language ?? null)
          .catch(() => null)
      : null;
```

The `.catch(() => null)` is for a genuinely unavailable row, not for a programming error above it. Verify
the happy path returns a language rather than relying on the catch: the test in Step 6 must assert the
language that actually reaches `burnSubtitles`.

- [ ] **Step 5: Use it at both trim burn sites**

Find:

```ts
        assFilter = await createAssFilter(windowedCues);
```

Replace with:

```ts
        assFilter = await createAssFilter(windowedCues, trimLanguage);
```

Find:

```ts
        const subbedPath = await burnSubtitles(trimmedPath, windowedCues);
```

Replace with:

```ts
        const subbedPath = await burnSubtitles(trimmedPath, windowedCues, trimLanguage);
```

- [ ] **Step 6: Typecheck and run the render suites**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src/__tests__/render-trim-fallback.test.ts apps/worker/src/__tests__/render-clips-subtitles.test.ts'
```

Expected: `tsc=0`, both suites PASS.

`render-trim-fallback.test.ts` asserts `burnSubtitles` was called with specific arguments. It will now
receive a third. The existing assertion, around line 189, is:

```ts
    expect(mocks.burnSubtitles).toHaveBeenCalledWith(
      "/tmp/trimmed-clip.mp4",
      fallbackPayload.subtitleTrack.cues
    );
```

That file already mocks `prisma.clip.findUnique` as `mocks.clipFindUnique`. Make the test prove the
language actually arrives, rather than just tolerating a third argument:

```ts
    mocks.clipFindUnique.mockResolvedValue({ language: "ar", job: { language: "en" } });
```

set before the `runRenderStage` call, and then:

```ts
    expect(mocks.burnSubtitles).toHaveBeenCalledWith(
      "/tmp/trimmed-clip.mp4",
      fallbackPayload.subtitleTrack.cues,
      "ar"
    );
```

Do **not** loosen it to `expect.anything()`, and do not accept `null` as the third argument - a null
there means the lookup silently failed and every Arabic trim would burn in the Latin face while the
test stayed green.

Add a second case pinning the fallback, because that branch is what covers the 13 clip rows whose
`language` is null in production:

```ts
  it("falls back to the job language when the clip row has none", async () => {
    mocks.clipFindUnique.mockResolvedValue({ language: null, job: { language: "fa" } });
    await runRenderStage({ ...fallbackPayload, originalHasBurnedSubtitles: false });
    expect(mocks.burnSubtitles).toHaveBeenCalledWith(
      "/tmp/trimmed-clip.mp4",
      fallbackPayload.subtitleTrack.cues,
      "fa"
    );
  });
```

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/stages/render.ts apps/worker/src/__tests__/render-trim-fallback.test.ts
git commit -m "feat(render): pass the clip language to the subtitle burn on both paths"
```

---

## Task 5b: Pin the clips path too

Added during execution. After Task 5, mutating `createAssFilter(cues, clipLanguage)` back to
`createAssFilter(cues)` left **all 1433 tests green** - verified twice, independently. The trim path is
pinned by Task 5's assertions; the clips path, which is the one that produces every clip a user
actually receives, is not pinned at all. Task 4's pixel oracle proves the burn draws Arabic when it is
handed a language; nothing proves `renderClips` hands it one.

That is the exact shape of defect this repo has shipped twice before: a green test that measures nothing.

**Files:**
- Modify: `apps/worker/src/__tests__/render-clips-subtitles.test.ts`

- [ ] **Step 1: Spy on `createAssFilter` without losing the real cue derivation**

The suite deliberately runs the real `segmentsToCues`, so the module cannot be wholesale-mocked. Add to
the `vi.hoisted` mocks object:

```ts
  createAssFilter: vi.fn(),
```

and, next to the other `vi.mock` calls:

```ts
// Partial: segmentsToCues stays real, because these tests depend on it deciding
// whether a highlight has cues in range at all. Only the burn entry point is
// swapped, so the language it receives can be asserted.
vi.mock("../processors/subtitles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../processors/subtitles")>();
  return { ...actual, createAssFilter: mocks.createAssFilter };
});
```

In `beforeEach`, give it a return value of the right shape:

```ts
    mocks.createAssFilter.mockResolvedValue({
      filter: "ass=filename=/tmp/fake.ass",
      assPath: "/tmp/fake.ass",
    });
```

- [ ] **Step 2: Assert the language reaches the burn**

```ts
  it("hands the highlight's language to the subtitle burn", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      id: "job1",
      normalizedArtifactKey: null,
      sourceArtifactKey: "work/u1/job1/source.mp4",
      language: "en",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 100, end: 105, text: "hello" }],
      },
      highlights: [{ ...highlight, language: "ar" }],
      subtitles: true,
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.createAssFilter).toHaveBeenCalledWith(expect.anything(), "ar");
  });

  // The 13 production clip rows with a null language are covered by this
  // branch, and a job-level language is what an Arabic source without
  // per-highlight detection would carry.
  it("falls back to the job language when the highlight has none", async () => {
    mocks.jobFindUniqueOrThrow.mockResolvedValue({
      id: "job1",
      normalizedArtifactKey: null,
      sourceArtifactKey: "work/u1/job1/source.mp4",
      language: "ar",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 100, end: 105, text: "hello" }],
      },
      highlights: [highlight],
      subtitles: true,
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.createAssFilter).toHaveBeenCalledWith(expect.anything(), "ar");
  });
```

- [ ] **Step 3: Mutation-test both new assertions**

Neither is trusted until it has been seen to fail.

1. In `render.ts`, change `createAssFilter(cues, clipLanguage)` to `createAssFilter(cues)`. Both new
   tests must FAIL. Revert.
2. Change `highlight.language ?? job.language` to `job.language`. Only the FIRST must fail. Revert.
3. Change it to `highlight.language`. Only the SECOND must fail. Revert.

If any mutation leaves both green, the assertion is not measuring what it claims.

- [ ] **Step 4: Run and commit**

```bash
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src'
git add apps/worker/src/__tests__/render-clips-subtitles.test.ts
git commit -m "test(render): pin the language reaching the burn on the clips path"
```

---

## Task 6: Keep the re-render script faithful

`eval-rerender.ts` exists to reproduce a clip exactly. If it does not pass the language it will now
produce a *different* file from the one production made, which is the opposite of its purpose.

**Files:**
- Modify: `apps/worker/src/scripts/eval-rerender.ts`

- [ ] **Step 1: Find the two call sites**

```bash
grep -n "segmentsToCues\|createAssFilter" apps/worker/src/scripts/eval-rerender.ts
```

Expected: hits around lines 242, 252 and 420.

- [ ] **Step 2: Pass the clip's language to `createAssFilter`**

At the site around line 252, find:

```ts
      assFilter = await createAssFilter(cues);
```

Replace with:

```ts
      // Same face the original render chose, or this script reproduces a
      // different file than the one it is supposed to be checking.
      assFilter = await createAssFilter(cues, clip.language ?? job.language);
```

- [ ] **Step 3: Typecheck**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```

Expected: `tsc=0`. If `clip` or `job` is not the local variable name at that point in the file, read the
surrounding 30 lines and use whatever the script already holds - it loads both rows to rebuild the
render, so a language is reachable.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/scripts/eval-rerender.ts
git commit -m "fix(eval): re-render reproduces the original face"
```

---

## Task 7: Measure the Arabic cue budget - DONE, and it refuted the premise

Run during execution. The measurement script was written, run against the real `ass` burn, and deleted.

Result, over 18 Arabic samples of 8 to 31 characters against the 19-Cyrillic-character reference of
715px: the widest Arabic sample runs **36.8 px/char** against Cyrillic's **37.6**, every sample of 20
characters or fewer fits, 22 is mixed on the same character count, and 23+ never fits.

The two scripts are within a few percent. `MAX_CHUNK_CHARS = 18` is right for Arabic as it stands.

Consequences, all applied in commit `97b4cc5`:

- `maxChunkCharsForLanguage` and `ARABIC_MAX_CHUNK_CHARS` removed from `subtitle-script.ts`, along with
  `DEFAULT_MAX_CHUNK_CHARS`, which had no remaining reader. The module now exports `fontForLanguage`
  and its two face constants, nothing else.
- The `maxChunkCharsForLanguage` describe block removed from `subtitle-script.test.ts`.
- The measured figures written into the comment on `MAX_CHUNK_CHARS` in `subtitles.ts`, with an explicit
  "do not add one back without a measurement that disagrees with this one".
- Spec §2.4 and §3.2 rewritten to record the refutation rather than hide it.

---

## Task 8: Prove non-Arabic renders did not move

The cue-budget threading this task originally carried is gone with Task 7. What remains is the safety
claim in spec §3.3, which is the thing protecting every existing clip and the frozen baselines.

**Files:** none. This task only runs things.

- [ ] **Step 1: Confirm `MAX_CHUNK_CHARS` has exactly one reader**

```bash
grep -rn "MAX_CHUNK_CHARS" apps/worker/src --include=*.ts
```

Expected: the constant, its comment, and the single use inside `chunkWords`'s `legal` helper. If
`subtitle-script.ts` still appears, Task 7's cleanup was incomplete.

- [ ] **Step 2: Full worker suite**

```bash
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```

Expected: 1433 tests passing, `tsc=0`.

- [ ] **Step 3: Prove non-Arabic renders are byte-identical**

```bash
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/tsx apps/worker/src/scripts/eval-camera-invariance.ts 2>&1 | tail -30'
```

Expected: level 3 green. If it is red, the style line moved for a non-Arabic language. A red level 3
means a real regression, not a baseline that needs regenerating: nothing in Part A is supposed to change
a single non-Arabic byte. Read the failure before touching a baseline.

**Level 1 is red and must stay red.** It compares the live filtergraph against a frozen verbatim copy of
the pre-`setsar` compiler embedded in the script at lines 86-130, so every `setsar=1` shows as a
difference. That is the deliberately-red oracle from the output-geometry work, present identically on
`main`, and this branch touches neither `reframe/` nor `cut.ts`. Do not "fix" it.

Observed on this branch: level 1 FAILED (176 plans, 352 differences, all `setsar=1`), level 2 ok
(7 replayed, 0 differences), **level 3 ok (7 renders, 0 differences)**.

- [ ] **Step 4: Render one real Arabic source end to end and look at it**

The pixel oracle proves "not boxes". Only an eye proves "reads right". Part A is not done until a frame
from a real Arabic clip has been looked at.

---

## Task 9: The bidi isolation helper

**Files:**
- Create: `packages/shared/src/i18n/bidi.ts`
- Modify: `packages/shared/src/i18n/index.ts`
- Test: `packages/shared/src/__tests__/bidi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/bidi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isolate } from "../i18n/bidi";

const FSI = "⁨";
const PDI = "⁩";

describe("isolate", () => {
  it("wraps a value in first-strong-isolate and pop-directional-isolate", () => {
    expect(isolate("https://clipclap.io")).toBe(`${FSI}https://clipclap.io${PDI}`);
  });

  it("accepts numbers, which is most of what gets interpolated", () => {
    expect(isolate(5)).toBe(`${FSI}5${PDI}`);
  });

  // An empty isolate is invisible padding around nothing. Returning the empty
  // string keeps a message from carrying two stray control characters when an
  // optional value is absent.
  it("returns an empty string unchanged", () => {
    expect(isolate("")).toBe("");
  });

  // Nesting would leave unbalanced pairs if a caller isolates an already
  // isolated value, and unbalanced bidi controls corrupt everything after
  // them in the paragraph.
  it("does not nest an already isolated value", () => {
    expect(isolate(isolate("STARTER"))).toBe(`${FSI}STARTER${PDI}`);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose exec -T bot sh -c 'cd /app && ./node_modules/.bin/vitest run --root . packages/shared/src/__tests__/bidi.test.ts'
```

Expected: FAIL, cannot resolve `../i18n/bidi`.

- [ ] **Step 3: Write the module**

Create `packages/shared/src/i18n/bidi.ts`:

```ts
/** Bidirectional isolation for values interpolated into right-to-left copy.
 *
 *  In an RTL paragraph the Unicode bidi algorithm reorders a run of Latin text
 *  together with the punctuation touching it, so "زر ${url}." can render with
 *  the full stop at the wrong end of the link, and a referral code sitting
 *  between two Arabic words can appear to belong to the wrong one. Wrapping
 *  the substituted value pins it: everything between the two marks is laid out
 *  independently of the surrounding direction.
 *
 *  Used ONLY from ar.ts. The other dictionaries are left-to-right and would
 *  gain nothing but two invisible characters per interpolation.
 *
 *  NEVER put these marks in a keyboard label. Labels are compared by exact
 *  string against the text Telegram echoes back, across every locale at once,
 *  and an invisible character inside one turns a broken button into a silent
 *  one. An assertion in the bot's i18n suite enforces that. */

/** U+2068 FIRST STRONG ISOLATE - direction taken from the first strong
 *  character inside, which is what makes this right for values whose script is
 *  not known in advance (a URL, a username, a plan name, a number). */
const FSI = "⁨";

/** U+2069 POP DIRECTIONAL ISOLATE. */
const PDI = "⁩";

export function isolate(value: string | number): string {
  const text = String(value);
  if (text === "") return "";
  // Idempotent: isolating an isolated value would leave nested pairs, and an
  // unbalanced pair corrupts the layout of everything after it.
  if (text.startsWith(FSI) && text.endsWith(PDI)) return text;
  return `${FSI}${text}${PDI}`;
}
```

- [ ] **Step 4: Export it**

`packages/shared/src/i18n/index.ts` currently reads `export * from "./locales";`. Add:

```ts
export * from "./bidi";
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
docker compose exec -T bot sh -c 'cd /app && ./node_modules/.bin/vitest run --root . packages/shared/src/__tests__/bidi.test.ts'
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Rebuild shared and commit**

The bot and worker import `@clipclap/shared` from its built `dist`, so a new export needs a build:

```bash
docker compose exec -T bot sh -c 'cd /app && npm run build -w @clipclap/shared' 
git add packages/shared/src/i18n/bidi.ts packages/shared/src/i18n/index.ts packages/shared/src/__tests__/bidi.test.ts
git commit -m "feat(i18n): bidi isolation helper for RTL interpolation"
```

---

## Task 10: Add the locale and watch everything go red

This task deliberately ends with a broken build. That breakage is the map for Tasks 11-13.

**Files:**
- Modify: `packages/shared/src/i18n/locales.ts`

- [ ] **Step 1: Add the code**

In `packages/shared/src/i18n/locales.ts`, change:

```ts
export const LOCALES = ["en", "ru", "uk", "es", "pt", "id"] as const;
```

to:

```ts
export const LOCALES = ["en", "ru", "uk", "es", "pt", "id", "ar"] as const;
```

- [ ] **Step 2: Collect the compile errors**

```bash
docker compose exec -T bot sh -c 'cd /app/apps/bot && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```

Expected: `tsc` non-zero, with errors naming `dictionaries` and `LANG_ALIASES` in
`apps/bot/src/i18n/index.ts`, and `PAYMENT_COPY` in
`packages/shared/src/services/telegram-notification.service.ts`. Three sites, exactly as the spec says.
If a fourth appears, read it - the spec's claim that three is the complete surface would be wrong and
that is worth knowing before continuing.

- [ ] **Step 3: Collect the red tests**

```bash
docker compose exec -T bot sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/bot/src/__tests__/i18n.test.ts 2>&1 | tail -40'
```

Expected: a batch of failures. Write the list down - it is the acceptance criterion for Task 11.

- [ ] **Step 4: Do NOT commit**

The tree is intentionally broken. It gets committed at the end of Task 12, when it compiles again.

---

## Task 11: Write the Arabic dictionary

**Files:**
- Create: `apps/bot/src/i18n/ar.ts`
- Modify: `apps/bot/src/i18n/index.ts`

104 `Dict` keys plus a 5-entry `JobErrorCode` map, in Modern Standard Arabic. `en.ts` is the source to
translate from; `ru.ts` is the structural model, because it is the existing file that already uses the
plural helper.

The structurally non-trivial parts are written out in full below. The remaining plain strings are
straight translations of their `en.ts` counterparts, and Task 13's tests refuse to pass while any is
missing, empty, duplicated, or left in English.

- [ ] **Step 1: Create the file with its header and plural helper**

```ts
import type { JobErrorCode } from "@clipclap/shared";
import { isolate, plural } from "@clipclap/shared";
import type { Dict } from "./types";

/** Arabic selects EVERY CLDR plural category, which no other dictionary in
 *  this project does - the existing helpers take three forms because Russian
 *  and Ukrainian select three. Verified against this project's Node:
 *
 *    0                -> zero
 *    1                -> one
 *    2                -> two
 *    3-10, 203        -> few
 *    11-99            -> many
 *    100, 101, 1000   -> other
 *
 *  All six are required arguments rather than optional with a fallback: a
 *  missing form would silently render the `other` text for a count Arabic
 *  distinguishes, which is exactly the failure a reader would notice and we
 *  would not. */
function pluralizeAr(
  n: number,
  zero: string,
  one: string,
  two: string,
  few: string,
  many: string,
  other: string
): string {
  return plural("ar", n, { zero, one, two, few, many, other });
}
```

- [ ] **Step 2: Write the failure map**

`JobErrorCode` has exactly five members. Translate each from `enFailure` in `en.ts`, keeping its
promises intact - in particular `SOURCE_UNAVAILABLE` must not name a cause (private, removed,
region-locked and a stale extractor are indistinguishable to the downloader), and no failure string may
tell the user to resend a video, because that bills the same minutes twice.

```ts
const arFailure: Record<JobErrorCode, string> = {
  ANALYSIS_UNAVAILABLE: "<MSA translation of enFailure.ANALYSIS_UNAVAILABLE>",
  UNSUPPORTED_INPUT: "<MSA translation of enFailure.UNSUPPORTED_INPUT>",
  SOURCE_UNAVAILABLE: "<MSA translation of enFailure.SOURCE_UNAVAILABLE>",
  SOURCE_TOO_LARGE: "<MSA translation of enFailure.SOURCE_TOO_LARGE>",
  FREE_ALLOWANCE_EXCEEDED: "<MSA translation of enFailure.FREE_ALLOWANCE_EXCEEDED>",
};
```

- [ ] **Step 3: Write the keys that carry a count**

These are the ones a structural copy from another dictionary gets wrong. Six forms each:

```ts
  done: (n) =>
    pluralizeAr(
      n,
      "تم. لا توجد مقاطع جاهزة.",
      "تم. مقطع واحد جاهز.",
      "تم. مقطعان جاهزان.",
      `تم. ${isolate(n)} مقاطع جاهزة.`,
      `تم. ${isolate(n)} مقطعا جاهزة.`,
      `تم. ${isolate(n)} مقطع جاهزة.`
    ),
```

Apply the same six-form shape to every other key whose signature takes a number:
`linkSuccess`, `donePartial`, `deliveryGivenUp`, `freeNotAnchored`, `freeBudgetClosed`,
`freeSourceTooLong`, `planSourceTooLong`, `planDailyLimit`, `planConcurrentLimit`.

Find them all with:

```bash
grep -n "number) => string" apps/bot/src/i18n/types.ts
```

- [ ] **Step 4: Isolate every interpolated non-Arabic value**

Any `${...}` holding a URL, a code, a username, a plan name or a number is wrapped in `isolate(...)`.
Compare against `en.ts` to find them:

```bash
grep -n '\${' apps/bot/src/i18n/en.ts | head -40
```

For example `linkCodePrompt`, which interpolates both a code and a URL:

```ts
  linkCodePrompt: (code, appUrl) =>
    `<MSA sentence> ${isolate(code)} <MSA sentence> ${isolate(appUrl)}`,
```

- [ ] **Step 5: Write the keyboard labels**

Plain text and emoji only. **No `isolate()` here** - these strings are compared byte for byte against
what Telegram sends back.

The back arrow is the one label whose emoji changes meaning under RTL: `⬅️` points away from "back" in a
right-to-left layout, so Arabic uses `➡️`.

```ts
  settingsBackBtn: "➡️ رجوع",
  supportCloseBtn: "➡️ إغلاق المحادثة",
```

Every other label keeps the emoji its English counterpart uses.

- [ ] **Step 6: Write `langName` and the profile strings**

```ts
  langName: "العربية",
```

`botDescription` must be at most 512 characters and `botShortDescription` at most 120 - Telegram's
limits, already asserted per locale. Check before running the suite:

```bash
node -e '
const s=require("fs").readFileSync("apps/bot/src/i18n/ar.ts","utf8");
for (const k of ["botDescription","botShortDescription"]) {
  const m=new RegExp(k+":\\s*(`[^`]*`|\"[^\"]*\")").exec(s);
  console.log(k, m ? [...m[1]].length - 2 : "NOT FOUND");
}'
```

- [ ] **Step 7: Translate the remaining plain keys**

Every other key in `Dict` is a straight MSA translation of the same key in `en.ts`. Keep each string's
promises identical - the English copy has been written carefully around what the system can and cannot
assert, and a translation that adds a promise ("we will retry") creates a support problem in a language
nobody here can answer in.

- [ ] **Step 8: Register the dictionary**

In `apps/bot/src/i18n/index.ts`, add the import next to the others:

```ts
import ar from "./ar";
```

and extend the registry:

```ts
const dictionaries: Record<Locale, Dict> = { en, ru, uk, es, pt, id, ar };
```

- [ ] **Step 9: Typecheck**

```bash
docker compose exec -T bot sh -c 'cd /app/apps/bot && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```

Expected: the `dictionaries` error is gone. `LANG_ALIASES` and `PAYMENT_COPY` still fail - Task 12.

---

## Task 12: Aliases and payment copy

**Files:**
- Modify: `apps/bot/src/i18n/index.ts`
- Modify: `packages/shared/src/services/telegram-notification.service.ts`

- [ ] **Step 1: Add the Arabic alias entry**

In `LANG_ALIASES`, add:

```ts
  ar: ["arabic", "arabe", "árabe", "arab", "عربي", "العربية", "араб", "арабский"],
```

- [ ] **Step 2: Add the Arabic words for the other six languages**

The aliases belong to the language being SELECTED, not to the language they are written in - an Arabic
reader typing `/lang` will type the Arabic word for English. Extend each existing entry:

```ts
  en: [..., "الإنجليزية"],
  ru: [..., "الروسية"],
  uk: [..., "الأوكرانية"],
  es: [..., "الإسبانية"],
  pt: [..., "البرتغالية"],
  id: [..., "الإندونيسية"],
```

Keep the existing members - the `...` above stands for what is already there, not for something to fill
in.

- [ ] **Step 3: Add `PAYMENT_COPY.ar`**

In `packages/shared/src/services/telegram-notification.service.ts`, add an `ar` entry to `PAYMENT_COPY`
modelled on the `en` entry. It covers the same `event.kind` values, in MSA, with `isolate()` around the
plan name, the minute count and any date. This is the one message a paying user is guaranteed to read.

- [ ] **Step 4: Typecheck both packages**

```bash
docker compose exec -T bot sh -c 'cd /app/apps/bot && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && ../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```

Expected: `tsc=0` for both.

- [ ] **Step 5: Rebuild shared**

```bash
docker compose exec -T bot sh -c 'cd /app && npm run build -w @clipclap/shared'
```

- [ ] **Step 6: Run the bot suite**

```bash
docker compose exec -T bot sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/bot/src'
```

Expected: every test from Task 10's red list now green. Any still failing names a specific missing or
duplicated string - fix the dictionary, never the assertion.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/i18n/locales.ts apps/bot/src/i18n/ar.ts apps/bot/src/i18n/index.ts packages/shared/src/services/telegram-notification.service.ts
git commit -m "feat(i18n): Arabic locale - dictionary, aliases, payment copy"
```

---

## Task 13: The new assertions

**Files:**
- Modify: `apps/bot/src/__tests__/i18n.test.ts`

- [ ] **Step 1: Write the four tests**

Append inside the existing `describe("bot i18n", ...)` block:

```ts
  // Arabic is the only language here that selects all six CLDR categories,
  // and a structural copy from another dictionary type-checks. Six distinct
  // strings is the cheapest proof that six forms were actually written.
  it("uses all six Arabic plural categories, distinctly", () => {
    const forms = [0, 1, 2, 3, 11, 100].map((n) => t("ar").done(n));
    expect(new Set(forms).size).toBe(6);
  });

  it("resolves Arabic regional tags", () => {
    expect(detectLocale("ar")).toBe("ar");
    expect(detectLocale("ar-SA")).toBe("ar");
    expect(detectLocale("ar-EG")).toBe("ar");
    expect(detectLocale("ar_MA")).toBe("ar");
  });

  // Keyboard labels are compared by exact string against what Telegram echoes
  // back. A bidi control character inside one is invisible in review and turns
  // a broken button into a silent one.
  it("has no bidi control character in any keyboard label", () => {
    const BIDI = /[‪-‮⁦-⁩‎‏]/;
    const labelKeys = [
      "menuCreate", "menuAccount", "menuHelp", "menuSettings", "menuEarn", "menuPlans",
      "settingsLangBtn", "settingsVideoBtn", "settingsLinkBtn", "settingsBackBtn",
      "earnReferralBtn", "earnAdvertisersBtn", "referralWithdrawBtn",
      "helpHowBtn", "helpSupportBtn", "supportCloseBtn",
    ] as const;
    for (const loc of LOCALES) {
      for (const key of labelKeys) {
        expect(BIDI.test(t(loc)[key] as string), `${loc}.${key}`).toBe(false);
      }
    }
  });

  // The type system cannot see that a key was copied from en.ts and never
  // translated. Comparing the rendered strings can.
  it("leaves no Arabic string identical to its English original", () => {
    const en = t("en");
    const ar = t("ar");
    const same: string[] = [];
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const a = en[key];
      const b = ar[key];
      if (typeof a === "string" && typeof b === "string" && a === b) {
        same.push(key as string);
      }
    }
    expect(same).toEqual([]);
  });
```

- [ ] **Step 2: Run them**

```bash
docker compose exec -T bot sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/bot/src/__tests__/i18n.test.ts'
```

Expected: PASS. A failure in `leaves no Arabic string identical` prints the offending keys - translate
them. A failure in the plural test means fewer than six distinct forms were written.

- [ ] **Step 3: Mutation-test the bidi guard**

In `apps/bot/src/i18n/ar.ts`, temporarily change one label:

```ts
  settingsBackBtn: "⁨➡️ رجوع⁩",
```

Re-run Step 2. Expected: `has no bidi control character in any keyboard label` **FAILS**, naming
`ar.settingsBackBtn`. If it passes, the regex or the key list is wrong.

- [ ] **Step 4: Restore and re-run**

```bash
git checkout apps/bot/src/i18n/ar.ts
```

Wait - this discards the whole file if Task 12 was not committed. It was, so this is safe. Re-run
Step 2 and confirm green.

- [ ] **Step 5: Full suite, both apps**

```bash
docker compose exec -T bot sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/bot/src packages/shared/src'
docker compose exec -T worker-render sh -c 'cd /app && ./node_modules/.bin/vitest run --root . apps/worker/src'
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/__tests__/i18n.test.ts
git commit -m "test(i18n): Arabic plurals, regional tags, bidi-free labels, no untranslated keys

Bidi guard mutation-tested: an isolate mark in settingsBackBtn fails it."
```

---

## Task 14: Deploy

- [ ] **Step 1: Check nothing is in flight**

```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c \
  "SELECT id, status FROM jobs WHERE status NOT IN ('DONE','FAILED');"
```

Expected: 0 rows. If a job is running, wait - a restart now kills it mid-render.

- [ ] **Step 2: Rebuild shared and restart the consumers**

A shared change reaches the bot and web through `dist`, and Next caches it:

```bash
docker compose exec -T bot sh -c 'cd /app && npm run build -w @clipclap/shared'
docker compose restart bot web
```

- [ ] **Step 3: Watch the profile sync**

```bash
docker compose logs bot --tail 20 | grep "profile sync"
```

Expected: `Bot profile sync: 3 updated, 21 already current, 0 failed` on the first boot - the three new
Arabic slots - then `0 updated, 24 already current` on every boot after. **Do not save any file under
`apps/bot/src/` during this window**: each save is another boot, and the `setMy*` family rate-limits
hard.

- [ ] **Step 4: Walk the bot in Arabic**

In Telegram: `/lang ar`, then press every button once - main menu, account, help, support (open and
close), settings, language picker, earn, plans. Confirm each responds. A button that does nothing means
a label mismatch, not a layout problem.

- [ ] **Step 5: Send a real Arabic video**

Submit an Arabic-language source and look at a delivered clip. The subtitles must be joined Arabic
letters reading right to left, not boxes, and the line must sit inside the frame.

---

## Task 15: Ask a native speaker

Not optional. The tests catch empty, duplicated and untranslated strings, and catch nothing about text
that is comprehensible but wrong.

- [ ] **Step 1: Message the two most active Arabic users**

Through the in-bot support relay, from the operator chat, to:

- `7013153761` (Fou ad - 5 clips, came back on a second day)
- `1021588991` (12 clips, the largest Arabic job so far)

Ask them to switch to Arabic with `/lang ar` and say what reads wrong.

- [ ] **Step 2: Record what comes back**

Fix what they report, in `ar.ts`, and re-run the bot suite before committing.

- [ ] **Step 3: Update the spec's status**

Change the `**Status:**` line of
`docs/superpowers/specs/2026-08-13-arabic-locale-design.md` from `design` to `shipped <date>`, and add a
one-line note recording the measured `ARABIC_MAX_CHUNK_CHARS` and whether the native review changed
anything.

```bash
git add docs/superpowers/specs/2026-08-13-arabic-locale-design.md apps/bot/src/i18n/ar.ts
git commit -m "docs(i18n): Arabic shipped; record the measured cue budget and review notes"
```
