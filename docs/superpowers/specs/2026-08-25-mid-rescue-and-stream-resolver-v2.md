# Mid-source rescue + stream resolver v2 (2026-08-25, owner approved "давай")

Owner's one constraint, verbatim intent: "главное чтобы он не выдавал слабые
клипы у хороших видео с хорошими клипами". That is the invariant of part 1.

## 1. Mid-source rescue (extend short-source rescue to sources up to 20 min)

Trigger case: new user "Ben trades" (tg 6987955255) - 795s trading lecture,
critic judged 11 candidates, kept only c3 at 0.58, arc-downrank dropped it
as arc_unrepairable -> 0 clips, auto-refund. Two zeros in 3 minutes for a
newcomer (the first was a correctly refused audio-only upload).

Today: rescue.ts fires ONLY at analyzeHighlightsV2's final empty exit, after
the unjudged guard, for sources strictly under SOURCE_FLOOR.shortNoticeSec
(300, literal pinned by a test; config.ts is deliberately import-free - a
shared import once broke 40 mocked tests). It ships ONE lowQuality demo clip
built deterministically (snapNodes required, regroundCopy ->
snippetFallbackCopy, zero LLM) and KEEPS the charge (owner decision
2026-08-19, displaces the zero-clip refund).

Change: a second ceiling, RESCUE_MID_MAX_SOURCE_SEC = 1200, behind env exact
literal RESCUE_MID_SOURCE=on (config.ts stays import-free; read process.env
the way its other knobs do). Sources in [300, 1200) become rescue-eligible
at the SAME exit with the SAME candidate rules and the same lowQuality mark
and bot copy. The short-notice copy (<300s) is unchanged. Whether the
charge is kept for mid rescues: SAME as short (owner's July decision
applies - a rescued job is a served job).

