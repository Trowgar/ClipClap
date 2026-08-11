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

## Out of scope

The scanner prompt itself, `regionMaxCandidates`, `criticMaxCandidates` retuning (measured
first, §above), the `no_clean_end` snap kills (word-timing coverage - separate root cause,
third sighting recorded in engine-notes), the finalizer sampling variance, and the softCap
quota question ("8-9 postable moments against a quota of 12") - each earns its own spec once
this one's numbers exist.
