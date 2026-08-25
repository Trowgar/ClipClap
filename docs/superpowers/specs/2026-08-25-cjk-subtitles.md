# CJK + Devanagari subtitles: tofu boxes on every non-Latin/Arabic job (2026-08-25, SHIPPED: fonts+chunking 80860a7, black-tail trim 586fe7d)

Owner approved "делаем" 2026-08-25 after the round-2 feedback audit.

## Defect (verified on real clips)

Two NO verdicts from a Japanese user (job cmt8gxsx4, anime upload): every
subtitle cue renders as .notdef boxes ("□□□" for だめか) - confirmed by eye
on both clips. A Hindi job the day before (cmt7e24cl, 2 clips delivered)
carries the same defect silently.

Mechanism (subtitle-script.ts:17-40, subtitles.ts:88-91/747/756/820/847):
font choice is script-keyed and knows exactly one non-Latin script -
Arabic (Tajawal); everything else falls to Montserrat (Latin/Cyrillic).
The worker container has NO other fonts anywhere (fontconfig database
empty, fc-list returns nothing for every language); libass loads only the
files in apps/worker/assets/fonts/ (Montserrat-Bold.ttf, Tajawal-Bold.ttf)
via ass=...:fontsdir=. Arabic works because it is NAMED, not because of
fallback. So ja/zh/ko/hi have no code path that ever selects a font with
their glyphs - nothing to wire, a font must be added.

Second defect, latent behind the first: Whisper returns single-character
"words" for Japanese (real transcriptJson: "今だ" -> ["今","だ"]), so the
chunker's MAX_CHUNK_WORDS=3 would produce 1-3-character flicker cues once a
font renders; and MAX_CHUNK_CHARS=18 was measured for Montserrat/Tajawal
glyph widths only - full-width CJK glyphs are ~1.8x wider per character.

Blast radius (DB, DONE with clips): ja 1 job/1 user/2 clips, hi 1/1/2.
zh/ko/th/he never reached clips. Denominator: en 24 jobs, ru 18, ar 9, fr 4,
id 3, pt 2.

## Fix (no image rebuild, no flag - strictly corrective)

1. Fonts: add OFL static Bold files to apps/worker/assets/fonts/ (the dir
   is bind-mounted into every worker and re-resolved per render, so a new
   file is live on the next job): Noto Sans JP, Noto Sans SC, Noto Sans KR
   (language-specific subset OTFs, ~5MB each - NOT the 16MB pan-CJK OTFs,
   NOT the Super OTC), Noto Sans Devanagari Bold. Append their OFL headers
   to apps/worker/assets/OFL.txt (the Tajawal precedent at line 96).
