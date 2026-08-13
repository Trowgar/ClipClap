# Groq ASR: the same Whisper for a ninth of the price, if the measurements allow it

**Status:** design, written 2026-08-13. Approved by the owner the same day (model chosen by
measurement; minimal switch, no fallback). Probe measurements below were taken against the live Groq
API from the running `worker-transcribe` container and are reproducible there.

**One sentence.** After the Luna migration transcription is ~93% of a job's cash cost, and Groq
serves the same Whisper models at $0.04-0.111 per audio-hour against OpenAI's $0.36 - so the job is
to prove Groq's output is within the jitter Whisper already exhibits against itself, then switch one
env variable.

---

## 1. Why, and why this is the next thing

The Luna spec (2026-07-31, §12) named this exact work as its successor: "Groq ASR. The next piece of
work, and after this migration the largest remaining cost line by far (93% of a job)." That
prediction is now the measured state of the cost telemetry.

| | per audio-hour | 52-min job | vs whisper-1 |
|---|---|---|---|
| OpenAI `whisper-1` (today) | $0.360 | $0.312 | - |
| Groq `whisper-large-v3` | $0.111 | $0.096 | 3.2x cheaper |
| Groq `whisper-large-v3-turbo` | $0.040 | $0.035 | 9x cheaper |

With Luna analysis at ~$0.027 per 52-min job, the turbo path takes the whole cash cost of a job from
~$0.34 to ~$0.06. There is also a latency dividend: Groq's inference is markedly faster than
OpenAI's batch Whisper, and `transcribeMs` is already recorded per job, so the dividend gets
measured for free.

What this does NOT fix: clip quality. Two of eight clips are postable and no API saving moves that
number. This migration buys margin, not product.

---

## 2. Measured today (2026-08-13)

A 1-second probe through the real endpoint from `worker-transcribe`, with the owner's key:

- **The endpoint is OpenAI-compatible.** `https://api.groq.com/openai/v1/audio/transcriptions`
  accepts the exact request `whisperCall` already builds - `verbose_json`,
  `timestamp_granularities: ["segment", "word"]`, `language` - via the same `openai` npm SDK with a
  different `baseURL`. Status 200.
- **The response shape matches `RawWhisperResponse`.** `language`, `words[{word,start,end}]`,
  `segments[{start,end,text}]` all present. One difference: Groq capitalizes the language name
  (`"English"` where OpenAI returns `"english"`). `whisperLanguageToIso` lowercases its input
  (`language.ts:58`), so this is already absorbed - but §6 pins it anyway, because `Job.language`
  feeds both the ANALYZE prompts and the Arabic font map of the 2026-08-13 arabic-locale spec.
- **The key's ceiling at first probe was 7200 audio-seconds per hour** (`x-ratelimit-limit-audio-seconds`
  header) - two hours of audio per hour, enough for §4, not enough for one 3-hour VOD. The owner
  enabled dev billing the same evening and the re-probe measured **400,000 audio-seconds** (111
  audio-hours per window) and 200,000 requests - the production prerequisite in §7 step 3 is
  already met. The key lives in `.env` as `GROQ_API_KEY` (added 2026-08-13) and nowhere else.
- **Silence hallucinates the same way.** The 1s silent probe transcribed as "Thank you." -
  whisper-1 does exactly this too. Not a regression, just a reminder that the providers share the
  model's vices.

Free-tier file limit is 25MB; the pipeline's `CHUNK_BYTES_THRESHOLD` is 24MB. Compatible by
accident, kept by decision (§5).

---

## 3. The decision structure

Two decisions were made before any code, both the owner's:

1. **The model is chosen by measurement, not preference.** Both Groq models run through §4; the
   pass rule is written down there, in advance, so the result cannot be argued into passing.
