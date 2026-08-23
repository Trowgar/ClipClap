# Music shorts: the hook window, measured (2026-08-23, MEASUREMENT PHASE DONE)

## BUILD SHIPPED same day (commit 38cd68f, LIVE behind MUSIC_SHORTS=on)

M1 TRANSCRIBE persists the per-second RMS envelope in its step output (a
failed pass degrades to [], never a job failure; sources past ~35-40 min
overflow the child buffer and degrade the same way - irrelevant under the
8-min music cap). M2 music-hook.ts is the faithful TS port + energy-valley
edge snapping (12s floor); full parity re-verified: all three labeled
tracks keep the Apple hook inside the shipped windows through the
production path (Believer ships 120-138 + 53-77; the latter overlaps the
hook zone by 15s). M3 wires the stage: song gate fired + single track
<= 480s -> 2 "Hook N" highlights on the normal render rails, job subtitles
OFF, no-signal falls through to the old refusal byte-for-byte. M4 render
forces stream/virtualCam OFF for music jobs (measured: virtual cam split
Baby Shark's dance video into two tiles; the fixed render is a clean
full-frame vertical crop). 1672 tests, 8 mutation checks.

## DIRECTION v1 shipped same evening (commit 3258dcc, owner-requested)

Owner review of the first demos named the defects; each fix measured:
R2 luma envelope at TRANSCRIBE + dark-aware window shift/edge guard
(Believer's window moved 53-77 with NINE near-black seconds to 61-75 with
one); R1 constant-bar crop behind the 90%-agreement consistency rule
(Believer 72px/side 8/8 exact; Baby Shark honestly 0/0 - transient class
never cropped); R3 odd-shot 1.08x punch-in via the enable-gated overlay
idiom (montage energy from the MV's own beat-cut edits, never continuous
camera motion); R4 0.25s AV fades. All music-only, one musicDirection
object in the render stage, no env knobs, frozen geometry oracles
untouched. 1720 tests.

Open seams, recorded: renderTrim (clip edit path) does not re-apply the M4
override; letterboxed MVs keep their bars (the known director-audit item);
'Hook N' copy is placeholder pending owner wording; corpus still n=3
labeled (Miyagi iTunes mismatch).

## 0. How the demand actually looks (reclassified 2026-08-23)

The "45% music" reading of the song-gate population was half wrong. Real
composition of the 10 song-gate jobs from 2026-08-20..23: TWO were a Hindi
STANDUP refused by a Whisper hallucination loop ("lol" x807, 756 adjacent -
laughter transcribed as text) - fixed same day by another session's
MIN_LINE_TOKENS=2 (commit 6e8d919), verified live on the stored transcripts
(rep 0.91 -> 0, gate passes). One was Baby Shark (a test), one ambient
nature sounds, one 60-min Japanese scream-compilation (now passes the gate
post-fix). The REAL music-clipper: one user, three genuine music videos in 5
minutes ("Rain drops...", "Hold on tonight...", a Леонтьев compilation),
three refusals, gone. Demand is real but modest: ~1-2 users/week today.

## 1. The mechanism, validated 3/3 against an industry label

**Detector (deterministic, zero ML, zero LLM):** 20s windows scored by
  - lyric REPETITION AT DISTANCE (>= 2 occurrences >= 25s apart, lines >= 2
    tokens - the song gate's own one-token-junk lesson), weight 2.0;
  - per-second RMS energy z-score (ffmpeg astats), weight 1.0;
top-3 windows over DISTINCT regions (an adjacent shift of the same chorus
must not crowd out the runner-up region - measured on Blinding Lights).

**Label: the iTunes 30s preview position.** Apple picks the hook
algorithmically; `align-preview.py` locates it in the full track by
normalized cross-correlation of 0.5s RMS envelopes (peaks 0.75-0.90, sharp).
A reusable labeling tool for any audio-hook question.

**Result: 3/3 corpus tracks have an Apple-hook overlap (>= 10s) inside the
top-3 windows** (Blinding Lights 20s, Believer 13s, Baby Shark 19s - the
latter on ENERGY alone, rep 0: the kids-chant class is carried by the second
signal, which is why the rule is a sum, not a single signal).

**Measured dead ends, recorded:**
  - YouTube "most replayed" heatmaps label VIDEO moments (Believer's fight
    intro, Baby Shark's dance shot), not audio hooks - top bins sat at
    15-27s on 2 of 4 tracks regardless of where the chorus lives. Useless as
    the hook label; possibly useful later for picking VISUALS within a hook.
  - "First occurrence of a repeated line" scoring (hook-intro theory): 0/4.
  - t=0 heatmap de-bias helps nothing for hook labeling (the bias is real
    but the de-biased label still points at video moments).

Corpus + tools: `apps/worker/.corpus/music-shorts/` (chorus-detect.py,
align-preview.py, 5 tracks + transcripts + heatmaps + previews). Known gap:
n=3 labeled (iTunes matched the wrong Miyagi track - needs a better search
term or Deezer fallback); grow to 6-8 incl. RU tracks before integration.

## 2. Build phase (next заход, NOT started)

Where the song gate fires today AND the source is a single track (<= ~8 min;
compilations like the Леонтьев best-of are a scope decision): run the
detector, cut the top 1-2 windows, snap edges to energy valleys, reframe
with the EXISTING engine (performer faces), subtitles OFF in v1 (word
timings on singing are unreliable), deliver marked as music shorts. Behind
MUSIC_SHORTS flag, exact literal, corpus-accepted first. Owner decisions
pending: how many shorts per track, subs off vs line-level, minutes charged
as usual, compilations in or out.

## 3. Related finding shipped along the way

The standup users (2 accounts, 1.3M-view video, zero clips each) are
recoverable: the gate now passes their video. Re-running their jobs as a
goodwill delivery is an owner decision - flagged, not done.