2. subtitle-script.ts: a script map beside ARABIC_SCRIPT_LANGUAGES -
   ja -> "Noto Sans JP"; zh, zh-*, yue -> "Noto Sans SC" (Traditional
   readers get SC glyph forms - accepted for v1, recorded); ko -> "Noto Sans
   KR"; hi, mr, ne, sa -> "Noto Sans Devanagari". The Fontname MUST equal
   the family name inside the font file (libass matches the ASS Style
   Fontname against the loaded files' name tables) - verify with the
   existing real-ffmpeg raster test pattern
   (subtitle-font-render.test.ts): two different Japanese strings under the
   JP font must produce DIFFERENT rasters, and a Japanese string under the
   JP font must differ from the same string under Montserrat (the tofu
   raster). That is the mechanism-overcomes-default guard.
3. Chunker per-script parameters (subtitles.ts:58-59): for CJK languages
   the word cap must not bind - raise it so the character cap governs, and
   set a CJK character cap MEASURED for the JP font at the style's size
   (replicate the 18-char derivation in the subtitles.ts:34-56 comment
   block; expected ~9-10 full-width chars). Devanagari words are space
   delimited and multi-char - keep Latin params. Mutation-tested: dropping
   the CJK branch must go red.

Deploy note: assets and code hot-reload; the retry-idempotency fix
(4b0fb99) makes a mid-render reload survivable, but deploy between renders
anyway. Goodwill re-render of the two affected jobs after the fix is an
orchestrator step (old tofu rows soft-deleted by hand first - they carry
telegramFileId and the cleanup deliberately spares delivered rows).

## Also from the same feedback round, NOT in this fix

- French EDIT/CUTOFF (job cmt8155fa, clip 57.9-75.1): exit snapped to the
  first payoff-like sentence ("il vient de mourir") + 0.3s; the source
  cuts to black for 3.5s right there and the real payoff (18 years in the
  airport) sits at 78-93s across the gap. Third labeled exit-extension
  example, new subtype "gap-crossing". Cheap hygiene candidate: never end a
  clip on black frames (luma envelope exists since music direction R2).
- Stream analyze mode density false positives: 3 stream-mode jobs this
  week, 1 real stream; the French documentary (speech 538/1322 = 0.41) and
  a Drive upload (0.47) passed under STREAM_DENSITY_MAX 0.55 - edited videos
  with music beds are density-indistinguishable from streams. Resolver
  logs no reason. Measurement candidate: speech-segment structure
  (narration = long segments with music gaps; streams = short bursts).
- Anime: scdet blind on a uniform palette (6 source shots -> 3 plan shots
  in 19s), face anchor carried across a merged shot onto a faceless scene.
  Same family as the cops tail; mechanism A measured dead 2026-08-24; anime
  is outside the target audience - accepted, recorded.
- All three clips rendered after the 2026-08-24 deploys: no trace of the
  coverage gate or tail-keep (correct - not their cases), saliencyShadow
  recorded on every center shot.

## Black-tail trim (measured 2026-08-25, design decided)

Prevalence: lumaEnvelope exists on jobs since 2026-08-24 03:36 (8 jobs, 10
clips measurable; 0/8 degraded to [] even at 22 min). END luma < 40: 1/10 -
exactly the French clip (second 75 = 17.2, second 74 = 38.9); START: 0/10.
Ground truth (blackdetect d=0.1 pix_th=0.10 on the evidence mp4): one
interval 16.92-17.12s of 17.16 - a 0.2s black window. The 1 fps envelope
saw it by luck (single frame sample per second, not an average - a 0.2s
flash elsewhere in the second is invisible). Correction: DARK_LUMA_THRESHOLD
lives in music-hook.ts:118, private to music shorts - snap.ts/cut.ts read no
luma at all today.

Design (B), decided: RENDER-side probe in processors/cut.ts - before
building the cut args, run blackdetect over the last ~2s of the clip window
(-sseof style seek on the source at [end-2, end]); if a black interval
starts inside the final 1.5s, trim the cut end to black_start minus a small
margin; never trim more than 1.5s and never below the clip floor. Measured
cost 0.31-0.38s wall per clip (vs ~2s+ for the cut itself). Envelope-based
snapping (A) rejected: 1s granularity would delete up to 1s of good
content to dodge a 0.2s flash, and it is blind where the envelope degrades.
Head trim skipped (0/10, YAGNI). Behind exact-literal flag
RENDER_BLACK_TAIL_TRIM=on; off byte-identical; mutation-tested.

## SHIP NOTE (2026-08-25)

- CJK/Devanagari fix: commit 80860a7, live on the next render (bind-mounted
  fonts + hot-reloaded code, no flag). Reviews: spec compliant (reviewer
  reproduced the 15/16 glyph measurement), quality approved. Refinement
  after first pass: CJK cues joined WITHOUT spaces on both the text and the
  karaoke path, cap counted in glyphs (13; 15 fit, 16 clip). Goodwill
  re-render of the ja + hi jobs executed per the runbook in
  .corpus/feedback-audit/goodwill/ (old tofu rows soft-deleted by hand,
  delivery re-armed).
- Black-tail trim: commit 586fe7d, RENDER_BLACK_TAIL_TRIM=on armed in .env,
  worker-render recreated. Spec review found and the implementer fixed four
  issues: applied-trim cap (was reachable 1.54s), tolerance 0.15 -> 0.08
  (ffmpeg 8.0.1 always flushes black_end - the null branch was dead and the
  tolerance IS the decision; adversarial 0.13s case now refuses), probe
  timeout 5s, realistic fixtures + probe argv shape test.
- Process finding: worker-render crash-restarted 4x on implementers'
  intermediate file states (TransformError). No render in flight - no harm.
  Rule recorded in memory: implementers land complete transpile-checked
  files atomically.
- Stream resolver density fallback: measured precision 11% (3/27) on the
  54-job corpus; candidate v2 rule density<0.45 AND median segment<2.8s AND
  reliable-word floor -> 75% precision, 3/3 recall, n=3 true streams.
  Awaiting owner decision as a separate item.
