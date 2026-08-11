# Scan recall remedy: window budget from sourceSec (design)

2026-08-11. Driven by the selection autopsy's first tables (spec
`2026-08-11-selection-autopsy.md`, instrument committed `8d67ab8`), which turned §6a's suspicion
into a measured verdict on `podcast-nuclear`:

```
kill histogram over 12 labeled moments:
  shipped 4   scan_miss 4   snap_drop 2   nms_drop 1   critic_rejected 1
```

**All three 3/3 scout-consensus missed moments die at SCAN** - the nearest raw candidate is
36-56 seconds away, so these are not window-edge artifacts but regions the scanner never
proposed anything in. The critic killed one moment in twelve. The precision half ("clips no
scout chose") showed nothing anomalous loving them - ordinary interest 0.4-0.7, scores
0.69-0.78, quota filler at an episode ceiling of 8-9 postable moments; better recall displaces
them without a dedicated fix.

## The defect (engine-notes §6a, verbatim reasoning, now with a kill count)

`buildScanWindows` budgets windows from `speechSec` - word-bearing node spans only, a
transcription artefact that undercounts this material by roughly half (§3: 1603s of speechSec
against 2770s of sourceSec on the 52-minute fixture). The window that counts 600s of "speech"
actually renders ~1130s of transcript, so a ~50-minute source yields 3-4 windows where the
design intends 7-8. That halves the per-window quota AND the scanner's 12-moments-per-window
ceiling - recall is paid twice. `podcast-nuclear`: 4 windows, 44 raw candidates, and 4 of 12
labeled moments never scanned.

## The change

Budget scan windows from `sourceSeconds(nodes)` (all node spans - the honest measure §3 already
made the critic budget use) instead of `speechSec`, leaving the intended per-window size
constant. Mechanism in `buildScanWindows`, nothing else moves in the same commit.

## What it costs, stated before any code (this is the expensive part)

1. **Every scanner prompt changes** - window boundaries move, so every scanner request key
   moves, so every recorded critic/finalizer/audit answer downstream of the candidate set is
   stale too. This is a FULL RE-RECORD per fixture, not a topup, and it invalidates every
   variant's recordings at once (base, gpt51, end-extension, arc-audit, start-extension,
   arc-exit-hints, long-clips). Do it on ONE fixture first - `podcast-nuclear`, the labeled one -
   prove the acceptance below, then decide with the owner whether to re-record the other four or
   accept mixed-era fixtures (old fixtures keep proving the old engine deterministically; they
   stop being comparable to the new one).
2. **The candidate pool roughly doubles, and K starts binding again.** `criticBudget` = 1 per
   source minute, capped by `criticMaxCandidates` 40 - a 48-minute source hits 48 -> 40, so the
   cap binds where it never did (§3 said only a 90-minute source would reach it). The measured
   production rate (0.58-0.72 candidates/min) was measured UNDER the halved windows; after the
   fix it may approach the 1.4/min structural ceiling. DO NOT retune K or the cap in the same
   change - publish `criticBudgetK`/`criticUnjudgedPool` from the re-recorded run first, then
   decide with numbers, exactly how the critic budget was fixed the first time.
