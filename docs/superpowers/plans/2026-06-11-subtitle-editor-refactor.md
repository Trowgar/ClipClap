# Subtitle Editor Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop subtitle style presets, make one default Cyrillic-capable burned-in style that actually renders, store an editable per-clip subtitle track, add a re-render path that burns edited cues, ship a simplified web editor, and link out from the Telegram bot.

**Architecture:** Four phases per the approved design (`docs/superpowers/specs/2026-06-11-subtitle-editor-refactor-design.md`). Phase 0 rewrites `apps/worker/src/processors/subtitles.ts` around a single `DEFAULT_STYLE` and cue-based ASS generation (folding design item 1.2 in early so the module is rewritten once), bundles a font, captures Whisper word timings, and removes presets everywhere. Phase 1 persists `Clip.subtitleTrack` and extends the existing `mode:"trim"` render path to burn edited cues. Phase 2 is a Next.js editor at `/dashboard/editor?clip=<id>`. Phase 3 adds an "Edit in browser" button to bot deliveries.

**Tech Stack:** TypeScript, Next.js 15 (App Router) + shadcn/ui + Tailwind, Prisma + Postgres, BullMQ, FFmpeg/libass, vitest. No new npm deps (no virtualization - clips are ≤ ~3 min, cue counts are tens, YAGNI).

**Conventions:** Plain hyphens in all copy. Commits as `Trowgar <trowgar@yahoo.com>`, no Claude trailer. Bot copy bilingual EN/RU via `apps/bot/src/i18n.ts`; web UI English-only.

**Deviations from the design doc (intentional):**
- Design item 1.2 (cue-based `generateAss`/`burnSubtitles`) is implemented in Phase 0, not Phase 1, so `subtitles.ts` and its tests are rewritten once instead of twice. Phase 0 still ships standalone.
- `@tanstack/react-virtual` is skipped - the editor lists tens of cues, not thousands.
- Legacy `apps/worker/src/pipeline.ts` (superseded by the stage pipeline, referenced only by its own test) is deleted instead of being de-preset-ed.

---

## Phase 0 - default subtitles that render

### Task 1: Bundle Montserrat Bold + fontconfig in the worker image

**Files:**
- Create: `apps/worker/assets/fonts/Montserrat-Bold.ttf` (binary, downloaded)
- Create: `apps/worker/assets/fonts/OFL.txt`
- Modify: `apps/worker/Dockerfile`

- [ ] **Step 1: Download the font + license**

```bash
mkdir -p apps/worker/assets/fonts
curl -fsSL -o apps/worker/assets/fonts/Montserrat-Bold.ttf \
  https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Bold.ttf
curl -fsSL -o apps/worker/assets/fonts/OFL.txt \
  https://raw.githubusercontent.com/JulietaUla/Montserrat/master/OFL.txt
```

Verify it is a real TTF with Cyrillic: `file apps/worker/assets/fonts/Montserrat-Bold.ttf` → "TrueType Font data". Expect size roughly 150-400 KB. If the URL 404s, fall back to `https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf` is NOT acceptable (variable font name mismatch) - instead use any pinned release of JulietaUla/Montserrat.

- [ ] **Step 2: Dockerfile - fontconfig + COPY assets into production stage**

In `apps/worker/Dockerfile` change the base stage line 4 to:

```dockerfile
RUN apk add --no-cache ffmpeg python3 py3-pip openssl fontconfig
```

and in the production stage (after `COPY --from=build /app/apps/worker/dist ./apps/worker/dist`) add:

```dockerfile
COPY --from=build /app/apps/worker/assets ./apps/worker/assets
```

(The development stage already does `COPY . .` so assets are present there.)

- [ ] **Step 3: Commit**

```bash
git add apps/worker/assets apps/worker/Dockerfile
git commit -m "feat(worker): bundle Montserrat Bold (OFL, Cyrillic) + fontconfig for subtitle rendering"
```

### Task 2: Subtitle types in shared

**Files:**
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Add word/cue/track types, extend WhisperSegment**

In `packages/shared/src/types/index.ts` replace the `WhisperSegment` block with:

```ts
export interface SubtitleWord {
  text: string;
  start: number; // seconds, relative to same timeline as the owning segment/cue
  end: number;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  words?: SubtitleWord[];
}

/** Editor working format. Cue times are seconds relative to the clip file (0 = clip start). */
export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
  words?: SubtitleWord[];
}

export interface SubtitleTrack {
  cues: SubtitleCue[];
}
```

Leave `SubtitlePreset` and the `subtitlePreset` input fields alone for now - they die in Task 5.

- [ ] **Step 2: Typecheck + commit**

Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json 2>&1 | head` (or the workspace's existing check). Expected: no new errors.

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat(shared): SubtitleWord/SubtitleCue/SubtitleTrack types, word timings on WhisperSegment"
```

### Task 3: Rewrite subtitles.ts - DEFAULT_STYLE, cue-based ASS, hardened burn (TDD)