2. **The architecture is a minimal switch with no fallback.** The same `openai` SDK instance
   pattern, a Groq `baseURL` when `TRANSCRIPTION_PROVIDER=groq`, rollback is one env flip. No
   OpenAI fallback on Groq failure: a Groq outage fails jobs exactly as an OpenAI outage does
   today. This keeps the property the cost telemetry depends on - the recorded
   `transcriptionModel` is always the model that ran, so there is no mixed-provider job to
   misprice. The 2026-08-03 incident (a fallback job priced at the wrong model's rates,
   understated 48%) is the precedent for refusing silent fallbacks.

Rejected alternatives, so they are not re-proposed:

- **Per-call OpenAI fallback** - needs audio-seconds-by-model attribution (an
  `analysisUsageByModel` analogue) to price honestly. Real scope, rare benefit. Revisit only if
  production shows Groq instability that measurements did not.
- **OpenRouter / provider abstraction layer** - rejected in the Luna spec §11 for reasons that
  still hold; a second provider on the same SDK does not justify an abstraction.

---

## 4. Part 1 - the measurement, and the rule it answers to

### 4.1 The control: Whisper against itself

The project already knows Whisper is not deterministic: the two podcast fixtures are the same
52-minute Russian episode transcribed twice through whisper-1, measuring **14 substitutions, 28
insertions, 25 deletions on ~7050 LCS-aligned tokens**, indels 3.8:1 over substitutions, almost all
discourse particles (engine-notes §1). That envelope is the yardstick: if Groq-vs-whisper-1 on the
same audio looks like whisper-1-vs-whisper-1, the provider change is indistinguishable from the
noise the engine already tolerates.

The fixture episode's audio is unrecoverable from our side (both jobs were manual uploads of
`videoplayback.mp4`, both swept from R2, no `sourceUrl`). The owner instead submitted a **fresh
55-minute Russian episode** through the pipeline the same evening (job
`cmsrx4ob30003i1jxfle15qef`, `https://youtu.be/EnTXXyKSL64`, 3323s, single-call path at 13.3MB), so
the fallback design is the active one: the job's own `transcriptJson` is whisper-1 reference #1,
free; **one more whisper-1 run on the identical mp3** (~$0.33) establishes the self-jitter control
on this exact audio. The fixture episode's unique contribution - §4.4's engine-level comparison
against the recorded pair - is off unless the July file surfaces; §4.4 stays in the spec for that
case only.

### 4.2 The corpus

| source | audio | whisper-1 reference | status |
|---|---|---|---|
| Russian, 55 min (`cmsrx4ob30003i1jxfle15qef`, Alipov episode) | **secured 2026-08-13**, `asr-russian/` | job's `transcriptJson` + one fresh run (the control) | ready; control run pending |
| Russian, 52 min (July fixture episode) | unrecoverable | both fixture `transcript.json`s | only if the July file surfaces (§4.4) |
| Arabic, 193s (`cmsoarjd00079uhfjfj72esb9`) | **secured 2026-08-13**, `asr-arabic/` | job's `transcriptJson`, dumped alongside | ready |
| Arabic, 296s (`cmsnod8kc005zuhfj95wm65fs`) | **secured 2026-08-13**, `asr-arabic/` | job's `transcriptJson`, dumped alongside | ready |
| English | optional tiebreak only | fresh double-run | only if ru+ar are marginal |

The Arabic sources were pulled from R2 hours before their retention expiry, re-encoded with the
pipeline's exact ffmpeg settings (16kHz mono 32kbps mp3), and live with their whisper-1 reference
transcripts in `apps/worker/eval-media/asr-arabic/` (gitignored, like all eval media). Arabic has
no ground truth on this side - nobody here reads it - so its metric is agreement: if Groq and
whisper-1 agree on Arabic the way whisper-1 agrees with itself on Russian, that is the best
available signal, and it is the language the arabic-locale branch is about to grow.

### 4.3 Transcript-level metrics

A standalone script (`apps/worker/src/__tests__/scripts/asr-compare.ts`, next to `eval-record.ts` -
the same class of tool: costs money, runs manually, measures the live API) transcribes each corpus
mp3 through
`whisper-large-v3` and `whisper-large-v3-turbo` and reports, against each whisper-1 reference:

