# Critic migration to GPT-5.6 Luna, and honest cost telemetry

Date: 2026-07-31
Status: design, approved for planning

---

## 1. Problem

Two problems that turned out to be one.

**The money.** Over the two weeks to 2026-07-30 the OpenAI account spent $6.37, of which
gpt-5.1 was $4.56 (72%). Only $2.84 of that total is attributable to jobs; the remaining
~$3.5 is engine iteration outside the job pipeline (`eval-record`, re-analysis of existing
transcripts, `teaser-sensitivity`), which pays for the critic and never for transcription.
So the thing that makes engine work expensive is specifically the critic model.

On 2026-07-31 OpenAI cut GPT-5.6 Luna to **$0.20 / $1.20 per 1M tokens**, against gpt-5.1's
$1.25 / $10.00 - 6.25x cheaper on input, 8.3x on output. Luna is a reasoning model with
native strict `json_schema` structured outputs, prompt caching and a 1.1M context. It is the
same SDK, the same key, the same base URL.

**The telemetry.** Investigating the first problem exposed three defects in cost accounting
that would each produce silently wrong numbers the moment the model changes:

- `stages/finalize.ts:35` carries its own `"gpt-5.1"` literal, independent of the default in
  `analyze-v2/config.ts:85`. Changing the model in config alone makes the engine use Luna
  while pricing keeps using gpt-5.1 - an ~8x overstatement, which also flows into free-tier
  settlement.
