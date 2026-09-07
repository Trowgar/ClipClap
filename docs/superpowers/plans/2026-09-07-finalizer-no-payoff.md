# Honor explicit finalizer no-payoff decisions

The finalizer cannot repair an incomplete ending, but its shared `floor(n/2)`
drop budget used to override an explicit `no_payoff` veto. With one candidate,
that veto could never remove the clip. A duplicate group's chosen survivor was
also protected even when the finalizer rejected its payoff.

The change makes `no_payoff` terminal outside the soft deletion budget. It
removes those candidates from duplicate election first, so a complete alternative
is not deleted in favor of a vetoed rendition. Other reasons retain their existing
budget/protection. Invalid or missing model replies retain existing handling.
No prompt, model, schema, threshold, dependency, or model call was added/changed.

- [x] Reproduce ignored vetoes for one, two, and three candidates.
- [x] Preserve an alternative when the higher-scored rendition lacks a payoff,
  including a contradictory `duplicateOf` field on the vetoed row.
- [x] Verify the real quality lane returns zero highlights and records
  `finalizer_rejected` for a vetoed sole candidate, with no extra model request.
- [x] Verify recovery does not resurrect those candidates; review duplicate
  handling independently.
- [x] Run focused tests, typecheck, and compare the broad suite with the baseline.

Validation on 2026-09-07:

- The four finalizer regressions failed before the change and pass afterward.
  The quality-lane regression also fails against the original finalizer.
- Final focused run: 123 tests passed across finalizer, quality lane, and
  outcome-recovery suites. Worker TypeScript check passed.
- Broad baseline: 2,981 passed, 23 failed; candidate before the final duplicate
  refinement: 2,985 passed, the same 23 failed. Both also have four import-failing
  suites. Failure identities match exactly. Final duplicate handling and the
  additional lane test are covered by the focused run above.
- Existing broad failures include stale ecology recordings, unavailable Docker
  in the test container, and other baseline failures. This is not an all-green
  release gate; no deployment or customer-data mutation was performed.

Scope limitation: this was found while investigating the fresh BORING report,
but is not its recorded production cause: that clip was positively judged.
Three experimental prompt variants did not reliably reject the rated passage;
all were discarded, including experimental title-copy instructions. The original
interest complaint and title semantic drift remain unresolved. Do not claim a
measured increase in customer postability from this patch.

The private behavioral probes and model responses remain under the ignored
worker corpus `interest-check`; they are exploratory evidence, not formal holdout
or deployment authorization. More empty results are possible where a model
explicitly finds no payoff; this intentionally prioritizes that veto over the
old minimum-output guarantee.