- **LCS-aligned substitutions / insertions / deletions per token count** - the engine-notes method,
  reused so the numbers are comparable to 14/28/25.
- **Word-timing coverage**: the sum of word-bearing spans, the `speechSec` analogue. Engine-notes
  §1 shows 36% of the fixture episode sits in opaque nodes because whisper-1's word timings were
  not trusted; if Groq words cover materially less, cutting degrades; materially more is a finding
  in Groq's favor.
- **Monotonicity violations** before the stitcher's clamp touches them.
- **`language` field** through `whisperLanguageToIso` - must resolve to `ru`/`ar` correctly.
- Wall-clock per call, for the latency dividend.

### 4.4 Engine-level check (only with the fixture episode)

Fixture LLM recordings are keyed on `sha256(model, system, user)`; a Groq transcript changes every
prompt, so nothing replays - the harness is structurally silent on this migration, and a green
suite MUST NOT be read as evidence for it. What the fixtures do give: the known engine-level spread
between two whisper-1 runs of the same episode (10 vs 11 clips on Luna, per-clip differences
throughout). If the owner supplies the episode, one live ANALYZE run (~$0.03 at Luna prices) on the
winning Groq transcript answers: is the Groq-run clip set further from either fixture run than the
fixture runs are from each other? Same-or-closer passes.

### 4.5 The pass rule, stated before measuring

**turbo ships if, on every source actually measured (Russian and Arabic; English only if it was
invoked as a tiebreak):** its LCS delta against the whisper-1 reference is within
**2x** of the same-audio whisper-1 self-jitter (token-for-token rates, and the indel-dominant
profile preserved - a substitution-heavy delta is a different failure even at low counts); word
coverage is within **5 percentage points** of whisper-1's; zero unresolvable `language` values.
Otherwise the same test decides `whisper-large-v3`. If both fail, we stay on whisper-1, write the
numbers into engine-notes, and the spec closes with a negative result - which is a result.

The 2x and 5pp thresholds are judgment calls recorded in advance so the measurement cannot be
negotiated with after the fact. Total measurement cost: under $2, dominated by the fresh whisper-1
control runs.

---

## 5. Part 2 - the code change

Small by design. Everything is env-gated; unset env is byte-identical to today.

- **`transcribe.ts`**: the module-level `openai` client becomes a provider-selected client -
  `TRANSCRIPTION_PROVIDER=groq` builds the same SDK with
  `baseURL: "https://api.groq.com/openai/v1"` and `GROQ_API_KEY`. `whisperCall` itself does not
  change: same params, same response handling. The SDK's built-in retries (which honor
  `retry-after` on 429) stay; the existing one-shot catch-retry in the chunk loop stays.
- **`model-selection.ts`**: gains `transcriptionProvider()` and a provider-aware
  `transcriptionModel()` default (`whisper-1` for openai; for groq, the §4 winner). The file keeps
  its defining property - the only copy of every default in the tree - and the cost telemetry keeps
  pricing the model string that actually ran.
- **`MODEL_PRICES_JSON`**: `audioPerMinuteUsd` gains `"whisper-large-v3": 0.00185` and
  `"whisper-large-v3-turbo": 0.00067`. Model ids differ from `whisper-1`, so both providers stay
  priceable simultaneously and historical rows keep their meaning. Deploy order is prices first,
  flip second: flipping first makes `estimatedTranscriptionCostUsd` null (honest, but lost data).
- **`.env.example`**: `TRANSCRIPTION_PROVIDER`, `GROQ_API_KEY`, and the price additions, documented.

### What must not change

- The chunk planner, silence-seek, language probe, stitcher, and every threshold in them.
  `CHUNK_BYTES_THRESHOLD` stays 24MB - it fits Groq's 25MB free-tier file cap and its dev-tier
  100MB cap; retuning chunk size for Groq's limits is a separate optimization with its own risks
  (the subtitle word-drop seam has bitten five times; nothing here may touch it).