- `cost-telemetry.ts` falls back to `DEFAULT_TOKEN_PRICE` (gpt-5.1's price) for any unknown
  model. An unknown model gets a confident wrong number rather than no number.
- `jobs` stores `analysisInputTokens`, `analysisOutputTokens` and the resulting dollars, but
  **not the model**. The ten historical rows with cost telemetry cannot be re-priced, because
  the multiplier that produced them was discarded at write time.

Plus two fabricated constants inside `estimatedTotalCostUsd`: `COMPUTE_COST_PER_MINUTE = 0.006`
(a hand-entered guess that coincidentally equals whisper's rate, which is why the compute
column mirrors the transcription column in all ten rows) and `ANALYSIS_COST_PER_MINUTE = 0.00005`
(the no-token-usage fallback). Roughly 40% of the reported total is fiction.

---

## 2. Measured baseline

From `jobs` cost telemetry, 2026-07-31, ten rows:

```
 min  |  asr   |  llm   | compute | total  |    date
------+--------+--------+---------+--------+------------
 29.8 | 0.1790 | 0.0010 |  0.1790 | 0.3590 | 2026-05-21
 29.8 | 0.1790 | 0.0010 |  0.1790 | 0.3590 | 2026-05-21
  8.4 | 0.0500 | 0.0000 |  0.0500 | 0.1000 | 2026-05-24
 39.8 | 0.2390 | 0.0020 |  0.2390 | 0.4800 | 2026-07-13
 29.8 | 0.1790 | 0.0540 |  0.1790 | 0.4120 | 2026-07-14   V2 on
 29.8 | 0.1790 | 0.0920 |  0.1790 | 0.4500 | 2026-07-21
 52.3 | 0.3140 | 0.2230 |  0.3140 | 0.8510 | 2026-07-21
 52.3 | 0.3140 | 0.2730 |  0.3140 | 0.9010 | 2026-07-24
 52.3 | 0.3140 | 0.1570 |  0.3140 | 0.7850 | 2026-07-26
 52.3 | 0.3140 | 0.1880 |  0.3140 | 0.8160 | 2026-07-30
```

A 52-minute job costs **$0.471-0.587 in cash** (transcription + analysis), average **$0.524**.
Transcription is exactly $0.006/min and does not vary. Analysis is $0.157-0.273, average
**$0.210** - the spread is gpt-5.1 reasoning-token variance, which `critic.ts` already documents.

Projection for Luna, calibrated so the model reproduces the measured $0.210 average at gpt-5.1's
$1.25/$10. The token split is inferred from the two-week billing screenshot ($3.46 output against
$1.022 input, so output tokens are ~0.425x input tokens), giving **~38.2k input and ~16.2k output
tokens per 52-minute job**. That ratio is the weakest link in the projection and is the first
thing section 8 replaces with a measurement.

| | now | Luna | change |
|---|---|---|---|
| Analysis, 52-min job | $0.210 | **$0.027** | -87% |
| Cash, 52-min job | $0.524 | **$0.341** | -35% |
| Engine iteration, per 2 weeks | ~$3.50 | **~$0.45** | -87% |

These are projections, not measurements. Section 8 is how they get replaced with measurements.

---

## 3. Scope

**In:** the critic (`analyze-v2/critic.ts`), copy repair (same file, same model knob) and the
finalizer (`analyze-v2/finalize.ts`) move from gpt-5.1 to `gpt-5.6-luna`. Plus the whole of
the cost-telemetry rework in sections 6-7.

**Out, deliberately:**

- **Transcription.** whisper-1 stays. Groq's `whisper-large-v3-turbo` at $0.04/hour against
  OpenAI's $0.36/hour is a 9x cut and, after Luna lands, transcription becomes 93% of a job's
  cost - so this is the next thing to do, not a thing to skip. It is out because ASR is the
  most sensitive input in the system: engine-notes records 6 versus 10 shipped clips from two
  runs of the *same* audio through the *same* whisper. It needs its own spec and its own
  evidence, not a rider on this one.
- **The scanner.** gpt-4o-mini cost $0.094 over two weeks. Changing a working model for nine
  cents is risk without return.
- **Thresholds, gates, snapping.** Untouched. This change must be readable as one variable.
- **Recalibrating `FREE_TIER` constants.** See section 9.

---

## 4. Code changes

### 4.1 One default, not two

`stages/finalize.ts` must take the critic model from `loadAnalyzeConfig()` instead of its own
`process.env.OPENAI_CRITIC_MODEL || "gpt-5.1"` literal. This is blocking: without it the
migration writes wrong pricing from the first job.

### 4.2 Model defaults

`analyze-v2/config.ts`: `criticModel` and `finalizerModel` default to `gpt-5.6-luna`.

`criticModelFallback` is currently `gpt-5-mini`. It stays a deliberate choice rather than an
accident: the fallback exists for 429s and hard failures, and falling from one cheap model to
another cheap model is the right shape. Keep `gpt-5-mini` unless the token-budget measurement
in section 8 says otherwise.

The `model.startsWith("gpt-5")` gate in `llm.ts:43` matches `gpt-5.6-luna`, so `reasoning_effort`
continues to be sent. No change needed there - but the plan must include a test asserting this,
because it is load-bearing and currently implicit.

### 4.3 Reasoning effort is an open parameter

`SELECTION_REASONING_EFFORT` is `low` today. Artificial Analysis scores Luna 33 at low effort
and ~51 at max. Whether `low` is enough for this task is not answerable from benchmarks; it is
answerable from the fixtures. Treat effort as a knob to be measured in section 8, not a decision
to make in advance. If it has to rise to `medium`, the saving shrinks but stays multiple-fold.

### 4.4 Token budgets must be re-measured

`critic.ts` sizes output budgets at 2000 / 3600 / 6000 tokens for batches of 1 / 3 / 6, derived
from live measurement of gpt-5.1 at `reasoning_effort: low`. Those numbers are properties of
gpt-5.1's reasoning profile and do not transfer.

This is the single real risk in the change, because failure here is silent: an undersized budget
truncates mid-reasoning, `llm.ts` reports `truncated`, the critic splits the batch, the split
inherits the same starvation, and candidates disappear without an error. That exact cascade has
already happened once in this engine.

`finalize.ts` is worse: it cannot split a batch, so starvation costs the whole stage. Its numbers
are already marked ESTIMATED in the source.

Both must be re-measured against Luna using the method recorded in `critic.ts:18-28` - vary the
cap per batch size, record completion / reasoning / verdict counts, take the smallest round
number above a cap observed to complete.

---

## 5. Fixture strategy: two variants in one fixture

### 5.1 Why the obvious approach does not work

The harness replays recorded LLM responses keyed by `hash(model, system, user)`. The naive plan -
change the model, re-record with `eval-record.ts` - destroys the comparison. `eval-record` re-runs
*everything*, including the scanner at `temperature 0.4`, so the fixture comes back with a
different candidate set and the snapshot diff mixes "Luna judges differently" with fresh sampling
noise. `eval-topup.ts:16-21` documents this trap; the diff is the only artefact a human reads, so
a confounded diff is worthless.

`eval-topup.ts` is not the answer either: it refuses when the fingerprint has moved, and
`criticModel` is in the fingerprint.

### 5.2 The design

The model is already part of the request key. So Luna's critic and finalizer calls produce keys
that cannot collide with gpt-5.1's, while the scanner's keys are byte-identical between the two
configurations.

Therefore a fixture holds **both models' responses and two blessed snapshots**:

- `responses.json` gains Luna's critic/finalizer entries. gpt-5.1's entries are untouched.
- Scanner responses are reused as-is, so the candidate set entering the critic is identical to
  the byte.
- `snapshot.json` stays the gpt-5.1 baseline; `snapshot.luna.json` sits beside it.
- `meta.json` carries a fingerprint **per variant** rather than one per fixture.

What this buys: the diff isolates exactly one variable - the judge's decision. And the comparison
becomes reproducible offline and free, permanently, rather than a one-off measurement. The next
candidate model drops in as a third variant.

Recording cost: ~12 live calls across both fixtures, order of $0.05.

### 5.3 Implementation note

`eval-topup.ts:56` calls `loadAnalyzeConfig({})` with an **empty** env, so fixtures are
deliberately pinned to the defaults in `config.ts`, not to `.env`. Running an eval against a
variant therefore requires either changing the code default or teaching the scripts to take a
model argument. The second is required by the variant scheme anyway.

### 5.4 Rejected alternative

Extending `eval-topup` to tolerate fingerprint drift on the model fields. Cheaper to build, but
one-shot: each new candidate overwrites the last, and in a month there would be nothing left to
compare Luna against.

---

## 6. Facts and derived values

The governing principle: **the database stores facts; dollars are computed from them.** Today it
stores the result and discards one of the two multipliers.

**Facts** (write once, never change): `analysisInputTokens`, `analysisOutputTokens`,
`sourceDurationSec` - all present. Add `criticModel` and `transcriptionModel`.

**Derived** (recomputable at any time from facts + a price table):
`estimatedAnalysisCostUsd`, `estimatedTranscriptionCostUsd`, `estimatedTotalCostUsd`.

**Accounting, and not derived:** the free ledger's `estimatedCostUsd` is a posting - "what was
charged against the budget at that time". It must never be recomputed retroactively, even when
prices change. Keeping this distinction explicit is the point: without it, the first re-pricing
run silently rewrites the history of what users were charged.

### 6.1 Schema change

Two nullable string columns on `jobs`: `criticModel`, `transcriptionModel`. Via a Prisma
migration, not `db push`.

### 6.2 Backfill

One script in `apps/worker/src/scripts/`, following the existing backfill pattern. `criticModel`
for existing rows is derivable from `analyzeEngine` and date: `legacy` -> gpt-4o-mini,
`recall-critic` -> gpt-5.1. Ten rows. This makes historical figures re-priceable on the same
footing as new ones.

---

## 7. Prices live in the environment

No price table in source. A price compiled into code goes stale silently, and the 80% Luna cut on
2026-07-31 shows that happening inside a single day.

**`MODEL_PRICES_JSON`** - one env var holding both price kinds under distinct keys, so there is
exactly one thing to edit when a provider moves a price:

```json
{
  "tokensPerMillionUsd": { "gpt-5.6-luna": { "input": 0.20, "output": 1.20 } },
  "audioPerMinuteUsd":   { "whisper-1": 0.006 }
}
```

Parsed and validated once at startup. Malformed JSON is treated as no prices at all - warn
loudly, write no cost figures - rather than as a partial parse, because a half-applied price
table is the same plausible-wrong-number failure this section exists to remove.

**A missing price writes no number.** Not zero, not a fallback, not "the price of a similar
model" - the cost field is left unset and a warning is logged. An empty cell is honest; a
plausible wrong number reaches reports and settlement. This replaces `DEFAULT_TOKEN_PRICE`,
whose whole failure mode is being plausible.

**Startup validation:** if the configured `criticModel` or `transcriptionModel` has no price, warn
at worker boot - not at the first job, hours later.

**The free plan does not depend on this.** Reservations are computed from `FREE_TIER` in minutes
and runs, not from tokens. Missing prices degrade reporting, never billing.

**Fabricated constants are removed:**

- `COMPUTE_COST_PER_MINUTE = 0.006` moves to env, unset by default, and when unset writes
  nothing. The server is rented flat, so marginal compute is near zero at present volume; the
  constant's only current effect is to inflate the reported total.
- `ANALYSIS_COST_PER_MINUTE = 0.00005`, the no-token-usage fallback, is deleted.

After this `estimatedTotalCostUsd` means cash.

**Where the code lives:** `packages/shared`, because both the worker (write path) and the web
`/admin` page (re-pricing at read time) need it. This carries the known deployment trap: a change
under `packages/shared` needs `npm run build -w @clipclap/shared` **and**
`docker compose restart web`, or Next keeps serving the cached old `dist`.

**Rejected: a live price feed.** OpenRouter's `/api/v1/models` returns current pricing for most
models including OpenAI's. Rejected here because it puts an external network call on a path that
touches money settlement - a new failure mode where there should be none - and because
OpenRouter's price for an OpenAI model is a resale price that usually matches list but is not
obliged to. Acceptable later as an optional daily refresher of the env value; not as the source
of truth at settlement time.

---

## 8. Acceptance and rollback

Three gates, of decreasing mechanical certainty and increasing authority.

**Technical - blocking.** On both fixtures: zero truncations, zero refusals, zero batch splits,
and verdict count equal to candidates submitted. All of it is already published in `JobStep
ANALYZE` telemetry. Failure here means Luna's token budget is wrong (section 4.4) and the
measurement must be redone before anything else proceeds.

**Mechanical - must be read, does not block.** The diff of `snapshot.luna.json` against
`snapshot.json`: how many clips paired by overlap, how many vanished, how many appeared. This is
not "better or worse", it is the magnitude of the perturbation.

**Taste - decides.** The owner reviews clips **blind**: both runs interleaved, unlabelled,
verdict "would post / would not" per clip. Knowing which run is which would decide the question
before the clips do. The only real-world scoreboard this engine has is 2 postable out of 8
(engine-notes 5b), and on a base that thin any shift is easy to mistake for an improvement.

**Rollback is one line.** The **default** changes in `config.ts` and `.env` overrides it, so
rolling back is `OPENAI_CRITIC_MODEL=gpt-5.1` plus `OPENAI_FINALIZER_MODEL=gpt-5.1` in `.env` -
no code revert, no deploy. The asymmetry is deliberate: the new behaviour is the default, the old
one is one edit away.

**Apply it with `docker compose up -d worker-analyze worker-finalize`, NOT `restart`.** This
sentence originally said "restart", and that would have made the rollback silently do nothing:
`docker compose restart` reuses the existing container's configuration and never re-reads
`env_file`. Observed on 2026-07-31 while adding `MODEL_PRICES_JSON` to `.env` - the variable was
in the file, the worker still logged it as unset, and only `up -d` picked it up. A rollback path
that appears to work and does not is worse than none, so it is stated here rather than left to
the reader. Note `up -d` recreates the container, which per `docs/runbooks` means re-running
`prisma generate` in each recreated service afterwards.

---

## 9. Deliberately deferred: FREE_TIER recalibration

After the migration, `FREE_TIER.estimatedUsdPerSourceMinute = 0.012` and
`estimatedUsdPerRun = 0.03` will be roughly 10x too high. They are not corrected here.

- Over-reservation is safe **by design**: `plans.ts:197-199` states that finalize replaces the
  reservation with the measured figure, so an over-reservation costs only headroom in flight,
  while an under-reservation is a hole in the ceiling.
- They are inert today: `FREE_TIER_MONTHLY_BUDGET_USD` is unset and the trial is closed.
- `plans.ts:143` requires re-running the fitting query against prod before either number moves.
  Deriving them from projections rather than telemetry would repeat exactly the error already
  corrected in that file, where 0.030 was fitted to a single run and missed on the next.

**Trigger for the follow-up:** at least five jobs on Luna with recorded cost telemetry, then the
SQL in `plans.ts:147-155`, then the edit.

**Consequence to state plainly:** until those constants are recalibrated, a free run consumes
about ten times its true cost from the monthly ceiling. Opening the trial before the
recalibration wastes most of the saving this migration produces.

---

## 10. Testing

- **The snapshot test must run both variants.** If `eval-snapshot.test.ts` stays on one, the Luna
  variant is unprotected at exactly the moment it becomes production.
- **A test binding config to prices:** fails when the default config's `criticModel` has no entry
  in the configured price source. It catches the real failure class here - model changed, price
  forgotten - and is not tautological, because it ties two independent files together. Verify it
  by hand per engine-notes 4: remove the price, watch it go red.
- **A test for the `reasoning_effort` gate** on `gpt-5.6-luna`, since section 4.2 depends on
  `startsWith("gpt-5")` matching and nothing currently asserts it.
- **Run inside `worker-analyze`.** Host Node is v18; vitest does not run there.
- **No shared rebuild for the engine changes** (`config.ts`, `cost-telemetry.ts` are under
  `apps/worker`), but the price module in section 7 *is* under `packages/shared` and does need
  the rebuild-and-restart-web dance.
- **One real video** after the fixtures agree, for the blind comparison in section 8.
- **`docs/engine-notes.md` gets an entry** with Luna's measured numbers: reasoning tokens per
  candidate, resulting budgets, cost per job. The file exists so the next session does not
  re-derive what this one paid for.

---

## 11. Rejected alternatives

**NVIDIA Nemotron 3 Ultra** - the model that started this investigation. Rejected on three
independent grounds.

*Cost.* The paid route is $0.60/$3.60 per 1M - $0.081 of analysis per 52-minute job against
Luna's $0.027, so after the Luna price cut it is **3x more expensive than staying with OpenAI**.
It was competitive against gpt-5.1 and is not competitive against Luna.

*Format reliability.* CodeRabbit benchmarked it on 105 code-review problems - an LLM judge over
batched candidates with required structured output, structurally the same job as our critic.
Quality tied (56% vs 57% pass, 33.0% vs 34.0% precision), but retries averaged **36.5 against
0.3**, with ~66% of retries being the model stopping before emitting the required output marker.
Their own conclusion is that it needs external validation and retry logic and is unsuited to
work requiring correct format first time. In this engine a format failure is silent - it becomes
`truncated`, splits a batch, and drops candidates.

*The free variant cannot do the job.* `nvidia/nemotron-3-ultra-550b-a55b:free` does not list
`response_format` or `structured_outputs` in its supported parameters, while the paid route does.
The engine's core invariant - models emit node indices only, never timestamps - rests on
`strict: true`. Add OpenRouter's free limits of 20 requests/minute and 1000/day against ~13-15
calls per job, and the ceiling is ~65 jobs/day before retries, single-digit after.

Worth recording separately: the limitation is a property of the **endpoint**, not the model.
Nemotron is fine-tuned for structured output and scores 91.9 on instruction following (#4 of 31
on BenchLM). NVIDIA's own NIM reference does not advertise `response_format` either, and exposes
reasoning through `extra_body.chat_template_kwargs` rather than `reasoning_effort`.

**Cerebras free tier** - genuinely attractive on mechanics: `strict: true` with constrained
decoding at the token level, so schema violation is impossible by construction, which is strictly
stronger than OpenAI's guarantee. Rejected because free-tier limits are 5 RPM / 30K TPM / 1M
tokens per day, because the model list (`gpt-oss-120b`, `zai-glm-4.7`, `gemma-4-31b`) is not
obviously better at Russian editorial judgement, and above all because free tiers are paid for
with data: acceptable for the owner's own test podcasts, not acceptable once customer video
transcripts flow through. Keep on the list if Luna disappoints.

**DeepSeek V4 Flash** ($0.14/$0.28) would be ~2.7x cheaper than Luna for analysis - $0.010
against $0.027 per 52-minute job. Rejected because at this scale the difference is $0.017 per
job, against the cost of a second vendor, a second SDK path, a second data-processing
relationship and unmeasured Russian editorial quality. Revisit only if analysis becomes a
material cost line again.

**OpenRouter as a gateway** - would make model swapping trivial, but `max_completion_tokens` is
an OpenAI parameter and OpenRouter takes `max_tokens`, so the entire measured token-budget
apparatus would silently stop applying. Not worth it for a change that otherwise touches one
config default.

**Provider abstraction (configurable base URL and per-host parameter mapping)** - was the
centrepiece of an earlier draft of this work. Demoted to "nice to have": with Luna the cheapest
credible option and on the SDK we already use, an abstraction layer today buys neither money nor
quality. Revisit when there is a second provider worth having.

---

## 12. Out of scope, named so they are not lost

- **Groq ASR.** The next piece of work, and after this migration the largest remaining cost line
  by far (93% of a job). Needs its own spec because ASR perturbs the engine harder than the
  critic does.
- **NVIDIA Nemotron 3.5 ASR** (40+ languages) - a second ASR candidate to evaluate alongside Groq.
- **Optional daily refresh of `MODEL_PRICES_JSON` from a live feed** (section 7).
- **`FREE_TIER` recalibration** (section 9), gated on five Luna jobs.
- **The actual product problem.** At 93% gross margin after Luna and Groq, cost stops constraining
  this business. Two clips out of eight are postable; no API saving moves that number. Arc
  stacking and drag, per engine-notes 5b, remain untouched and remain the real work.
