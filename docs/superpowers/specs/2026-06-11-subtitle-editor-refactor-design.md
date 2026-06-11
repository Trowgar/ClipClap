# Subtitle Refactor — Drop Style Presets, Add a Simple Web Editor

Date: 2026-06-11
Status: Design approved (direction). To be implemented in a separate session.
Supersedes: `2026-06-03-subtitle-rendering-fix-design.md` (the font fix is folded in
here as Phase 0).

## TL;DR for the implementer

This document is a "what goes where" map for a refactor of ClipClap's subtitle
feature. Read it top to bottom, then implement phase by phase (Phase 0 ships value
on its own). Reference techniques come from a separate inspiration app, ClipSubs
(`Subtitling_app-main`, a React+Supabase subtitle editor) — file paths to it are
prefixed `[ref]`. ClipSubs is preview/export only; ClipClap must still burn
subtitles into the final MP4 server-side, so we adapt its ideas, not copy it.

## Product decision

1. **Remove subtitle style presets.** No more `tiktok` / `minimal` / `bold` choice.
   The UI keeps a single **Subtitle on/off checkbox**. When on, clips are generated
   with one good default burned-in style.
2. **Add a simplified web editor.** If a user wants to refine a clip, they open an
   editor (similar to ClipSubs, but trimmed down): **trim the video** + **manage
   subtitles** (edit text, fix timing, split/merge). On save, the clip is
   re-rendered server-side with the edited subtitles burned in.
3. **Telegram bot has no editor.** The bot generates clips with the default
   subtitles; editing is web-only. The bot links out to the web editor. This is an
   accepted limitation.

## Scope / Non-goals

In scope: removing presets, one default burned style that actually renders
(fonts!), word-level timestamps, an editable per-clip subtitle track, a re-render
path that burns edited subtitles, and a simplified web editor.