- The default path. `TRANSCRIPTION_PROVIDER` unset or `openai` must produce today's requests
  byte-for-byte.
- The subtitle/render path - reads `transcriptJson`, does not care who wrote it.

---

## 6. Tests

- **Provider selection and model defaults** - pure-function tests on `transcriptionProvider()` /
  `transcriptionModel()`: unset env → openai/whisper-1; groq env → groq client config and the
  chosen model. No mocked API calls: a mock of `audio.transcriptions.create` would measure nothing
  (see `feedback_mocked_prisma_blind_spot` - assert shapes only where a real query can drift).
- **Language name pinning**: `"English"`, `"english"`, `"Russian"`, `"Arabic"` through
  `whisperLanguageToIso` → `en/en/ru/ar`. Groq's capitalization is absorbed by a `toLowerCase`
  today; this test makes that load-bearing line unremovable, because `Job.language` now also
  selects the subtitle font for Arabic clips (arabic-locale spec §3.1).
- **Price parsing**: the two new `audioPerMinuteUsd` entries round-trip through
  `parseModelPrices`, and an unknown transcription model still yields a null cost, never a default.
- **The real evidence is §4**, not the suite. Stated here so a future reader does not mistake
  green tests for a validated migration.

---

## 7. Rollout

1. ~~Owner asked for the fixture episode file/URL~~ **Done 2026-08-13**: the owner supplied a fresh
   Russian episode instead (§4.1); the corpus is complete, one whisper-1 control run pending.
2. **Measurement script runs; numbers land in engine-notes and an addendum to this spec.** The §4.5
   rule names the model, or ends the project with a negative result.
3. ~~Billing enabled in the Groq console~~ **Done 2026-08-13**: dev tier measured at 400,000
   audio-seconds (§2). Production does not flip before this - and now may.
4. **Code merges with the default off.** Worker code hot-reloads from the bind mount; the env flip
   requires `docker compose up -d worker-transcribe` (not `restart` - it ignores `env_file`),
   then the per-container `prisma generate` ritual per the deploy-regen note.
5. **Prod flip**, then the first ~10 real jobs are watched: `transcribeMs` (expect a large drop),
   `estimatedTranscriptionCostUsd`, `transcriptCoverage` / `transcriptPartial`, clips per job
   against recent history. Rollback is `TRANSCRIPTION_PROVIDER=openai` and another `up -d`.
6. **FREE_TIER constants are not recalibrated here** - that work stays gated behind the Luna spec
   §9 process, now with two cost changes to absorb at once.

---

## 8. Out of scope

- **Fallback machinery and per-model audio attribution** (§3).
- **NVIDIA Nemotron 3.5 ASR** - the Luna spec's second candidate. Only becomes relevant if Groq
  fails §4.5.
- **Chunk-size retuning** for Groq's 100MB dev-tier cap.
- **Hallucination filtering** (the "Thank you." class) - identical on both providers, a pipeline
  concern, not a provider one.
- **Live price feed for `MODEL_PRICES_JSON`** - still the Luna spec's deferred item.
- **The web interface and the bot** - neither knows what transcribes their jobs.

## 9. Known risks

- **ASR is the most sensitive input in the system.** The whole §4 apparatus exists because two runs
  of the same audio through the same model already ship different clips. The pass rule bounds the
  added perturbation; it cannot make ASR deterministic.
- **Groq could deprecate or reprice these models.** Cheap insurance is already in place: rollback
  is one env flip, prices live in env not code, and whisper-1 keeps working untouched.
- **The Arabic verdict rests on agreement, not truth.** If Groq and whisper-1 disagree on Arabic,
  the measurement cannot say which is right - only that the switch is risky there. The arabic
  native-speaker review (arabic-locale spec §7 step 3) is the eventual truth channel.
- **The 7200 audio-sec/hour ceiling until billing is enabled.** A long VOD submitted the hour the
  flip lands would 429 into `missingRanges` territory. Rollout step 3 exists to make this
  impossible, not merely unlikely.
