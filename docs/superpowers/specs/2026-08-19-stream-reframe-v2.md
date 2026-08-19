# Stream reframe v2: the two-tile layout must fire on real streams (2026-08-19)

Owner feedback on a rendered sample (Twitch strogo, CS2, corner cam): the cam
should stretch full width (no gap beside it), the game tile must show the
ACTION (crosshair visible), and "what about other games / a streamer watching
videos". All three are properties the existing two-tile stream layout already
has - the problem is that it almost never fires: ONE real job ever used it
(Leonardo, 2026-08-11), because the classifier gates it behind faceFrac < 0.06
and the rect detector misses common cam styles. v1's thresholds all rest on a
single deleted fixture (engine-notes §7a states this plainly).

## 1. The corpus (collected 2026-08-19, .corpus/stream-v2/probes/)

Downloaded through WARP (+PO token for YouTube), 720p or source. POSITIVE =
a human wants the two-tile layout; CONTROL = current behaviour is correct.

| file | content | cam | faceFrac | expected |
|---|---|---|---|---|
| strogo.mp4 (40s, 1280x720) | CS2 | corner-flush top-left, ~352x162 src | 0.077 | POSITIVE two-tile |
| tox_4X88jJU.mp4 (31s, 640x360) | JesusAVGN react: watches YouTube | bottom-right, borderless-ish, tight face-cam ~84x92 | 0.076 | POSITIVE two-tile |
| Rtt2StnXpxw.mp4 (47s, 640x360) | Minecraft | floating top-left, purple border | 0.036 | POSITIVE (works today) |
| tw-recrent.mp4 (30s, 1280x720) | Elden Ring | floating mid-left, bordered | 0.034 | POSITIVE (works today, score 4.47 vs threshold 4.0 - margin-thin) |
| llHwLxzg_Fk.mp4 (33s) | Dota, no cam | - | 0 | CONTROL faceless -> centre |
| 8sMckL_u1n4.mp4 (20s) | DOMER fullscreen face | - | 0.165 | CONTROL normal_face |
| tw-buster.mp4 (16s) | buster fullscreen IRL | - | 0.089 | CONTROL normal_face (the source that FORBIDS naive threshold raising) |

Source URLs and GT labels: .corpus/stream-v2/README.md. The autopsy tool
(probe_cam_rect.py, same maths as the sidecar, per-constraint verdicts on a
hand-labeled GT rect) lives beside the corpus and graduates to
assets/reframe/ in task A.

## 2. Measured baseline (stock prod config, then FACE_SMALL forced to 0.30)

- strogo: normal_face stock; forced -> stream_no_rect. AUTOPSY: both true
  borders ARE in the peak lists (x1=175 exact, y1=80/81), true sides score
  15.09/20.17 vs edge_min 4.0 - the kill is CONTAINMENT: need_y1 =
  faceBottom + 0.02*W = 82.8 > true border 81. The 2%-of-frame-width margin
  pushes the required rect past the true border of any tight cam. With margin
  0 a rect IS found but the WRONG one - x0..309 sprawl over the HUD, score
  4.04, beating the true 175-wide rect (score 15.09) on LARGEST AREA.