INVARIANT (the owner's constraint), enforced structurally and by test:
rescue is reachable only when the final kept set is EMPTY. A job that
produced >= 1 real highlight must never receive a rescue clip. Tests: (a)
kept=1 + mid-length source + flag on -> no rescue, output identical to
today; (b) kept=0 + 795s source + flag on -> exactly one lowQuality
highlight; (c) kept=0 + 1500s source + flag on -> no rescue (ceiling);
(d) flag off -> 300s behavior byte-identical (the existing short rescue
tests keep passing untouched); (e) the unjudged guard still precedes
rescue for mid sources. Mutations: remove the kept-empty condition -> (a)
red; ceiling -> Infinity -> (c) red; flag check truthy -> (d) red.
Candidate floor: whatever rescue.ts applies today for short sources
applies unchanged - do not add a new score floor in this change; record
the observed floor (if any) in the report.

## 2. Stream resolver v2 (tighten the density fallback)

Measured 2026-08-25 (.corpus/feedback-audit/stream-mode/, 54 jobs since
07-15, engine-faithful density = sentence-graph speech / source duration):
the density fallback (density < 0.55 AND duration >= 1200) has 11%
precision - 3 real streams of 27 flagged. Intruders: scripted dialogue
100% FP, degenerate transcripts 100%, podcasts 67%, documentaries 37.5%
(the largest traffic class, 41%). Rule with margin on that corpus:
  density < 0.45 AND medianSegmentSec < 2.8 AND reliable-speech floor
-> 3/3 real streams kept (0.16/0.30/0.36 density; median seg 1.5-2.4s),
1 FP left (cmshbmx1, ru scripted 56 min, 0.387/0.96s). Host rules (twitch,
youtube /live/) untouched. n=3 true streams - provisional constants, hence
the flag.

Change: mode.ts resolveAnalysisMode, behind env exact literal
ANALYZE_STREAM_RESOLVER_V2=on: the density branch requires all three:
STREAM_DENSITY_MAX_V2 = 0.45, STREAM_MEDIAN_SEG_MAX_SEC = 2.8, and a
reliable-speech floor whose exact metric + constant MUST be derived from
the corpus CSV (labeled_set_classified.csv) so that the 4 degenerate jobs
(hi x2 2026-08-22, nn x2) fail it while all 3 real streams pass with
margin - report the numbers. medianSegmentSec must be computed the way the
corpus measured it (state the definition in code). Flag off ->
byte-identical to today.

Observability (no flag - strictly additive telemetry): the resolver's
decision is recorded in ANALYZE telemetry as modeResolution {density,
medianSegmentSec, reliableMetric, branch: host|live|density|density_v2|
short|standard} whenever analysisMode is recorded (keep the existing
not-a-key discipline when stream mode is disabled).

Acceptance: a replay script over the 54-job labeled CSV must reproduce the
predicted split (v2 flags exactly the 3 TPs + cmshbmx1); unit tests for
each conjunct with mutations (drop any one conjunct -> a corpus-derived
test goes red); flag off byte-identical.

## Deploy

Both live in worker-analyze (hot-reloaded from apps/worker/src/analyze-v2):
implementers land complete, transpile-checked files atomically (memory:
feedback_live_edit_crash_risk). Flags armed in .env by the orchestrator
after acceptance; worker-analyze recreate + prisma generate + shared build.

## Part 2 prep results (2026-08-25, .corpus/feedback-audit/stream-mode/v2/)

Metric definitions reproduced the corpus 54/54: density = sum over
RELIABLE segments of (max word.end - min word.start) / sourceDurationSec
(sentence-graph.ts wordsUnreliable lines 8-17, opaque classification
209-220; word-span, not seg bounds - up to 1.1pp difference);
medianSegmentSec = median of (end-start) over ALL segments (reliable-only
does not reproduce the corpus); reliableMetric = reliableSegmentShare =
reliable segments / all segments, gate `<= RELIABLE_FLOOR 0.78` (a CEILING:
real streams have LOWER reliable share - crosstalk/noise makes opaque
segments; degenerate transcripts are garbled but timing-clean). Margins:
nearest TP cmt5lnand 0.7656, nearest degenerate cmt42ke8q 0.7951 - 1.9%
relative each side, a knife-edge on n=1; the other candidates (reliable
wpm, reliable speech-sec) do not separate at all.

Replay: old rule reproduces 3 TP / 24 FP exactly. The replay's v2 branch
OMITTED the production duration gate (durationSec > 1200); with the gate
kept (it is not being changed) the three residual FPs (906s, 912s, 1197s,
all scripted) fall out and cmshbmx1 is excluded by the reliable ceiling ->
**v2 on the corpus: 3 TP / 0 FP.** Final rule: host rules unchanged; else
durationSec > 1200 AND density < 0.45 AND medianSegmentSec < 2.8 AND
reliableSegmentShare <= 0.78. Honest status: n=3 true streams, one
knife-edge conjunct - flag-protected, telemetry records every input so the
first false demotion of a real stream is diagnosable from the DB.
Implementer: import wordsUnreliable/isReliableSegment from
sentence-graph.ts (export them), do not re-copy; resolveAnalysisMode needs
the segments array (index.ts call site passes transcription.segments);
five boundary fixtures are specified in resolver-v2-metrics.ts.

## SHIP NOTE (2026-08-25)

Part 1 commit 394ccd3, part 2 commit e34e416; RESCUE_MID_SOURCE=on and
ANALYZE_STREAM_RESOLVER_V2=on armed in .env, worker-analyze recreated
(guarded on zero ANALYZE/TRANSCRIBE in flight) + prisma generate + shared
build. Both parts: spec review + quality review clean; follow-ups taken:
rescue.tier recorded on failed attempts too; one resolveMode call per job
(the two wrappers had computed the metrics twice); empty transcripts
resolve standard by construction (segmentCount > 0 conjunct, defensive).
Corpus acceptance through the production resolver: exactly the 3 true
streams of 54 jobs, zero false positives. Rescue floor finding: rescue.ts
applies NO score floor - it ships the top-scored judged candidate that
snaps; unchanged by decision (same as short rescue). Live-edit hygiene:
every src landing went scratch -> esbuild -> single cp; TransformError
count 0 across both parts. Watch: first rescue.tier=mid clip in the wild
(and whether its user rates it), first modeResolution.branch=density_v2 on
a non-twitch source, any real stream demoted to standard (diagnosable from
modeResolution: density/medianSegmentSec/reliableSegmentShare).
