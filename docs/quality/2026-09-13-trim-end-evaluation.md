# Isolated opening-trim ending fix

This is a verified mechanical bug fix, **not** the requested substantial improvement of moment selection. Production remains c34dc27; this branch changes only finalizer code and tests.

`tryTrim` previously re-snapped both edges after the finalizer requested an opening trim. This could discard an ending already validated by episode repair. The fix retains that ending, its final node and question status, recomputes duration classification, and refuses restoration violating duration/payoff/hook invariants. Prompts, candidate discovery, scoring and existing start checks are unchanged.

## Real September comparisons

The original account/source exclusions and corrected immutable feedback labels are reused. Tests cover 52 unique sources: 33 development jobs (31 unique sources), 18 previously exposed holdout sources and three additional sources. Two sets of 13 repeated analyses and a fresh full upstream analysis add repeated observations, not independent sources.

Of **81 paired full-analyzer comparisons**, 80 have identical highlight objects. One differs only in `_endNode` and `end`: s057, saved repeat 2, changes 529.39998s to 531.90002s, retaining 2.50005 seconds. The opening remains 475.02s, all four highlights remain, and the changed downstream publishability request completed successfully. The retained sentence clarifies that ordinary eyeglasses/contacts are allowed; it does not establish completeness of the larger advice episode or accuracy of its health claims.

| Set | Covered moments old/new | Clips old/new |
| --- | --- | --- |
| Development, 31 unique sources | 19/32 → 19/32 | 100 → 100 |
| Previously exposed holdout | 3/9 → 3/9 | 69 → 69 |
| Additional three sources | 1/15 → 1/15 | 12 → 12 |
| Saved repeat 2, 13 sources | 17/32 → 17/32 | 46 → 46 |
| Saved repeat 3, 13 sources | 18/32 → 18/32 | 44 → 44 |

Customer acceptance/rejection coverage is unchanged: development AS_IS 0/2 and two exact rejected intervals repeated; additional-source AS_IS 1/1. These remaining failures must not be hidden by a boundary fix. Publishable yield and ranking improvement remain unproven.

A fresh s057 baseline analysis made 14 real provider calls (~60 seconds); candidate replay under the same upstream answers returned the same seven clips and made no additional calls. This checks technical compatibility, not broad stochastic superiority. No untouched final holdout is claimed.

The affected old/new cuts were also rendered through the existing subtitles/reframe/cut functions from the retained real-source preview: 54.428667s and 56.931167s, both reframe ok and successful media probes. Frame inspection confirmed rendered video/subtitles; this is not full audiovisual human review or a full-resolution original render.

## Verification

The new end-preservation regression failed on c34dc27, then passed after the fix. Tests also cover preserving a shortened end and rejecting restoration that would enlarge a validated long clip beyond its allowed duration. Independent review found no new blocker and requested these additional cases.

Matched full worker/shared suites: **baseline 3598 passed / 54 failed; candidate 3601 passed / the same 54 failed names**. Build and typecheck passed. Test environment explicitly sets NODE_ENV=test, ANALYZE_VISUAL_RECALL_V1=off, ANALYZE_PUBLISHABILITY=off, SUBMISSION_QUEUE=off. An initial run inherited production flags and had 78 failures; it is retained separately and is not compared with the prior differently configured suite. The older report's 55-failure count used a different environment; the matched baseline above supersedes it for this branch.

Release gates remain incomplete: the suite is not all green, no independent final holdout demonstrates broader quality, and no broad publishability gain is claimed. No deployment or production restart is performed by this experiment. Rollback reference is c34dc27; the isolated commit can be reviewed separately from earlier experimental lanes.

## Rejected critic recheck probe

Before isolating this fix, 34 displaced critic rejections across the development set were each re-asked as a single-candidate control and a focused nomination recheck (68 successful calls). Focused rechecks evaluated the nominated payoff in 32/34 cases versus 18/34 control, but still rejected the actual customer-approved s037 episode. Its six model keeps are not six publishable improvements; one still contains an undelivered vault setup. No runtime retry was added on that evidence.

## Private reproducibility artifacts

Ignored evidence lives in the first worktree's `apps/worker/tmp/september-core`, mounted into the isolated evaluator. Files: `trim-end-retention-audit.json`, `comparison-trim-end-*.json`, `manifest-trim-end-*.json`, `trim-end-control-suite.json`, `trim-end-clean-suite.json`, per-source `trim-end-only.json`, `trim-end-repeat-2.json`, `trim-end-repeat-3.json`, s057 `trim-fresh-baseline.json` / `trim-fresh-candidate.json`. Requests are replayed only on exact-body matches; changed requests go to the provider. Customer media, transcripts, identifiers and keys are excluded from commits.