3. Critic spend roughly doubles with the pool (order of $0.05 per 50-min job at Luna list -
   §3's measured $0.027 was under the halved pool).

## Acceptance, deterministic, on `podcast-nuclear`

1. Window count moves ~4 -> 7-8; per-window node coverage renders the WHOLE transcript.
2. The three 3/3-consensus missed moments are SCANNED (raw candidate overlap >= 30%):
   "Чернобыль грязнее Хиросимы" 1041-1071, "кобальтовая бомба" 1188-1254, "Нёнокса" 1886-1936.
   That is the falsifiable core: if the scanner still proposes nothing there with the windows
   fixed, the defect is the scanner prompt, not the budget, and this spec is falsified.
3. Autopsy kill histogram re-run: `scan_miss` 4 -> at most 1.
4. Shipped-set reading (labels overlap matching, NOT snapshot comparison - a fresh scan is a
   new lottery by construction): at least one of the three recovered moments ships end to end,
   and the positive control (1113.8-1131.2) still ships.
5. The K/cap counters published and read by a human before any second change.

## Phase A verdict (2026-08-11, probe run - and the spec is PARTIALLY FALSIFIED)

The knob shipped dark (`SCAN_WINDOW_BUDGET`, default `speech` - nothing invalidated) and
`eval-scan-probe.ts` ran live, 2 runs per budget plus one earlier discarded pair
(gpt-4o-mini, ~$0.03 total; full output in the session scratchpad, summary here):

- Window count on `podcast-nuclear`: 4 -> **5**, not the predicted 7-8. This fixture's
  opaque fraction is ~16% against the ~40% of the fixtures §3 measured - the 7-8 was an
  extrapolation from the wrong source. Node coverage was already 100% under both budgets; the
  defect was always per-window QUOTA density, and the density gain here is +25%.
- Missed moment #1 (Чернобыль/Хиросима): SCANNED in ALL FOUR runs INCLUDING both speech
  controls - the recorded miss was **scanner sampling variance**, not windows.
- Missed moment #2 (кобальтовая бомба): NOT SCANNED in 6 of 6 samples across both budgets -
  a scanner-prompt taste gap, exactly the falsification clause this spec carried.
- Missed moment #3 (Нёнокса): speech 0/2, source 2/3 - weak evidence for the budget.
- Raw candidates: 48/48 speech vs 54/60 source.

**Decisions that follow:** (1) the full-corpus re-record / era flip is NOT justified by this
evidence - shelved; (2) the budget knob is directionally right and free to run in prod via env
(`SCAN_WINDOW_BUDGET=source`), where high-opaque sources get the full effect - the harness stays
on `speech` by design (env-blind, same precedent as `ANALYZE_ENGINE` itself); (3) the measured
lever this probe surfaced is the SCAN LOTTERY - one temperature-0.4 sample misses what another
finds. The remedy candidate for it: run the scanner N=2 times per window and union the
candidates into `mergeCandidates` (which already dedupes overlaps) - doubles a gpt-4o-mini cost
(cents), attacks the variance directly, and its acceptance can be measured with THIS probe
(union coverage across runs: on today's data a 2x source union covers misses #1 and #3 and
moment #8's flicker; nothing covers #2 short of scanner-prompt work). That is its own spec once
the owner wants it; (4) кобальтовая-class taste gaps go to a future scanner-prompt project,
with this probe as its instrument.

## Phase B: the 2x scan union (owner go 2026-08-11)

The remedy for the measured scan lottery: run the scanner **N passes per window** (config
`scanPasses`, env `SCAN_PASSES`, integer, default **1** - today's behavior byte for byte) and
union all passes' candidates before `mergeCandidates`, which already merges overlapping
proposals. Determinism discipline: candidates flatten in (window, pass) order - the same
per-window-array rule that fixed the scanner-order nondeterminism (§3) extends to passes.

**Multi-pass is deliberately NOT recordable and NOT a variant.** The replay client keys
requests by sha256(model, system, user); two identical passes share one key, so a recording
would store one answer and replay it twice - the union silently degenerates to single-pass.
Therefore: the harness default stays 1 (env-blind, all recordings valid), `scanPasses` goes
into the FINGERPRINT (a fixture claiming to be recorded at passes>1 must fail loudly - it is a
lie by construction), the config comment documents the foot-gun, and the measurement instrument
is `eval-scan-probe.ts` extended with `--passes N` (per-pass candidate lists + UNION coverage
verdicts per labeled moment).

Cost: scanner input x N at gpt-4o-mini prices (~$0.006/pass on a 48-min source - noise); the
real cost is the candidate pool growing toward `criticBudget`'s K - on a 48-minute source K=40
can start binding. PUBLISH the counters (`criticBudgetK`, `criticUnjudgedPool`), do not retune
K or the cap in the same change.

Acceptance, via the probe on `podcast-nuclear` (budget source, passes 2, 2 independent runs):
- The 2-pass UNION covers misses #1 and #3 in BOTH runs (on Phase A data each was covered by
  at least one single pass; the union must make that stable).
- Miss #2 stays uncovered - the honesty control; if it suddenly appears, that is luck, not the
  mechanism, and must not be claimed.
- Union coverage over all 12 labeled moments >= the best single pass in every run.

**Phase B verdict (2026-08-11, run at source/passes=2/runs=2, ~$0.03): PASS - and the control
misbehaved instructively.** Union coverage **12/12 labeled moments in BOTH runs** (best Phase A
single pass: 10/12); misses #1 and #3 union-covered in both runs; raw candidates 120/118 per
2-pass run. The control, miss #2, was covered in 3 of 4 passes - per the pre-registered rule it
is NOT claimed for the mechanism, but the Phase A data re-read explains it: under `speech` its
nearest candidate was 56s away, under `source` it was **3.2s away in both runs** - a borderline
overlap-threshold near-miss, not a taste gap. The "scanner-prompt taste gap" classification was
partially wrong; the source budget had already moved the scanner onto that moment, and extra
sampling tips it over the threshold. Both knobs went live in prod the same day
(`SCAN_WINDOW_BUDGET=source`, `SCAN_PASSES=2`); the harness stays on speech/1 by env-blind
design. What union coverage does NOT promise: a scanned moment must still survive the critic,
gates, snap, NMS and the finalizer - the funnel's downstream lotteries are unchanged, and the
end-to-end effect is measured by the next real uploads, not by this probe.

## Out of scope

The scanner prompt itself, `regionMaxCandidates`, `criticMaxCandidates` retuning (measured
first, §above), the `no_clean_end` snap kills (word-timing coverage - separate root cause,
third sighting recorded in engine-notes), the finalizer sampling variance, and the softCap
quota question ("8-9 postable moments against a quota of 12") - each earns its own spec once
this one's numbers exist.
