# Negative-feedback core audit

**Date:** 2026-08-30
**Status:** approved for planning

## Goal

Review every current real-user `EDIT` and `NO` clip, distinguish engine defects
from source limitations and subjective taste, and produce a ranked list of
reproducible core-engine improvements.

The current cohort is 19 ratings: 11 `EDIT` and 8 `NO`.

## Scope

The audit is private and read-only. It may inspect frozen feedback snapshots,
evidence clips, source context, analyze telemetry, render manifests, and job
steps. Reports must not contain user identifiers, signed URLs, faces, raw
transcript quotations, or other personal content.

The audit does not change engine code, prompts, configuration, database rows,
or running services. The observation rollout remains paused during the audit.

## Review method

For each rating, record an anonymized assessment with:

- verdict and optional reason;
- whether the complaint is reproducible from the artifact and nearby context;
- primary layer: source/capture, download, transcription, moment selection,
  boundaries, crop/reframe, subtitles, render, or delivery;
- concrete defect pattern and supporting measurements;
- whether the engine already knew the clip was weak;
- severity, confidence, and whether a deterministic regression assertion is
  possible.

Inspect reasoned cases first, then infer the likely issue for ratings without a
reason. A rating is evidence, not ground truth: disagreement with the user must
be recorded explicitly rather than forced into an engine-defect category.

## Clustering and prioritization

Group confirmed cases by root-cause pattern, not merely by feedback reason.
Rank patterns using:

1. number of affected rated clips;
2. user impact (`NO` before `EDIT` when other evidence is equal);
3. confidence that the engine caused the problem;
4. reproducibility in the existing eval harness;
5. blast radius and regression risk of a fix.

The output is a shortlist of three to five patterns. The first implementation
target must be both repeated and reproducible; a one-off subjective complaint
cannot outrank it solely because it is recent.

## Deliverables

Produce a private evidence matrix and a repository-safe summary containing:

- cohort totals and reason distribution;
- confirmed engine defects versus source/taste cases;
- ranked root-cause clusters with anonymized counts;
- the recommended first core change;
- regression fixtures or assertions required before that change;
- cases that need owner judgment rather than automation.

Private working files must stay under a gitignored corpus directory with
restrictive permissions. Temporary media must be deleted after review.

## Improvement gate

No core change is part of this audit. After the owner approves the ranked
findings, the top pattern receives its own focused design and implementation
cycle. That cycle must create a failing regression fixture before changing
production behavior and must replay the broader eval corpus before rollout.

## Acceptance criteria

- All 19 current `EDIT` and `NO` rows are accounted for exactly once.
- Every case has a primary layer, confidence, and evidence disposition.
- Aggregate counts reconcile with the database cohort.
- No private content enters git, chat output, or shell logs.
- At least one implementation candidate is supported by multiple cases, or the
  audit explicitly concludes that the cohort does not justify a core change.
- Repository and production state remain unchanged except for the committed
  design and subsequent audit plan documents.
