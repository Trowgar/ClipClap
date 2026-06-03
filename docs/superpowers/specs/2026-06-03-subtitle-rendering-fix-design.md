# Subtitle Rendering Fix — Design

Date: 2026-06-03
Status: Approved (design), pending implementation plan

## Problem

The SUBTITLES step produces clips with no visible subtitles. Burn-in is enabled
(`job.subtitles === true`), FFmpeg exits 0, the clip uploads — but the captions
are invisible. Users perceive the feature as broken.

## Root Cause

The worker container has no fonts and no fontconfig. In
[apps/worker/Dockerfile](../../../apps/worker/Dockerfile) line 4 only
`ffmpeg python3 py3-pip openssl` is installed. The subtitle styles in
[apps/worker/src/processors/subtitles.ts](../../../apps/worker/src/processors/subtitles.ts)
request fonts that do not exist in Alpine:

- `tiktok` → Arial
- `minimal` → Arial
- `bold` → Impact

When libass cannot resolve a font it renders with a broken/empty fallback, and
because FFmpeg still exits 0 the failure is silent.

## Goal

Make the three existing presets render exactly as specified, so subtitles are
visible and match the defined styles. No redesign, no new presets, no word-level
"viral" captions — that is explicitly out of scope for this change.

### Non-Goals

- Word-level / karaoke captions (Whisper stays at segment granularity).
- User-facing style customization.
- Changing preset colors, sizes, or positions.

## Approach

### 1. Provide fonts in the container

Add to [apps/worker/Dockerfile](../../../apps/worker/Dockerfile) base stage:

```dockerfile
RUN apk add --no-cache ffmpeg python3 py3-pip openssl fontconfig font-liberation
```

`font-liberation` provides Liberation Sans, metrically identical to Arial and
registered by fontconfig under the `Arial` alias — this covers the `tiktok` and
`minimal` presets with no code change to their `fontName`.

### 2. Bundle Anton for the `bold` preset

Impact has no free equivalent in Alpine. Bundle the OFL-licensed **Anton**
(impact-like) font in the repo:

- Store at `apps/worker/assets/fonts/Anton-Regular.ttf`
  (source: Google Fonts, OFL — license file committed alongside it).
- Change the `bold` preset `fontName` from `"Impact"` to `"Anton"` in
  [subtitles.ts](../../../apps/worker/src/processors/subtitles.ts).
- Copy `assets/fonts` into the production image in the Dockerfile build/production
  stages so it exists at runtime.

### 3. Point libass at the bundled font dir

The `ass` filter only searches system fontconfig paths by default. Extend the
filter in `burnSubtitles` to include the bundled dir:

```
ass=filename=<escaped-ass-path>:fontsdir=<escaped-fonts-dir>
```

so `Anton` resolves regardless of fontconfig state.

### 4. Stop silent failures

Harden `burnSubtitles` in [subtitles.ts](../../../apps/worker/src/processors/subtitles.ts):

- Capture FFmpeg `stderr`; on a non-zero exit include it in the thrown error.
- After the run, assert the output file exists and is non-empty; throw otherwise.

This converts a future "invisible subtitles" regression into a loud failure
instead of a silently shipped bad clip.

## Files Touched

- `apps/worker/Dockerfile` — install fonts; copy bundled font dir into image.
- `apps/worker/src/processors/subtitles.ts` — `bold` fontName → `Anton`;
  add `fontsdir`; capture stderr; validate output.
- `apps/worker/assets/fonts/Anton-Regular.ttf` (+ `OFL.txt`) — new bundled asset.
- `apps/worker/src/processors/__tests__/subtitles.test.ts` — extend if the
  generated filter/ASS string changes.

## Verification

1. Rebuild the worker image (`docker compose build worker`) and confirm the build
   installs fonts without error.
2. Run one real job per preset (`tiktok`, `minimal`, `bold`) end to end.
3. Eyeball each output clip: subtitles visible, correctly positioned, and the
   `bold` clip uses the Anton/impact-like face.
4. Confirm a forced font-resolution failure now throws (manual sanity check), not
   a silent exit 0.

## Risks

- `font-liberation` not in the pinned Alpine repo snapshot → fall back to
  `ttf-liberation` / `ttf-dejavu`; verify package name at build time.
- Arial→Liberation alias not auto-registered → set `tiktok`/`minimal` `fontName`
  explicitly to `"Liberation Sans"`.
- Anton glyph coverage for Cyrillic is limited (Latin-focused). Russian-language
  clips with the `bold` preset may show tofu; acceptable for MVP, noted for a
  later Cyrillic-capable bold font.