- tox: normal_face stock; forced -> stream_no_rect. AUTOPSY: three
  independent kills - true x0/y0 borders MISSING from the top-12 peaks
  (crowded out by the watched video's static edges), true sides score
  0.31/0.62 (borderless overlay - edge detection cannot see this cam class at
  all), and rect area 7728 < 4*face 10780 (tight face-cam breaks the 4x rule).
- Rtt2StnXpxw / tw-recrent: class stream TODAY, scores 6.23 / 4.47. The
  detector is not blind - floating bordered cams work.
- Controls hold: llHw faceless, DOMER/buster normal_face; forced-0.30 run
  proves buster (0.089) degrades to centre crop if the face gate is naively
  raised - rect-first ordering is mandatory, a bigger threshold is not.

## 3. Design

**D1 - containment margin must not overshoot the cam border.** Containment
requires the rect to contain the FACE BOX only (margin 0 in need_*). The
margin's anti-degenerate job moves to D2's selection rule. (Measured: the 2%W
margin is the sole strogo killer.)

**D2 - selection = score-dominance filter, then largest area.** Among
candidates clearing edge_min, drop those scoring below HALF the best
candidate's score; among survivors pick largest area (tie-break score).
Fixes strogo (true 15.09 vs sprawl 4.04 - sprawl filtered), keeps the v1
fixture behaviour (true 5.65-8.84 vs false 1.54), keeps Rtt/recrent (single
dominant candidates). The 4x-face-area rule RELAXES to 1.5x (tox-class tight
cams; degenerate rects are now killed by dominance instead).

**D3 - peaks budget: TRIED AND REVERTED same day (2026-08-19).** The
hypothesis was that tox's borders ranked outside the top-12. Measured: they
are ABSENT at any budget - a borderless overlay has no static straight edge
to rank (D4 is the only mechanism for that class). Meanwhile budget 24
ADMITTED a weak sub-border (raw 132 vs the true border's 452) on the real v1
CS2 fixture; D2's /2 dominance passes it at a 1.28x ratio and largest-area
then picks cam + 58px of gameplay - re-creating the exact "gap under the
cam" defect this spec exists to kill. strogo never needed it (its true
borders already ranked in the top-12; only D1+D2 were load-bearing).
BORDER_CANDIDATES stays 12; the reversal note lives on the constant.

**D4 - virtual cam tile for borderless cams (flag REFRAME_STREAM_VIRTUAL_CAM,
exact literal "on").** When stream is on, faceFrac is under the ceiling (D5),
and NO rect was found or resolved: synthesize a camRect from the face box -
width = 3.2x face width centred on the face, height = 16:9 of that width,
top at faceTop - 0.55*faceHeight (headroom), clamped to frame - and feed it
to the EXISTING solveStreamGeometry/streamContentX path. This is the only
mechanism that can ever serve tox-class borderless cams and chroma-key
streamers (edge detection has nothing to find - measured 0.31/0.62). The
multipliers are provisional; the corpus harness renders decide them. OFF by
default in code; .env enables after corpus verification.

**D5 - classifier: rect-first under a ceiling.** In plan.ts, when
cfg.stream is on and 0 < faceFrac < REFRAME_STREAM_FACE_CEILING (default
0.15): resolve the cam rect; if a rect (real, or D4-virtual when that flag is
on) yields a solvable geometry -> class "stream". Otherwise fall through to
the EXISTING chain unchanged (normal_face at >= faceSmallFrac, small_face
below). faceSmallFrac stays 0.06 and keeps its unconditional anchor-guard
role. Ceiling rationale: strogo/tox sit at 0.077; podcasts are 0.15-0.30;
buster at 0.089 is safe because no rect resolves on a fullscreen face
(measured) - and DOMER at 0.165 sits above the ceiling entirely.

**D6 - content tile shows the action.** streamContentX already biases the
content crop toward sourceWidth/2 inside the free band (game centre =
crosshair). Add the missing test that pins this and a corpus assertion that
the game-centre column is inside the content crop for every positive.

## 4. Hard rules

- REFRAME_STREAM unset/off: byte-identical plans everywhere (existing tests
  + corpus harness OFF run).
- The 9 pre-existing layout assertions in reframe-plan.test.ts keep their
  byte-identical expected values - they are podcast/normal_face cases no
  ceiling change may touch (all their faceFracs exceed 0.15 or route
  identically).
- Controls: llHw stays faceless/centre; DOMER and buster stay normal_face
  with UNCHANGED plan output, stock config, before and after.
- python detector changes come with test_cam_rect.py cases for: margin
  overshoot (strogo shape), dominance vs sprawl (score 15 vs 4 fixture),
  relaxed area (tight cam), peaks crowding (border at rank 13-24).
- Implementer agents: no docker compose up/restart/down, no .env edits, no
  prisma, no DB/R2 writes. Tests run via docker compose exec -T worker-render.
  Python: python3 -m pytest is NOT installed - test_cam_rect.py runs as a
  plain script (python3 assets/reframe/test_cam_rect.py), follow its existing
  conventions.
- Every mechanism-guarding test gets a mutation check before it counts.

## 5. Tasks

- **A (python detector):** D1+D2+D3 in detect_faces.py find_cam_rect +
  test_cam_rect.py cases + probe_cam_rect.py moved to assets/reframe/.
  Acceptance: strogo autopsy finds a rect within 4px of GT with dominant
  score; tox borders appear in peaks (its rect may still fail on sides -
  that is D4's job); Rtt/recrent still found; v1 synthetic fixtures in
  test_cam_rect.py still pass unmodified.
- **B (classifier):** D5 in plan.ts + config knob + TS tests (rect-first
  attempt, ceiling boundary at exactly 0.15, buster-shaped no-rect fall
  through, stock-config parity for every control).
- **C (virtual cam):** D4 in plan.ts (+ types/telemetry: profile reason
  "stream_virtual_cam") + flag + TS tests. After A+B land.
- **D (corpus harness):** script eval-stream-corpus.ts - runs every corpus
  entry, prints class/reason/score/detectMs table, writes contact sheets,
  and an OFF-parity assertion. Read-only over .corpus/stream-v2.
- **E (validation + delivery, orchestrator):** corpus renders of all four
  positives, owner review via bot, .env enablement + worker-render recreate,
  engine-notes §7a update, memory.