**Files:**
- Rewrite: `apps/worker/src/processors/subtitles.ts`
- Rewrite: `apps/worker/src/processors/__tests__/subtitles.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace `apps/worker/src/processors/__tests__/subtitles.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { generateAss, segmentsToCues, sliceCues } from "../subtitles";
import type { SubtitleCue, WhisperSegment } from "@clipclap/shared";

const segments: WhisperSegment[] = [
  { start: 10.0, end: 13.5, text: "Hello everyone" },
  {
    start: 13.5,
    end: 18.0,
    text: "Welcome to the stream",
    words: [
      { text: "Welcome", start: 13.5, end: 14.2 },
      { text: "to", start: 14.2, end: 14.4 },
      { text: "the", start: 14.4, end: 14.6 },
      { text: "stream", start: 14.6, end: 15.1 },
    ],
  },
  { start: 18.0, end: 25.0, text: "Today we are going to talk about AI" },
  { start: 50.0, end: 55.0, text: "This is outside the clip range" },
];

describe("segmentsToCues", () => {
  it("filters to the clip window and shifts times to clip-relative", () => {
    const cues = segmentsToCues(segments, 10.0, 25.0);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toMatchObject({ start: 0, end: 3.5, text: "Hello everyone" });
    expect(cues[1].start).toBeCloseTo(3.5);
    expect(cues[1].end).toBeCloseTo(8.0);
  });

  it("shifts word timings along with the cue and assigns ids", () => {
    const cues = segmentsToCues(segments, 10.0, 25.0);
    expect(cues[1].words?.[0]).toEqual({ text: "Welcome", start: 3.5, end: 4.2 });
    expect(new Set(cues.map((c) => c.id)).size).toBe(3);
  });

  it("clamps cues that straddle the clip edges", () => {
    const cues = segmentsToCues(segments, 12.0, 16.0);
    expect(cues[0].start).toBe(0);
    expect(cues.at(-1)!.end).toBeCloseTo(4.0);
  });
});