Out of scope: multi-user realtime collab (ClipSubs has it; we don't need it),
speaker diarization, translation/dubbing, SRT/VTT/STL export, in-Telegram editing,
per-user style customization UI.

## Current state (where things are today)

- Burn logic + presets: [apps/worker/src/processors/subtitles.ts](../../../apps/worker/src/processors/subtitles.ts)
  — `PRESETS` map, `generateAss()`, `burnSubtitles()`.
- Render stage (auto clips + existing re-trim path):
  [apps/worker/src/stages/render.ts](../../../apps/worker/src/stages/render.ts)
  — `renderClips()` burns when `job.subtitles`; `renderTrim()` already re-renders a
  single clip from a stored source. `RenderStagePayload` in
  [apps/worker/src/stages/types.ts](../../../apps/worker/src/stages/types.ts) has a
  `mode: "trim"` variant.
- Transcription: [apps/worker/src/processors/transcribe.ts](../../../apps/worker/src/processors/transcribe.ts)
  — Whisper `timestamp_granularities: ["segment"]` (no word timings).
- Types: [packages/shared/src/types/index.ts](../../../packages/shared/src/types/index.ts)
  — `WhisperSegment`, `TranscriptionResult`, `SubtitlePreset`.
- DB: `prisma/schema.prisma` — `Job.subtitles`, `Job.subtitlePreset`,
  `Clip.subtitles`, `Clip.subtitlePreset`, `Clip.parentClipId`/`retrims`.
- Web: clip page `apps/web/app/(dashboard)/dashboard/clips/[id]`, APIs
  `apps/web/app/api/clips/[id]`, `.../[id]/trim`, `.../[id]/download`.
- Container fonts: [apps/worker/Dockerfile](../../../apps/worker/Dockerfile) — only
  `ffmpeg python3 py3-pip openssl`, **no fonts** (root cause of invisible subs).

---

## Phase 0 — Make default subtitles actually render (ships alone)

Goal: one default style, visible, Cyrillic-capable, no presets. This already fixes
the "subtitles don't work" bug and is independently shippable.

### 0.1 Fonts in the container
[apps/worker/Dockerfile](../../../apps/worker/Dockerfile) base stage:
```dockerfile
RUN apk add --no-cache ffmpeg python3 py3-pip openssl fontconfig
```
Bundle **one** Cyrillic-capable bold font in the repo (RU+EN audience — Anton/Impact
are Latin-only, rejected). Recommend **Montserrat-Bold.ttf** (OFL, has Cyrillic) or
Inter. Store at `apps/worker/assets/fonts/`, commit the OFL license, and `COPY` the
dir into the build/production image stages so it exists at runtime.

### 0.2 One default style
In [subtitles.ts](../../../apps/worker/src/processors/subtitles.ts) delete the
`PRESETS` map and `SubtitlePreset` usage; replace with a single `DEFAULT_STYLE`
constant: Montserrat Bold, white fill, black outline (~3px), bottom-centered,
`marginV` ~80 on a 1080x1920 canvas. Point libass at the bundled dir via the filter:
`ass=filename=<ass>:fontsdir=<fonts-dir>`.

### 0.3 Word-level timestamps (the foundational unlock)
[transcribe.ts](../../../apps/worker/src/processors/transcribe.ts): change to
`timestamp_granularities: ["segment", "word"]` and capture `response.words`.
Extend types in [packages/shared/src/types/index.ts](../../../packages/shared/src/types/index.ts):
```ts
export interface SubtitleWord { text: string; start: number; end: number } // seconds
export interface WhisperSegment { start: number; end: number; text: string; words?: SubtitleWord[] }
```
(Mirrors ClipSubs `[ref] types.ts` `SubtitleWord` / `Subtitle.words?`, but in
seconds to match the rest of our pipeline.) Word timings enable both the karaoke
burn and the editor highlight. If Whisper word output is unreliable, fall back to
segment-only rendering — keep the burn working without words.

### 0.4 Harden the burn (no more silent failure)
In `burnSubtitles`: capture FFmpeg `stderr`, throw it on non-zero exit, and assert
the output file is non-empty. Today libass fails silently and ships a blank clip.

### 0.5 Drop presets from the model
- Prisma: remove `Job.subtitlePreset` and `Clip.subtitlePreset` (migration). Keep
  the `subtitles` boolean on both.
- Remove `SubtitlePreset` from shared types, `RenderStagePayload.trim.subtitlePreset`
  in [stages/types.ts](../../../apps/worker/src/stages/types.ts), and the
  `preset`/`subtitlePreset` plumbing in
  [render.ts](../../../apps/worker/src/stages/render.ts),
  `CreateJobInput`/`TrimClipInput`, the create-job API, and the upload UI.
- Update [subtitles.test.ts](../../../apps/worker/src/processors/__tests__/subtitles.test.ts).

After Phase 0: the checkbox-driven default subtitles render correctly. Optional
within Phase 0: emit the active word in a highlight colour using the word timings
(ASS `\k`/`\kf` karaoke tags or per-word `Dialogue` events) for the "viral" look.

---

## Phase 1 — Editable per-clip subtitle track + re-render

Goal: subtitles become editable data attached to a clip, and a clip can be
re-rendered from that data. No UI yet — API + worker only.

### 1.1 Store the editable track
Add `Clip.subtitleTrack Json?` (migration). Shape (the editor's working format):
```ts
export interface SubtitleCue { id: string; start: number; end: number; text: string; words?: SubtitleWord[] }
export interface SubtitleTrack { cues: SubtitleCue[] }
```
When `renderClips()` first burns a clip, persist the cues used (the transcript
segments sliced to the clip window, already computed in `generateAss`) into
`Clip.subtitleTrack`. This gives the editor something to load. (Mirrors ClipSubs
`[ref] types.ts` `SubtitleTrack`/`Subtitle`.)

### 1.2 burnSubtitles from an explicit track
Refactor `generateAss`/`burnSubtitles` to accept a `SubtitleCue[]` directly instead
of always deriving from raw Whisper segments + clip offsets. Auto-render passes the
derived cues; the editor re-render passes the edited cues. One code path, two
callers.

### 1.3 Extend the re-render path
The `mode: "trim"` payload in [stages/types.ts](../../../apps/worker/src/stages/types.ts)
and `renderTrim()` in [render.ts](../../../apps/worker/src/stages/render.ts) already
re-render one clip from a stored source. Extend it to also accept an optional edited
`subtitleTrack` and (a) trim to the new range, (b) burn the edited cues. Reuse the
`parentClipId`/`retrims` pattern so the original clip is preserved.

### 1.4 API
- `GET /api/clips/[id]/subtitles` → returns `Clip.subtitleTrack`.
- `PUT /api/clips/[id]` (or new `.../[id]/edit`) → accepts `{ trim?: {start,end}, subtitleTrack }`,
  validates ownership + plan limits, enqueues the extended render job. Model it on
  the existing [/api/clips/[id]/trim](apps/web/app/api/clips/[id]/trim) route.

---

## Phase 2 — The simplified web editor (React)

Goal: a focused editor at `apps/web/app/(dashboard)/dashboard/clips/[id]/edit`.
Two panels: video preview (left) + subtitle list (right), trim bar under the video.
Adapt these ClipSubs techniques (all `[ref]` = `Subtitling_app-main`):

- **RAF time sync** — `[ref] components/VideoPlayer.tsx` (lines ~156-188): a
  `requestAnimationFrame` loop emits throttled `currentTime` (ms). Reuse verbatim;
  it drives the live highlight cheaply.
- **Active-word highlight** — `[ref] components/VideoPlayer.tsx` (lines ~263-276):
  render `cue.words`, highlight the one where `currentTime ∈ [word.start, word.end]`.
  Preview-only in the browser (the burned MP4 comes from the server re-render).
- **Virtualized subtitle list + click-to-seek + split/merge** —
  `[ref] components/SubtitleList.tsx`: `@tanstack/react-virtual`, Enter = split at
  cursor, Backspace-at-0 = merge with previous, click a word = seek. Keep these;
  drop CPL gutters / speaker colours / grammar flags unless trivial.
- **Trim bar**: simple dual-handle range over the clip duration (the data already
  exists via `Clip.startTime`/`endTime`; trim re-render path exists from Phase 1).

Save button → calls the Phase 1 PUT endpoint → shows "re-rendering" → swaps in the
new clip when the job finishes (reuse the existing job/clip polling/stream the
dashboard already uses, e.g. `apps/web/app/api/jobs/[id]/stream`).

Stack note: ClipClap web is Next.js 15 + shadcn/ui + Tailwind (dark only). Build the
editor with those, not ClipSubs' raw Vite setup. Don't pull in Supabase/Realtime.

---

## Phase 3 — Telegram bot link-out

After a clip is delivered, add an "Edit in browser" button deep-linking to the web
editor URL for that clip (auth via the existing telegram-link flow under
`apps/web/app/api/auth/telegram`). No editing inside Telegram.

---

## Suggested order & shippability

- **Phase 0** alone fixes the live bug and removes presets — ship first.
- **Phase 1** is backend plumbing for editing — ship without UI (testable via API).
- **Phase 2** is the bulk of the work (frontend) — own PR.
- **Phase 3** is small polish.

Each phase is its own spec→plan→implementation cycle in the new session.

## Decisions baked in (override if you disagree)

- One bundled Cyrillic-capable bold font (Montserrat Bold) instead of Latin-only
  Impact/Anton — because the audience is RU+EN.
- Editable subtitles stored as JSON on `Clip` (not a separate `SubtitleCue` table) —
  simplest for MVP; revisit if cue-level queries are ever needed.
- Re-render burns server-side (extends the existing trim path) rather than
  client-side canvas/MediaRecorder — keeps a single source of truth for output MP4s.
- Word timings captured now even though editor v1 edits at the cue (segment) level —
  they're a cheap unlock and power the highlight preview + optional karaoke burn.

## Risks

- Whisper word-level timing can be noisy on music/cross-talk; keep a segment-only
  fallback so the burn never hard-fails on missing words.
- `Clip.subtitleTrack` JSON can grow for long clips; fine for MVP, watch row size.
- Re-render cost: each edit re-encodes a clip. Acceptable; consider debouncing saves.
- Font path resolution must work in both dev (tsx from `src`) and prod (node from
  `dist`) — resolve the bundled `fontsdir` via an absolute path / env, not a path
  relative to the compiled file.
