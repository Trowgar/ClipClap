# Short-source rescue: a test upload always demonstrates the product (2026-08-19)

**BUILT 2026-08-19, reviewed (APPROVE), 23 tests + 9 mutation checks green.**
Review corrections folded in: the threshold is STRICTLY under (`<`), matching
isShortSource in shared plans.ts - a 300s source gets neither the bot notice
nor the rescue; the rescue highlight ships with an EMPTY arcFlags map (a
downranked-out verdict's audit flags describe a geometry the rescue clip does
not have); `compressFailures` is counted apart from `snapFailures`. Accepted
as-is after review: a 6-second fragment is a legal rescue clip (snap's
hardMinSec is the only length bar - selection's short-clip surcharge is a
selection rule, and durations are in telemetry for the checkpoint).

**BILLING INTERACTION (review finding) - OWNER DECISION 2026-08-19: enabled
as-is.** free-settlement's `refundZeroClipJob` hands the WHOLE reservation
back on a DONE 0-clip job, once per account - and the rescue converts exactly
those jobs into 1-clip DONE jobs that KEEP the charge (2-5 of the 60 free
minutes for a typical test upload). The owner accepted the trade: a clip
shipped is a clip paid for, and the alternative (a RESCUE_ONLY refund branch
in settleFreeLedger) buys a corner case with real plumbing. The 2026-09
checkpoint must expect ZERO_CLIPS refund counts to DROP while the flag is on
- compare like with like via the `rescue` telemetry key.

## 0. The problem, measured

Half of all users' FIRST submission is under 5 minutes (16 of 33), they got 0.2
clips on average, and only 2 of 16 ever came back with a longer video. The
2026-08-18 engine floor fixed the copy half (under 60s refused with teaching
text, 60s-5m accepted with a "usually 0-2 clips" notice) but the experience
half is untouched: a short test upload still usually ends in "no clips", which
a stranger reads as "the product does not work".

Where those jobs actually die (job_steps ANALYZE telemetry, all 17
NO_VIABLE_MOMENTS short jobs): the scanner FOUND candidates (raw 4-24), the
critic judged them (2-6 sent), and everything was killed downstream -
keep:false, evidence gate, snap, selection tier "none". The weak-fallback tier
in select.ts never fires because eligibility already emptied the pool. So a
rescue inside selectAndOrder would rescue nothing; it has to sit at the
engine's final empty exit, downstream of every kill point.

The 8 NO_USABLE_SPEECH short jobs (speech under ~4s) are NOT rescuable - there
is nothing to subtitle - and stay honest zeros. Music-only sources refused by
the song gate likewise never reach the engine.

## 1. The mechanism

One new module `analyze-v2/rescue.ts` + one call site in `analyze-v2/index.ts`
at the `highlights.length === 0` exit, AFTER the unjudged guard (a technical
failure must keep failing - rescue never masks an outage; FAILED retries can
genuinely produce a better answer and bill nothing).

Preconditions, all required:
- `cfg.shortSourceRescueEnabled` - env `SHORT_SOURCE_RESCUE === "on"`, exact
  literal, default off (same discipline as every stage switch in config.ts).
- `options.sourceDurationSec` is a positive number and
  `<= cfg.shortSourceRescueMaxSec` (default `SOURCE_FLOOR.shortNoticeSec` =
  300 - the SAME constant the bot's short-source notice uses, imported, not
  copied). The stage passes `job.sourceDurationSec`; eval scripts pass
  nothing, so every eval run stays byte-identical.
- The critic returned at least one verdict (it did - the unjudged guard and
  the critic-zero-verdicts guard both sit upstream).

rescueShortSource(verdicts, nodes, cfg):
- Sort ALL verdicts (keep:true AND keep:false) by score desc, id asc for
  determinism.
- For each: `snapNodes` - boundaries must exist; a verdict that cannot snap is
  skipped and counted (`snapFailures`). Snap failing everything -> null ->
  honest empty unchanged.
- First snappable verdict wins: `regroundCopy` (evidence made in-range), then
  if the title is empty or `scriptMismatch(title+description, clipText)` -
  `snippetFallbackCopy` (verbatim, grounded and correctly-languaged by
  construction). NO LLM call on this path - the rescue is deterministic and
  free; repairCopy's cost is not worth spending on a demo clip.
- Ship with `verdict.lowQuality: true` - the existing weak-tier flag, so the
  bot caption already says "no strong moments found - this is the best
  available" in 7 locales, render.ts already carries it, and the web project
  page already renders it. Zero new copy.

Why gates are deliberately skipped: the evidence gate protects COPY quality,
and rescue replaces failing copy deterministically instead of dropping the
clip. Snap is NOT skipped: it is the boundary-existence proof - a clip that
cannot snap cannot be rendered honestly.

Hole parity: candidates were hole-filtered before the critic; snap may move
boundaries without a re-check - exactly the main path's existing property, not
a new risk class.

## 2. Telemetry

`rescue` key on ANALYZE telemetry, present if and only if the stage RAN (flag
on + short source + empty result) - the same not-a-key promise as arcAudit:
`{ attempted, snapFailures, shipped, verdictId?, score?, keptByCritic?,
copySource? ("model" | "reground" | "snippet") }`. When it ships, `kept: 1`
and `durations` reflect the rescue clip; `tier` stays "none" (truthful -
selection found nothing; rescue is not selection).

This key is also the measurement for the 2026-09 free-hour checkpoint: how
often short-source rescues fire and whether those users return.

## 3. Config and env

- AnalyzeConfig: `shortSourceRescueEnabled: boolean`,
  `shortSourceRescueMaxSec: number`.
- loadAnalyzeConfig: `SHORT_SOURCE_RESCUE === "on"`,
  `num(env, "SHORT_SOURCE_RESCUE_MAX_SEC", SOURCE_FLOOR.shortNoticeSec)`.
- `AnalyzeV2Options.sourceDurationSec?: number` - stages/analyze.ts passes
  `job.sourceDurationSec ?? undefined`.
- Live .env: `SHORT_SOURCE_RESCUE=on`. Rollback: delete the line and
  `docker compose up -d worker-analyze` (recreate, not restart - restart
  ignores env_file).

## 4. Acceptance

Unit (rescue.test.ts): picks highest score across keep values; deterministic
tie-break; skips unsnappable and counts them; all-unsnappable -> null; empty
title / mismatched copy -> snippet fallback; lowQuality set; no LLM client
anywhere in the module.

Wiring (short-source-rescue.test.ts through analyzeHighlightsV2, existing
fake-client harness): flag on + short source + critic keep:false -> 1
highlight, lowQuality true, telemetry.rescue.shipped true, zero extra LLM
calls; flag off -> byte-identical empty result WITHOUT a rescue key; no
sourceDurationSec -> no rescue; source over threshold -> no rescue; unjudged
candidates still throw AnalyzeTechnicalError with the flag on; strong-tier
sources never touch rescue.

Mutation checks: flip the threshold comparison, the score sort, the lowQuality
flag, the flag literal - a test must go red for each.