describe("sliceCues", () => {
  const cues: SubtitleCue[] = [
    { id: "a", start: 0, end: 3, text: "one" },
    {
      id: "b",
      start: 3,
      end: 6,
      text: "two words",
      words: [
        { text: "two", start: 3, end: 4 },
        { text: "words", start: 4, end: 5.5 },
      ],
    },
    { id: "c", start: 6, end: 9, text: "three" },
  ];

  it("re-windows clip-relative cues to a sub-range", () => {
    const out = sliceCues(cues, 2, 7);
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(out[0]).toMatchObject({ start: 0, end: 1 });
    expect(out[1]).toMatchObject({ start: 1, end: 4 });
    expect(out[1].words?.[1]).toEqual({ text: "words", start: 2, end: 3.5 });
    expect(out[2]).toMatchObject({ start: 4, end: 5 });
  });

  it("drops cues fully outside the range", () => {
    const out = sliceCues(cues, 3.2, 5.8);
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("generateAss", () => {
  const cues = segmentsToCues(segments, 10.0, 25.0);

  it("emits the single default style (Montserrat Bold, white on black outline)", () => {
    const ass = generateAss(cues);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    const style = ass.split("\n").find((l) => l.startsWith("Style: Default,"));
    expect(style).toBeDefined();
    const fields = style!.replace("Style: ", "").split(",");
    expect(fields[1]).toBe("Montserrat");
    expect(fields[3]).toBe("&H00FFFFFF"); // white primary
    expect(fields[7]).toBe("-1"); // bold
    expect(fields[21]).toBe("80"); // marginV
  });

  it("renders cue times relative to the clip", () => {
    const ass = generateAss(cues);
    expect(ass).toContain("0:00:00.00,0:00:03.50");
    expect(ass).not.toContain("outside the clip range");
  });

  it("emits karaoke word timing when words are present", () => {
    const ass = generateAss(cues);
    const karaokeLine = ass
      .split("\n")
      .find((l) => l.startsWith("Dialogue:") && l.includes("Welcome"));
    expect(karaokeLine).toContain("\\k70}Welcome");
    expect(karaokeLine).toContain("{\\1c&H00FFFF&}"); // active-word highlight colour
  });

  it("falls back to plain text when a cue has no words", () => {
    const ass = generateAss(cues);
    const plain = ass
      .split("\n")
      .find((l) => l.startsWith("Dialogue:") && l.includes("Hello everyone"));
    expect(plain).not.toContain("\\k");
  });

  it("escapes newlines and strips brace characters", () => {
    const ass = generateAss([
      { id: "x", start: 0, end: 1, text: "line1\nline2 {evil}" },
    ]);
    expect(ass).toContain("line1\\Nline2 (evil)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts`
Expected: FAIL - `segmentsToCues`/`sliceCues` not exported, preset signature mismatch.

- [ ] **Step 3: Rewrite the implementation**

Replace `apps/worker/src/processors/subtitles.ts` with:

```ts
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { SubtitleCue, SubtitleWord, WhisperSegment } from "@clipclap/shared";

const execFileAsync = promisify(execFile);

// One burned-in style for everyone. White Montserrat Bold with a black
// outline, bottom-centered on a 1080x1920 canvas; the active word flips to
// yellow via ASS karaoke when word timings exist.
const DEFAULT_STYLE = {
  fontName: "Montserrat",
  fontSize: 18,
  primaryColor: "&H00FFFFFF", // white (AABBGGRR)
  karaokeFillColor: "&H00FFFF", // yellow (BBGGRR inline override)
  outlineColor: "&H00000000",
  backColor: "&H80000000",
  outline: 3,
  shadow: 0,
  marginV: 80,
} as const;

// assets/ ships beside src/ in dev (tsx) and beside dist/ in the production
// image, so __dirname/../.. lands on apps/worker in both.
export function resolveFontsDir(): string {
  return process.env.SUBTITLE_FONTS_DIR || join(__dirname, "..", "..", "assets", "fonts");
}

export function segmentsToCues(
  segments: WhisperSegment[],
  clipStart: number,
  clipEnd: number
): SubtitleCue[] {
  return segments
    .filter((s) => s.end > clipStart && s.start < clipEnd)
    .map((s) => {
      const words = s.words
        ?.filter((w) => w.end > clipStart && w.start < clipEnd)
        .map((w) => shiftWord(w, clipStart));
      return {
        id: randomUUID(),
        start: Math.max(0, s.start - clipStart),
        end: Math.min(clipEnd - clipStart, s.end - clipStart),
        text: s.text,
        ...(words && words.length > 0 ? { words } : {}),
      };
    });
}

/** Re-window clip-relative cues to a [start, end] sub-range of the same clip. */
export function sliceCues(
  cues: SubtitleCue[],
  start: number,
  end: number
): SubtitleCue[] {
  return cues
    .filter((c) => c.end > start && c.start < end)
    .map((c) => {
      const words = c.words
        ?.filter((w) => w.end > start && w.start < end)
        .map((w) => shiftWord(w, start));
      return {
        ...c,
        start: Math.max(0, c.start - start),
        end: Math.min(end - start, c.end - start),
        ...(words && words.length > 0 ? { words } : { words: undefined }),
      };
    });
}

function shiftWord(w: SubtitleWord, offset: number): SubtitleWord {
  return { text: w.text, start: Math.max(0, w.start - offset), end: Math.max(0, w.end - offset) };
}

export function generateAss(cues: SubtitleCue[]): string {
  const s = DEFAULT_STYLE;
  const header = `[Script Info]
Title: ClipClap Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.fontName},${s.fontSize},${s.primaryColor},${s.primaryColor},${s.outlineColor},${s.backColor},-1,0,0,0,100,100,0,0,1,${s.outline},${s.shadow},2,20,20,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = cues
    .filter((c) => c.end > c.start)
    .map((c) => {
      const text = c.words && c.words.length > 0 ? karaokeText(c) : escapeAssText(c.text);
      return `Dialogue: 0,${formatAssTime(c.start)},${formatAssTime(c.end)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
}

// ASS karaoke: \k fills words with PrimaryColour as they are spoken, unsung
// text shows SecondaryColour. We override the line's primary to yellow so
// spoken words highlight while unspoken stay white (the style secondary).
function karaokeText(cue: SubtitleCue): string {
  const words = cue.words!;
  const parts: string[] = [`{\\1c&H${DEFAULT_STYLE.karaokeFillColor.replace("&H", "")}&}`];
  let cursor = cue.start;
  for (const w of words) {
    // Fold any silence gap before the word into its own \k delay so the
    // karaoke cursor stays in sync with real time.
    const durationCs = Math.max(1, Math.round((Math.max(w.end, cursor) - cursor) * 100));
    parts.push(`{\\k${durationCs}}${escapeAssText(w.text)} `);
    cursor = Math.max(w.end, cursor);
  }
  return parts.join("").trimEnd();
}

function escapeAssText(text: string): string {
  return text.replace(/\n/g, "\\N").replace(/\{/g, "(").replace(/\}/g, ")");
}

function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

export async function burnSubtitles(
  videoPath: string,
  cues: SubtitleCue[]
): Promise<string> {
  const assContent = generateAss(cues);
  const assPath = join(tmpdir(), `clipclap-subs-${randomUUID()}.ass`);
  const outputPath = join(tmpdir(), `clipclap-subbed-${randomUUID()}.mp4`);

  await writeFile(assPath, assContent, "utf-8");

  try {
    const escapeFilterPath = (p: string) =>
      p.replace(/\\/g, "/").replace(/:/g, "\\:");

    try {
      await execFileAsync("ffmpeg", [
        "-nostdin",
        "-i",
        videoPath,
        "-vf",
        `ass=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(resolveFontsDir())}`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
        "-y",
      ]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      throw new Error(
        `ffmpeg subtitle burn failed: ${stderr.slice(-2000) || String(error)}`
      );
    }

    const out = await stat(outputPath).catch(() => null);
    if (!out || out.size === 0) {
      throw new Error("ffmpeg subtitle burn produced an empty output file");
    }

    return outputPath;
  } finally {
    await unlink(assPath).catch(() => {});
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts`
Expected: PASS (callers still broken - fixed in Task 5; vitest only compiles what the test imports).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors/subtitles.ts apps/worker/src/processors/__tests__/subtitles.test.ts
git commit -m "feat(worker): single default subtitle style, cue-based ASS with karaoke words, hardened burn"
```

### Task 4: Word-level timestamps from Whisper (TDD)

**Files:**
- Modify: `apps/worker/src/processors/transcribe.ts`
- Modify: `apps/worker/src/processors/__tests__/transcribe.test.ts`

- [ ] **Step 1: Add failing tests**

Append to the `describe` block in `transcribe.test.ts` (and extend the `beforeEach` mock):

In `beforeEach`, change the `transcriptionCreate` mock to:

```ts
mocks.transcriptionCreate.mockResolvedValue({
  text: "hello world",
  segments: [{ start: 0, end: 1.5, text: " hello world " }],
  words: [
    { word: "hello", start: 0, end: 0.6 },
    { word: "world", start: 0.7, end: 1.4 },
  ],
});
```

New tests:

```ts
it("requests word and segment granularity", async () => {
  await transcribeVideo("/tmp/source.mp4");
  expect(mocks.transcriptionCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      timestamp_granularities: ["segment", "word"],
    })
  );
});

it("attaches words to their segment by time overlap", async () => {
  const result = await transcribeVideo("/tmp/source.mp4");
  expect(result.segments[0].words).toEqual([
    { text: "hello", start: 0, end: 0.6 },
    { text: "world", start: 0.7, end: 1.4 },
  ]);
});

it("survives a response without words (segment-only fallback)", async () => {
  mocks.transcriptionCreate.mockResolvedValue({
    text: "hello",
    segments: [{ start: 0, end: 1, text: " hello " }],
  });
  const result = await transcribeVideo("/tmp/source.mp4");
  expect(result.segments[0].words).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/worker/src/processors/__tests__/transcribe.test.ts`
Expected: FAIL on granularity + words assertions.

- [ ] **Step 3: Implement**

In `transcribe.ts` change the API call and mapping:

```ts
const response = await openai.audio.transcriptions.create({
  file: createReadStream(audioPath),
  model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
  response_format: "verbose_json",
  timestamp_granularities: ["segment", "word"],
});

const raw = response as unknown as {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
};

const allWords: SubtitleWord[] = (raw.words ?? []).map((w) => ({
  text: w.word.trim(),
  start: w.start,
  end: w.end,
}));

const segments: WhisperSegment[] = raw.segments.map((s) => {
  const words = allWords.filter((w) => w.start < s.end && w.end > s.start);
  return {
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    ...(words.length > 0 ? { words } : {}),
  };
});
```

Add `SubtitleWord` to the type import from `@clipclap/shared`.

- [ ] **Step 4: Run to verify pass + commit**

Run: `npx vitest run apps/worker/src/processors/__tests__/transcribe.test.ts` → PASS

```bash
git add apps/worker/src/processors/transcribe.ts apps/worker/src/processors/__tests__/transcribe.test.ts
git commit -m "feat(worker): capture Whisper word-level timestamps with segment-only fallback"
```

### Task 5: Remove presets everywhere (DB, shared, worker, web, bot)

**Files:**
- Modify: `prisma/schema.prisma` (drop `Job.subtitlePreset`, `Clip.subtitlePreset`)
- Create: migration via `npx prisma migrate dev --name drop_subtitle_presets`
- Modify: `packages/shared/src/types/index.ts` (drop `SubtitlePreset`, preset fields)
- Modify: `packages/shared/src/config/plans.ts` + `__tests__/plans.test.ts`
- Modify: `packages/shared/src/services/job.service.ts`, `clip.service.ts`, `project.service.ts` + their tests
- Modify: `apps/worker/src/stages/types.ts`, `apps/worker/src/stages/render.ts`
- Delete: `apps/worker/src/pipeline.ts`, `apps/worker/src/__tests__/pipeline.trim.test.ts`
- Modify: `apps/web/app/api/jobs/route.ts`, `apps/web/app/api/clips/[id]/trim/route.ts`, `apps/web/lib/api.ts`
- Modify: `apps/web/components/upload-zone.tsx`, `trim-editor.tsx`, `clip-card.tsx`
- Modify: `apps/web/app/(dashboard)/dashboard/page.tsx`, `clips/[id]/page.tsx`, `plans/page.tsx`
- Modify: `apps/bot/src/handlers.ts`

- [ ] **Step 1: Schema + migration**

Remove `subtitlePreset String? @default("tiktok")` from `Job` and `subtitlePreset String?` from `Clip` in `prisma/schema.prisma`. Then:

```bash
npx prisma migrate dev --name drop_subtitle_presets
```

Expected: new folder under `prisma/migrations/` containing `ALTER TABLE "jobs" DROP COLUMN "subtitlePreset"; ALTER TABLE "clips" DROP COLUMN "subtitlePreset";` and "Your database is now in sync".

- [ ] **Step 2: Shared package**

`types/index.ts`: delete `export type SubtitlePreset = ...`, delete `subtitlePreset` from `CreateJobInput` and `TrimClipInput`.

`config/plans.ts`: delete `subtitlePresets: string[];` from `PlanLimits` and all five `subtitlePresets: [...]` entries.

`config/__tests__/plans.test.ts`: delete the three `subtitlePresets` expectations and fix test names ("3 presets" etc.).

`services/job.service.ts`: delete `subtitlePreset: input.subtitlePreset ?? "tiktok",`.

`services/clip.service.ts`: delete `subtitlePreset: input.subtitlePreset,` from the clip create and from the queue payload.

`services/project.service.ts`: delete `subtitlePreset` from `ProjectDetailClip`, the prisma `select`, and the mapper.

`services/__tests__/clip.service.test.ts` and `__tests__/project.service.test.ts`: drop `subtitlePreset` fixture fields/assertions.

- [ ] **Step 3: Worker**

`stages/types.ts`: remove `SubtitlePreset` import and `subtitlePreset?: SubtitlePreset;` from the trim variant.

`stages/render.ts` in `renderClips()`: replace the preset block with the new cue API:

```ts
let finalClipPath = cutResult.clipPath;
if (job.subtitles) {
  const cues = segmentsToCues(
    transcription.segments,
    highlight.start,
    highlight.end
  );
  const subbedPath = await burnSubtitles(cutResult.clipPath, cues);
  tempFiles.push(subbedPath);
  finalClipPath = subbedPath;
}
```

with `import { burnSubtitles, segmentsToCues } from "../processors/subtitles";` and remove `subtitlePreset: job.subtitlePreset,` from the clip create.

Delete `apps/worker/src/pipeline.ts` and `apps/worker/src/__tests__/pipeline.trim.test.ts` (legacy monolith superseded by stages; only its own test imports it - verify with `grep -rn "from \"../pipeline\"" apps/worker/src` first).

- [ ] **Step 4: Web**

`app/api/jobs/route.ts`: drop `subtitlePreset` from destructuring and from the `createJob` call.

`app/api/clips/[id]/trim/route.ts`: drop `subtitlePreset: body.subtitlePreset,`.

`lib/api.ts`: drop `subtitlePreset` from `jobs.create` arg type, `clips.trim` arg type, `JobWithClips`, `ClipData`.

`components/upload-zone.tsx`: replace the preset chips with a single on/off pair. Delete `ALL_PRESETS`, `PRESET_LABEL`, the `availableSubtitlePresets` prop, and the `subtitlePreset` state; add `const [subtitles, setSubtitles] = useState(true);`. Job create becomes `subtitles,` (no preset). Replace the chips block with:

```tsx
<div className="flex items-center gap-1.5">
  <span className="text-neutral-500">Subtitles</span>
  {[true, false].map((on) => (
    <button
      key={String(on)}
      type="button"
      onClick={() => setSubtitles(on)}
      disabled={loading}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] transition-colors",
        subtitles === on
          ? "bg-white/[0.12] text-white"
          : "border border-white/[0.08] text-neutral-400 hover:border-white/[0.16] hover:text-neutral-200"
      )}
    >
      {on ? "On" : "Off"}
    </button>
  ))}
</div>
```

`app/(dashboard)/dashboard/page.tsx`: remove the `availableSubtitlePresets={limits.subtitlePresets}` prop.

`components/trim-editor.tsx`: remove the `originalPreset` prop, `preset` state, the `<Select>` block and its imports; `changed` no longer compares preset; the trim call sends `{ start, end, subtitles }`.

`components/clip-card.tsx`: remove `subtitlePreset` from the clip prop type and replace the preset badge with a plain "subtitles" badge when `clip.subtitles`.

`app/(dashboard)/dashboard/clips/[id]/page.tsx`: remove the preset badge + `originalPreset` prop.

`app/(dashboard)/dashboard/plans/page.tsx`: replace the `` `${PLUS_MONTHLY.subtitlePresets.length} subtitle styles` `` feature line with `"Burned-in subtitles"`.

- [ ] **Step 5: Bot**

`apps/bot/src/handlers.ts`: remove both `subtitlePreset: "tiktok",` lines.

- [ ] **Step 6: Full verification**

```bash
npx vitest run
npx tsc --noEmit -p apps/worker/tsconfig.typecheck.json
cd apps/web && npx next build 2>&1 | tail -20   # or npx tsc --noEmit if build is too slow
```

Expected: all tests pass, no type errors referencing `subtitlePreset`/`SubtitlePreset` (run `grep -rn "subtitlePreset\|SubtitlePreset" apps packages --include='*.ts' --include='*.tsx' | grep -v dist` → empty).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat!: drop subtitle style presets - single default burned style, on/off only"
```

---

## Phase 1 - editable per-clip subtitle track + re-render

### Task 6: `Clip.subtitleTrack` migration + persist on first render

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `apps/worker/src/stages/render.ts`

- [ ] **Step 1: Schema**

Add to `model Clip`: `subtitleTrack Json?` then:

```bash
npx prisma migrate dev --name add_clip_subtitle_track
```

- [ ] **Step 2: Persist cues in renderClips**

In `renderClips()` hoist the cue derivation above the burn so it is computed even when subtitles are off (the editor can still enable them later):

```ts
const cues = segmentsToCues(
  transcription.segments,
  highlight.start,
  highlight.end
);

let finalClipPath = cutResult.clipPath;
if (job.subtitles) {
  const subbedPath = await burnSubtitles(cutResult.clipPath, cues);
  tempFiles.push(subbedPath);
  finalClipPath = subbedPath;
}
```

and in the `prisma.clip.create` data add:

```ts
subtitleTrack: { cues } as unknown as Prisma.InputJsonValue,
```

- [ ] **Step 3: Commit**

```bash
git add prisma apps/worker/src/stages/render.ts
git commit -m "feat(worker): persist editable subtitle track on clip render"
```

### Task 7: Re-render path burns edited cues (TDD at service level)

**Files:**
- Modify: `apps/worker/src/stages/types.ts`
- Modify: `apps/worker/src/stages/render.ts`
- Modify: `packages/shared/src/types/index.ts` (`TrimClipInput` → edit input)
- Modify: `packages/shared/src/services/clip.service.ts`
- Modify: `packages/shared/src/services/__tests__/clip.service.test.ts`

- [ ] **Step 1: Payload + input types**

`stages/types.ts` trim variant becomes:

```ts
| (BaseStagePayload & {
    mode: "trim";
    clipId: string;
    originalClipStorageKey: string;
    start: number;
    end: number;
    subtitles: boolean;
    subtitleTrack?: SubtitleTrack;
  });
```

(`import type { SubtitleTrack } from "@clipclap/shared";`)

`packages/shared/src/types/index.ts`: rename/extend `TrimClipInput`:

```ts
export interface EditClipInput {
  clipId: string;
  userId: string;
  start: number;
  end: number;
  subtitles: boolean;
  subtitleTrack?: SubtitleTrack;
}
```

(keep `export type TrimClipInput = EditClipInput;` alias only if other code still imports it - otherwise update imports.)

- [ ] **Step 2: Service test first**

Extend `clip.service.test.ts` with a case asserting `editClip` enqueues `subtitleTrack` and relative times, and persists the (full, unshifted) track on the new clip row. Follow the existing mock pattern in that file.

```ts
it("editClip enqueues a trim render with the edited subtitle track", async () => {
  const track = { cues: [{ id: "c1", start: 1, end: 2, text: "hi" }] };
  await clipService.editClip({
    clipId: "clip_1",
    userId: "user_1",
    start: 12,
    end: 20,
    subtitles: true,
    subtitleTrack: track,
  });

  expect(mocks.queueAdd).toHaveBeenCalledWith(
    "render",
    expect.objectContaining({
      mode: "trim",
      subtitles: true,
      subtitleTrack: track,
      start: 2,
      end: 10,
    })
  );
});
```

(Original clip fixture has `startTime: 10`, so source-absolute 12..20 → clip-relative 2..10. Match the file's existing fixtures/mocks exactly.)

Run: `npx vitest run packages/shared/src/services/__tests__/clip.service.test.ts` → FAIL (`editClip` missing).

- [ ] **Step 3: Implement `editClip`**

In `clip.service.ts` rename `trimClip` → `editClip(input: EditClipInput)`; the create gains `subtitleTrack: input.subtitleTrack as unknown as Prisma.InputJsonValue ?? undefined` (import `Prisma` type), title suffix `"(edited)"`, and the queue payload gains `subtitleTrack: input.subtitleTrack,`. Keep `export const trimClip = editClip;`? No - update the lone caller (trim route) instead.

- [ ] **Step 4: Worker renderTrim burns cues**

In `render.ts`:

```ts
async function renderTrim(
  payload: Extract<RenderStagePayload, { mode: "trim" }>
) {
  const tempFiles: string[] = [];

  try {
    const originalPath = await downloadVideo(
      undefined,
      payload.originalClipStorageKey
    );
    tempFiles.push(originalPath);

    const trimmedPath = await trimClipFile(originalPath, payload.start, payload.end);
    tempFiles.push(trimmedPath);

    let finalPath = trimmedPath;
    const editedCues = payload.subtitleTrack?.cues ?? [];
    const windowedCues = sliceCues(editedCues, payload.start, payload.end);
    if (payload.subtitles && windowedCues.length > 0) {
      const subbedPath = await burnSubtitles(trimmedPath, windowedCues);
      tempFiles.push(subbedPath);
      finalPath = subbedPath;
    }

    const storageKey = `clips/${payload.userId}/${payload.jobId}/${randomUUID()}.mp4`;
    await uploadFile(storageKey, finalPath, "video/mp4");
    await prisma.clip.update({
      where: { id: payload.clipId },
      data: {
        storageKey,
        duration: Math.round(payload.end - payload.start),
        subtitleTrack: { cues: windowedCues } as unknown as Prisma.InputJsonValue,
      },
    });
  } finally {
    await cleanup(tempFiles);
  }
}
```

(import `sliceCues`; cues arrive relative to the ORIGINAL clip file; the stored track on the new clip is re-windowed so it matches the new file.)

- [ ] **Step 5: Run tests, commit**

`npx vitest run` → PASS.

```bash
git add -A
git commit -m "feat: re-render path burns edited subtitle cues (editClip service + trim stage)"
```

### Task 8: APIs - GET subtitles, PUT edit

**Files:**
- Create: `apps/web/app/api/clips/[id]/subtitles/route.ts`
- Create: `apps/web/app/api/clips/[id]/edit/route.ts`
- Modify: `apps/web/app/api/clips/[id]/trim/route.ts` (call `editClip`, drop preset remnants)
- Modify: `apps/web/lib/api.ts`

- [ ] **Step 1: GET subtitles route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipclap/shared";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const clip = await clipService.getClip(id, session.user.id);
  if (!clip) {
    return NextResponse.json({ error: "Clip not found" }, { status: 404 });
  }

  return NextResponse.json(clip.subtitleTrack ?? { cues: [] });
}
```

- [ ] **Step 2: PUT edit route**

`edit/route.ts` validates `{ trim?: {start,end}, subtitles?: boolean, subtitleTrack?: {cues: [...]} }`, defaults trim to the clip's full current range, validates cue shape (id/start/end strings+numbers, end>start, text string, cap 500 cues), then calls `clipService.editClip` and returns the placeholder clip 201. Include a small `parseTrack(body): SubtitleTrack | null` validator in the route file.

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipclap/shared";
import type { SubtitleTrack, SubtitleCue } from "@clipclap/shared";

function parseTrack(value: unknown): SubtitleTrack | null | "invalid" {
  if (value == null) return null;
  const track = value as SubtitleTrack;
  if (!Array.isArray(track.cues) || track.cues.length > 500) return "invalid";
  for (const cue of track.cues as SubtitleCue[]) {
    if (
      typeof cue.id !== "string" ||
      typeof cue.text !== "string" ||
      typeof cue.start !== "number" ||
      typeof cue.end !== "number" ||
      !(cue.end > cue.start) ||
      cue.text.length > 500
    ) {
      return "invalid";
    }
  }
  return { cues: track.cues.map(({ id, start, end, text, words }) => ({ id, start, end, text, words })) };
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const clip = await clipService.getClip(id, session.user.id);
  if (!clip) {
    return NextResponse.json({ error: "Clip not found" }, { status: 404 });
  }

  const body = await req.json();
  const track = parseTrack(body.subtitleTrack);
  if (track === "invalid") {
    return NextResponse.json({ error: "Invalid subtitleTrack" }, { status: 400 });
  }

  const start = body.trim?.start ?? clip.startTime;
  const end = body.trim?.end ?? clip.endTime;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) {
    return NextResponse.json({ error: "Invalid trim range" }, { status: 400 });
  }

  const newClip = await clipService.editClip({
    clipId: id,
    userId: session.user.id,
    start,
    end,
    subtitles: body.subtitles ?? true,
    subtitleTrack: track ?? undefined,
  });

  return NextResponse.json(newClip, { status: 201 });
}
```

- [ ] **Step 3: trim route delegates to editClip; api.ts client**

`trim/route.ts`: `clipService.trimClip(...)` → `clipService.editClip(...)` (same args minus preset).

`lib/api.ts` additions:

```ts
subtitles: (id: string) => fetchApi<SubtitleTrack>(`/api/clips/${id}/subtitles`),
edit: (
  id: string,
  data: { trim?: { start: number; end: number }; subtitles?: boolean; subtitleTrack?: SubtitleTrack }
) => fetchApi<ClipData>(`/api/clips/${id}/edit`, { method: "PUT", body: JSON.stringify(data) }),
```

with `import type { SubtitleTrack } from "@clipclap/shared";` and `ClipData` gains `subtitleTrack?: SubtitleTrack | null;` plus `expiresAt`? (no - keep as-is).

- [ ] **Step 4: Verify + commit**

`npx vitest run` and web typecheck pass.

```bash
git add -A
git commit -m "feat(api): clip subtitles GET + edit PUT endpoints"
```

---

## Phase 2 - the web editor

### Task 9: Editor route + components

**Files:**
- Create: `apps/web/app/(dashboard)/dashboard/editor/page.tsx` (thin wrapper, Suspense + useSearchParams)
- Create: `apps/web/components/editor/clip-editor.tsx` (state owner: track, trim, save flow)
- Create: `apps/web/components/editor/video-preview.tsx` (RAF time sync + overlay word highlight)
- Create: `apps/web/components/editor/subtitle-list.tsx` (cue rows: textarea, timing, split/merge, click-to-seek)
- Create: `apps/web/components/editor/trim-bar.tsx` (dual-handle range)
- Modify: `apps/web/app/(dashboard)/dashboard/clips/[id]/page.tsx` (replace TrimEditor with "Open editor" link)
- Delete: `apps/web/components/trim-editor.tsx`

Key behaviors (adapted from ClipSubs, `/tmp/clipsubs/Subtitling_app-main`):
- **RAF sync** (VideoPlayer.tsx ~156-188): rAF loop while playing, emit `currentTime` (seconds here, not ms) throttled to ~50 ms / 120 ms delta; seek-sync effect only writes `video.currentTime` when drift > 0.3 s.
- **Overlay highlight** (VideoPlayer.tsx ~263-276): active cue = `currentTime ∈ [start, end)`; if `cue.words`, wrap each word in a span, `text-yellow-300` when `currentTime ∈ [word.start, word.end]`.
- **Subtitle list**: plain scroll list (no virtualization), one row per cue: start/end number inputs (step 0.1), textarea auto-rows, Enter = split cue at cursor (time split proportional to character position; words partitioned by which side their midpoint falls on), Backspace at position 0 = merge with previous (concat text, drop words if either side lacks them - else concat), row click = seek to cue start, active row highlighted + scrolled into view (`scrollIntoView({block:"nearest"})`).
- **Trim bar**: dual-handle range 0..clip duration (seconds, clip-relative), drag handles update `trim.start/end`; rendered under the video; current-time playhead line; pointer events with `setPointerCapture`.
- **Save**: `api.clips.edit(clipId, { trim: {start: clip.startTime + trim.start, end: clip.startTime + trim.end}, subtitles: true, subtitleTrack: { cues } })` - note the PUT expects source-absolute trim (matches existing trim route semantics: `clipService.editClip` re-relativizes against `original.startTime`). Returns placeholder clip → poll `api.clips.get(newClip.id)` every 2 s until `storageKey !== ""` (cap ~5 min) → router.push to `/dashboard/editor?clip=<newId>` (or show inline "Re-rendered" + swap source).
- Editor loads: `api.clips.get(id)` + `api.clips.subtitles(id)`; video src via `api.clips.download(id)` presigned URL.
- Dark-only styling consistent with dashboard (`bg-white/[0.02]`, `border-white/[0.08]`, etc.). Page header: clip title + Save button + "Back to project".

- [ ] **Step 1: build components** (code authored at implementation time following the behaviors above - this is UI assembly on documented patterns, with the data contract fixed by Tasks 7-8)
- [ ] **Step 2: typecheck + manual smoke via `next build`**
- [ ] **Step 3: wire clip page link, delete trim-editor.tsx, fix imports**
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): subtitle/trim editor at /dashboard/editor"
```

---

## Phase 3 - Telegram bot link-out

### Task 10: "Edit in browser" button on delivered clips

**Files:**
- Modify: `apps/bot/src/telegram-client.ts` (`sendVideo` accepts optional `replyMarkup`)
- Modify: `apps/bot/src/i18n.ts` (add `editInBrowser` EN: "Edit in browser", RU: "Редактировать в браузере")
- Modify: `apps/bot/src/handlers.ts` (`deliverReadyTelegramJobs`)

- [ ] **Step 1: client**

```ts
async sendVideo(
  chatId: string | number,
  video: string,
  caption?: string,
  replyMarkup?: unknown
) {
  return this.request("sendVideo", {
    chat_id: chatId,
    video,
    caption,
    supports_streaming: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}
```

- [ ] **Step 2: handler**

In the delivery loop:

```ts
for (const clip of delivery.job.clips) {
  const url = await getPresignedDownloadUrl(clip.storageKey);
  await client.sendVideo(delivery.chatId, url, clip.title, {
    inline_keyboard: [
      [{ text: dict.editInBrowser, url: `${config.appUrl}/dashboard/editor?clip=${clip.id}` }],
    ],
  });
}
```

`deliverReadyTelegramJobs` currently has no `config` param - thread `config: BotRuntimeConfig` through from its caller (find with `grep -rn "deliverReadyTelegramJobs" apps/bot/src`).

- [ ] **Step 3: i18n + verify + commit**

Add `editInBrowser` to both locales in `i18n.ts` (match the existing dict structure). Run `npx vitest run`, bot typecheck.

```bash
git add -A
git commit -m "feat(bot): edit-in-browser button linking delivered clips to the web editor"
```

---

## Final verification

- [ ] `npx vitest run` - full suite green
- [ ] `npx tsc --noEmit -p apps/worker/tsconfig.typecheck.json` and web `next build` green
- [ ] `grep -rn "subtitlePreset\|SubtitlePreset" apps packages prisma --include='*.ts' --include='*.tsx' --include='*.prisma' | grep -v dist | grep -v migrations` → empty
- [ ] `docker compose up -d --build worker` (fonts + fontconfig land in the image) - then burn a real clip end-to-end if a test job is feasible
