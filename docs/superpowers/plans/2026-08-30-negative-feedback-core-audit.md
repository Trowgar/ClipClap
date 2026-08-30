# Negative-Feedback Core Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Privately review all 19 current real-user `EDIT`/`NO` clips and produce an evidence-backed ranking of reproducible core-engine defects.

**Architecture:** Freeze one read-only cohort, split it into three non-overlapping reason domains, and let independent reviewers inspect evidence, source context, telemetry, and render artifacts. The lead agent reconciles all case keys, challenges each proposed root cause, and commits only an aggregate repository-safe findings report.

**Tech Stack:** PostgreSQL/Prisma, R2 evidence storage, ffprobe/ffmpeg, existing ANALYZE telemetry and eval fixtures, Markdown/JSONL.

---

## File and data layout

- Create privately, do not commit: `apps/worker/.corpus/negative-feedback-2026-08-30/`
- Create privately: `cohort.jsonl`, `selection.jsonl`, `boundaries.jsonl`, `visual.jsonl`, `matrix.jsonl`
- Create and commit: `docs/superpowers/specs/2026-08-30-negative-feedback-core-audit-findings.md`
- Preserve untouched: `apps/worker/src/tmp-audit.ts`

Every private directory must be mode `0700`; every private file must be mode
`0600`. Do not reuse the older `apps/worker/.corpus/feedback-audit/` tree: some
of its directories are group/world-accessible.

### Task 1: Freeze and validate the private cohort

**Files:**
- Create privately: `apps/worker/.corpus/negative-feedback-2026-08-30/cohort.jsonl`
- Reference: `prisma/schema.prisma:808`
- Reference: `packages/shared/src/services/clip-feedback.service.ts:84`

- [ ] **Step 1: Recheck the aggregate under a read-only transaction**

Run an aggregate query joining `clip_feedback` to `users`, excluding
`users.isSynthetic`, and filtering verdicts to `EDIT` and `NO`.

Expected exact result at the frozen cutoff:

```text
EDIT 11
NO    8
TOTAL 19
WITH_EVIDENCE 19
```

Abort the audit if totals differ; update the design cohort explicitly instead
of silently reviewing a moving set.

- [ ] **Step 2: Create the private directory safely**

Run:

```bash
install -d -m 0700 apps/worker/.corpus/negative-feedback-2026-08-30
```

Expected: `stat -c '%a'` prints `700`.

- [ ] **Step 3: Export the frozen cohort without logging private values**

Write one JSONL row per case directly to `cohort.jsonl`; include a local audit
key, feedback/clip/job identifiers, verdict, reason, snapshot, evidence key,
and creation/update timestamps. Redirect query output to the private file so
identifiers and transcript data never enter terminal output. Set mode `0600`.

- [ ] **Step 4: Validate partition counts without printing rows**

Expected partitions:

```text
selection:  BORING or no reason     8
boundaries: CUTOFF                  4
visual:     FRAMING or QUALITY      7
total                               19
```

- [ ] **Step 5: Confirm repository isolation**

Run `git status --short` and `git check-ignore` for the private directory.
Expected: no corpus file appears in git status; only the pre-existing
`apps/worker/src/tmp-audit.ts` may remain untracked.

### Task 2: Review selection and unreasoned cases

**Files:**
- Read privately: `apps/worker/.corpus/negative-feedback-2026-08-30/cohort.jsonl`
- Create privately: `apps/worker/.corpus/negative-feedback-2026-08-30/selection.jsonl`
- Reference: `apps/worker/src/analyze-v2/index.ts`
- Reference: `apps/worker/src/scripts/eval-selection-autopsy.ts`

- [ ] **Step 1: Assign exactly eight cases to a fresh reviewer**

Select only reason `BORING` or null. Require the reviewer to use a unique
`mktemp -d`, disclose no identifiers or transcript quotations, and remove the
exact temporary directory before returning.

- [ ] **Step 2: Trace the selection path for every case**

For each case, compare the clip with nearby transcript/source context and
record critic score/keep decision, finalizer decision, rescue tier,
`lowQuality`, hook/payoff geometry, and whether a stronger candidate existed.

- [ ] **Step 3: Classify one primary root cause**

Use exactly one primary class per case:

```text
weak_candidate_accepted
rescue_overrode_rejection
missing_payoff
slow_or_empty_pacing
subjective_disagreement
source_limited
other_confirmed
insufficient_evidence
```

Record confidence, severity, and the smallest possible regression assertion.

- [ ] **Step 4: Write eight private result rows and verify cleanup**

Expected: eight unique audit keys, file mode `0600`, no temporary media left.

### Task 3: Review cutoff and boundary cases

