# Supplemental recall experiment — rejected for release

The opt-in candidate improves sparse development coverage but fails fresh holdout. It is a reviewable experiment, not an enabled production feature.

## Implementation and evidence

Development: 21/33 sources leave nominees unjudged despite spare critic budget. Earlier attempts to fill the primary batch displaced good clips. This implementation keeps the f48094d primary lane unchanged, separately reviews unused nonoverlapping nominees within the remaining budget, and appends accepted clips without reordering or evicting primary outputs. It uses the existing critic, snap, arc, finalizer and publishability stages. A delivered-payoff rubric and medium reasoning apply only to the extra lane. No production option enables it.

The append operation rejects temporal duplicates and transcript holes, including nominees widened across a hole by the critic. An incomplete/degraded critic, arc, finalizer or publishability pass cannot add extras. The primary technical-empty guard remains authoritative. Supplemental failures preserve completed primary output and appear in telemetry. Legacy quality counters explicitly describe the primary lane; total kept count and durations describe delivered output.

## Real-source comparisons

All 33 development replays cover 28 accounts and 31 source identities. The same sparse set has 32 opportunities, including two customer-approved moments. Unchanged requests replay exact recorded answers; changed requests use the provider.

| Version | Outputs | Covered / 32 | Missed | Customer-approved retained |
| --- | ---: | ---: | ---: | ---: |
| Original c34dc27 | 107 | 20 | 12 | 1/2 |
| f48094d primary | 104 | 20 | 12 | 1/2 |
| Supplemental, delivered payoff, low reasoning | 120 | 21 | 11 | 2/2 |
| Supplemental, delivered payoff, medium reasoning | 121 | 22 | 10 | 2/2 |

Medium reasoning adds 17 clips to the frozen 104 primary outputs, retaining those primary ranges and order. It recovers the accepted explanation in s007 and an actual call/SMS demonstration in s064. These gains do not imply 17 publishable clips: additions include weak setup, potentially repetitive motivational claims and a gaming introduction promising a later reaction. Source frames show real shooting/explosions in that introduction; it is inaccurate to describe it as visually inactive. The promised girl's reaction is absent.

Two full production-render-function cuts on the retained s064 source encoded successfully with subtitles and reframe status ok (43.900s primary and 58.100s added demonstration). The phone/SMS interaction is visible, but desktop text remains small in portrait safe-fit. No whole-product publishability claim follows. Rendered media stayed local, with no customer job or artifact writes.

## Fresh holdout

Runtime files were hashed before source content review. Nine new jobs from seven accounts were reserved after excluding all old accounts and identified sources. Only four jobs could be materialized: one recorded transcript plus three successful offline transcriptions of retained originals. One duplicate source was removed, leaving **three unique English sources**. The other five had no retained original at capture. This is a small, language-limited holdout, not a broad replacement for the first 18-source holdout.

Fifteen sparse source opportunities were labeled before opening version outputs, using all three full transcripts and h002/h005 frame sheets. Human audio listening was unavailable. Labels are provisional editorial opportunities, not publishable verdicts. h002 has ASR repetitions/omissions; h005 has source black frames and unsupported numerical claims.

| Fresh holdout | Outputs | Covered / 15 | Missed |
| --- | ---: | ---: | ---: |
| Original c34dc27 | 12 | 1 | 14 |
| Frozen supplemental candidate | 13 | 0 | 15 |

The h005 subscription explanation survives baseline but the candidate finalizer drops it as no_payoff. This is a primary f48094d prompt/decision difference, not supplemental eviction; the supplemental lane has no unused nominees on this source. h002 gains short fragments without covering the complete labeled outcomes. h001 output ranges stay unchanged and still omit required context/consequences from the labeled episodes. Preserve these negative results. Any subsequent tuning using them makes this fresh set development evidence, not untouched holdout.

P@3/P@5, publishable yield and boring prevalence remain unknown without sufficient independent finished-clip review. Raw output count is not quality. The old s039 primary good-moment loss is unresolved. Nonoverlapping semantic duplicates across primary/supplemental lanes remain a risk.

## Verification and production

Full worker/shared suite: **3,623 passed, 55 failed**, exactly the baseline's failing test names. Worker typecheck and worker/shared builds passed. Added tests exercise successful append, primary order/retention, exhausted budget, temporal collisions, holes after critic expansion and optional quality-stage degradation. Independent code review prompted the degradation/hole/telemetry fixes; no remaining blocking code finding was reported before final verification.

No engine deployed. Production remains c34dc27; only analyzer/transcriber credentials were rotated after empty queues were paused, with unchanged images and prior queue states restored. The candidate fails the user's quality release condition and the existing full suite is not green.

Private artifacts: supplemental-freeze.json, comparison-supplemental-verified.json, verified-additions.json, fresh-label-protocol.json, comparison-fresh-supplemental.json, fresh-holdout-reserved/materialization files, supplemental-suite.json, key-rotation-result.json and per-source recordings/media. They contain customer data or operational details and remain ignored.
