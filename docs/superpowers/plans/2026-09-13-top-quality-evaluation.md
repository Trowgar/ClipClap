# Top Quality Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove whether supplemental recall improves customer-facing clip quality, identify the largest remaining loss, and validate one next core improvement.

**Architecture:** Extend the existing moment metric types with the missing finished-clip dimensions and aggregate them in the current comparison CLI. Generate a private blind review manifest from recorded real-source runs, reuse a review once for identical clips, and keep version/rank mapping outside the reviewer input. Trace labeled moments through recorded pipeline calls before changing the smallest shared core component responsible for the dominant loss.

**Tech Stack:** TypeScript, Vitest, existing analyzer replay fixtures, ffmpeg/ffprobe, existing OpenAI client.

---

### Task 1: Finished-clip metrics

**Files:**
- Modify: `apps/worker/src/evaluation/moment-metrics.ts`
- Modify: `apps/worker/src/__tests__/moment-metrics.test.ts`
- Modify: `apps/worker/src/scripts/eval-moment-quality.ts`

- [x] Add failing tests for micro Precision@3/5, boring rate, publishable/source, bad boundaries, incomplete payoff, cross-scene, unknown handling, and unique moment counts.
- [x] Run the focused Vitest file and confirm the new assertions fail for missing fields.
- [x] Add the minimal review fields and aggregation required by the assertions.
- [x] Run the focused test and worker typecheck.

### Task 2: Blind review set

**Files:**
- Create: `apps/worker/src/evaluation/blind-review.ts`
- Create: `apps/worker/src/__tests__/blind-review.test.ts`
- Create privately: `apps/worker/tmp/september-core/quality-*.json`

- [x] Add a failing test showing exact old/new clips share one blind item and near duplicates form one semantic review cluster without losing version ranks.
- [x] Implement deterministic IDs, source-level holdout assignment, interval deduplication, transcript extraction, and sealed mapping.
- [x] Generate development and sealed-holdout manifests for the recorded September runs.
- [x] Review every deduplicated development clip under the frozen rubric; attach retained rendered evidence where available and record uncertainty elsewhere.
- [x] Aggregate baseline, candidate, and the 18 supplemental-only clips. Keep customer-feedback metrics separate.

### Task 3: Pipeline loss attribution

**Files:**
- Create privately: `apps/worker/tmp/september-core/top3-loss-analysis.json`

- [x] Enumerate each labeled good moment that is missing from a publishable Top-3 result.
- [x] Trace it through discovery output, critic records, ranking/final selection, episode construction, boundary expansion, and final render evidence.
- [x] Assign one primary loss category and supporting evidence; aggregate across sources.
- [x] Select the largest actionable cause using publishable Top-K impact and recall risk.

### Task 4: One root-cause core iteration

**Files:**
- Modify only the analyzer component identified by Task 3.
- Add or modify its focused test file.

- [x] Add a failing test reproducing the dominant real-source loss pattern with sanitized structural input.
- [x] Implement the smallest root-cause change behind a feature flag.
- [x] Replay the development sources, blind-review changed clips, compare all required metrics, and inspect regressions.
- [x] Repeat only if a new hypothesis is supported by observed failures.

### Task 5: Final gate

**Files:**
- Create: `docs/quality/2026-09-13-top-quality-production-evaluation.md`

- [ ] Freeze a selected candidate before opening a new source-level holdout; both available sets were opened during regression work.
- [x] Run the paired original-holdout comparison and critical regression checks; record that it is no longer statistically clean.
- [x] Build and replay-smoke-test the analyzer with the release configuration.
- [x] Do not deploy because the candidate did not improve an untouched holdout; preserve the existing rollback path.
- [x] Record data coverage, failure modes, code changes, development/holdout metrics, regressions, pending production state, and remaining priorities.

### Task 6: Primary episode integrity iteration

**Files:**
- Modify: `apps/worker/src/analyze-v2/config.ts`
- Modify: `apps/worker/src/analyze-v2/quality-lane.ts`
- Create: `apps/worker/src/analyze-v2/scanner-setup-protection.ts`
- Modify: `apps/worker/src/__tests__/analyze-config.test.ts`
- Modify: `apps/worker/src/__tests__/quality-lane.test.ts`
- Create: `apps/worker/src/__tests__/scanner-setup-protection.test.ts`

- [x] Test and reject the primary critic-prompt experiment after its labeled pilot regressed recall.
- [x] Add failing tests for exact-literal setup protection and safe scanner-node restoration.
- [x] Restore setup post-final only within scene, hook, collision, duration, and delivered-audit gates.
- [x] Replay development and original holdout, compare all required metrics, and inspect changed clips.
- [x] Test the eight-source regression set and replace unsafe supplemental deletion with quarantine.
