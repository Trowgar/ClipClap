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

- [ ] Add failing tests for micro Precision@3/5, boring rate, publishable/source, bad boundaries, incomplete payoff, cross-scene, unknown handling, and unique moment counts.
- [ ] Run the focused Vitest file and confirm the new assertions fail for missing fields.
- [ ] Add the minimal review fields and aggregation required by the assertions.
- [ ] Run the focused test and worker typecheck.

### Task 2: Blind review set

**Files:**
- Create: `apps/worker/src/evaluation/blind-review.ts`
- Create: `apps/worker/src/__tests__/blind-review.test.ts`
- Create privately: `apps/worker/tmp/september-core/quality-*.json`

- [ ] Add a failing test showing exact old/new clips share one blind item and near duplicates form one semantic review cluster without losing version ranks.
- [ ] Implement deterministic IDs, source-level holdout assignment, interval deduplication, transcript extraction, and sealed mapping.
- [ ] Generate development and sealed-holdout manifests for the recorded September runs.
- [ ] Review every deduplicated development clip under the frozen rubric; attach retained rendered evidence where available and record uncertainty elsewhere.
- [ ] Aggregate baseline, candidate, and the 18 supplemental-only clips. Keep customer-feedback metrics separate.

### Task 3: Pipeline loss attribution

**Files:**
- Create privately: `apps/worker/tmp/september-core/top3-loss-analysis.json`

- [ ] Enumerate each labeled good moment that is missing from a publishable Top-3 result.
- [ ] Trace it through discovery output, critic records, ranking/final selection, episode construction, boundary expansion, and final render evidence.
- [ ] Assign one primary loss category and supporting evidence; aggregate across sources.
- [ ] Select the largest actionable cause using publishable Top-K impact and recall risk.

### Task 4: One root-cause core iteration

**Files:**
- Modify only the analyzer component identified by Task 3.
- Add or modify its focused test file.

- [ ] Add a failing test reproducing the dominant real-source loss pattern with sanitized structural input.
- [ ] Implement the smallest root-cause change behind a feature flag.
- [ ] Replay the development sources, blind-review changed clips, compare all required metrics, and inspect regressions.
- [ ] Repeat only if a new hypothesis is supported by observed failures.

### Task 5: Final gate

**Files:**
- Create: `docs/quality/2026-09-13-top-quality-production-evaluation.md`

- [ ] Freeze the selected candidate before opening the source-level holdout.
- [ ] Run the blind holdout comparison and all critical regression/safety checks.
- [ ] Build and smoke-test the analyzer with the release configuration.
- [ ] Deploy through the existing process only if the measured gate passes and preserve the existing rollback path.
- [ ] Record data coverage, failure modes, code changes, development/holdout metrics, regressions, production state, and remaining priorities.