**Files:**
- Read privately: `apps/worker/.corpus/negative-feedback-2026-08-30/cohort.jsonl`
- Create privately: `apps/worker/.corpus/negative-feedback-2026-08-30/boundaries.jsonl`
- Reference: `apps/worker/src/analyze-v2/index.ts`
- Reference: `apps/worker/src/scripts/eval-end-audit.ts`

- [ ] **Step 1: Assign exactly four `CUTOFF` cases to a fresh reviewer**

Use the same privacy and temporary-file constraints as Task 2.

- [ ] **Step 2: Compare shipped boundaries with source context**

Measure start-to-hook delay, pre-hook gap, payoff-to-end tail, next-sentence
handoff, subtitle completion, final source frames, and any extension/audit
flags. Distinguish semantic cutoff from visual freeze/black tail.

- [ ] **Step 3: Classify one primary root cause**

Use exactly one primary class per case:

```text
start_too_early
start_too_late
end_before_completion
hard_handoff
missing_afterbeat
subtitle_only_mismatch
render_tail_defect
subjective_disagreement
insufficient_evidence
```

Record confidence, severity, and a concrete fixture assertion over boundaries
or telemetry.

- [ ] **Step 4: Write four private result rows and verify cleanup**

Expected: four unique audit keys, file mode `0600`, no temporary media left.

### Task 4: Review framing and technical-quality cases

**Files:**
- Read privately: `apps/worker/.corpus/negative-feedback-2026-08-30/cohort.jsonl`
- Create privately: `apps/worker/.corpus/negative-feedback-2026-08-30/visual.jsonl`
- Reference: `apps/worker/src/processors/`
- Reference: `apps/worker/src/scripts/eval-camera-safety.ts`

- [ ] **Step 1: Assign exactly seven `FRAMING`/`QUALITY` cases to a fresh reviewer**

Use the same privacy and temporary-file constraints as Task 2.

- [ ] **Step 2: Inspect source-to-render transformations**

Measure source/render resolution, crop window and upscale ratio, bitrate,
decode errors, A/V skew, black/frozen frames, subtitle manifest errors, and
whether the reported defect already exists in the source. Visually compare
contact sheets without retaining them after review.

- [ ] **Step 3: Classify one primary root cause**

Use exactly one primary class per case:

```text
source_capture_quality
excessive_crop_upscale
wrong_subject_or_layout
crop_tracking_failure
subtitle_render_failure
encode_or_av_failure
reason_mismatched_to_artifact
subjective_disagreement
insufficient_evidence
```

Record confidence, severity, and whether an existing camera/render harness can
express the regression.

- [ ] **Step 4: Write seven private result rows and verify cleanup**

Expected: seven unique audit keys, file mode `0600`, no temporary media left.

### Task 5: Reconcile, challenge, and rank findings

**Files:**
- Read privately: the four JSONL files above
- Create privately: `apps/worker/.corpus/negative-feedback-2026-08-30/matrix.jsonl`
- Create: `docs/superpowers/specs/2026-08-30-negative-feedback-core-audit-findings.md`

- [ ] **Step 1: Merge and enforce the 19/19 invariant**

Reject duplicate or missing audit keys. Expected counts: `8 + 4 + 7 = 19`,
with `11 EDIT`, `8 NO`, and exactly one primary classification per case.

- [ ] **Step 2: Independently review every claimed engine defect**

The lead agent must trace the referenced telemetry/code path and downgrade any
claim based only on the rating label. Source limitations and subjective taste
must remain separate from engine-caused defects.

- [ ] **Step 3: Rank root-cause clusters**

For each cluster report anonymized count, verdict mix, severity, confidence,
reproducibility, expected fix blast radius, and required regression fixture.
Recommend a first core change only if multiple cases support the same
reproducible engine defect.

- [ ] **Step 4: Write the repository-safe findings report**

The committed report may contain aggregate counts and paraphrased patterns
only. It must contain no case identifiers, URLs, raw transcript, screenshots,
faces, or user data.

- [ ] **Step 5: Verify privacy and repository state**

Run:

```bash
rg -n 'https?://|presigned|userId|clipId|jobId|feedbackId' \
  docs/superpowers/specs/2026-08-30-negative-feedback-core-audit-findings.md
git diff --check
git status --short
```

Expected: privacy scan returns no matches; diff check passes; private corpus
files are absent from git status; `tmp-audit.ts` remains untouched.

- [ ] **Step 6: Commit only the safe findings report**

```bash
git add docs/superpowers/specs/2026-08-30-negative-feedback-core-audit-findings.md
git commit -m "docs(engine): report negative feedback audit"
```

Expected: one documentation file committed and no production behavior change.
