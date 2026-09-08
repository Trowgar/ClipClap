# Final clip review: production release, 2026-09-08

The analyze worker on linearis-prod now runs `ANALYZE_PUBLISHABILITY=on`.
It rejects explicit generic restatements and validates the meaning of final
titles after boundary/copy repair. The explicit missing-payoff veto is also live.

Main received only `a287abd` and `5efb881` (cherry-picks of `c482235` and
`3421fc3`), plus the documented environment toggle. Activation merged them
into the existing live source at `3dd151785f2cdebb8fa8a8c5871aa56db6005899`,
preserving the host's existing stream/reframe and operational fixes.
This host uses source bind mounts and `tsx watch`; the running image revision
alone does not identify its effective source. The release is recorded by the
`prod/core-2026-09-08-publishability` Git tag. It is a targeted bugfix rollout,
not a passing composite quality-gate or audience-preference claim.

Verification:

- Clean main-based candidate: worker typecheck, worker/shared build, and eight
  focused suites passed in the worker Docker environment: 237 tests.
- Predeployment model call using production settings: 12 final clips reviewed,
  only the original BORING case removed, 11 retained, no rejected title repairs;
  17.3 seconds, 2,717 input / 1,603 output tokens.
- A second call inside the restarted production analyze container loaded its
  actual configuration without forcing the feature on: same single rejection,
  11 retained, one supported title correction, no rejected repairs;
  23.7 seconds, 2,717 input / 2,088 output tokens.
- The four changed runtime modules had identical hashes in the host checkout
  and running container. All five workers restarted successfully, with one
  registered consumer each and no paused, active, waiting, or delayed jobs at
  the postdeployment check. Existing customer records were not replayed or changed.

These model calls reused development cases, not an independent holdout or a
new customer delivery. The earlier broad suite had the same 23 failing tests
and four import-failing suites as baseline; this release does not claim a fully
green repository. Model decisions and latency vary. The feature makes one
additional model request per nonempty quality lane and does not backfill vetoes.
Customer acceptance improvement must be measured from subsequent real feedback.

Private evidence and the predeployment environment are under the ignored
`apps/worker/.corpus/releases/2026-09-08-publishability/` directory.
No customer speech, titles, IDs, or environment secrets belong in this record.

## Other recovery work

Later on 2026-09-08, Rescue v2 was deleted and V4 was retired after its real-source
checks showed no additional clips. See [the retirement record](2026-09-08-v4-release.md).
The publishability fix described above remains enabled.

## Disable the final review

Set `ANALYZE_PUBLISHABILITY=off` in the host `.env` and recreate only the analyze
worker when it has no active job:

```sh
docker compose up -d --no-deps --no-build worker-analyze
docker compose logs --since 2m worker-analyze
docker exec clipclapio-worker-analyze-1 printenv ANALYZE_PUBLISHABILITY
```

This removes the extra review call and its veto/title-repair decisions; the
explicit missing-payoff fix remains. The complete predeployment source was
`80315ce`, retained on `fix/stream-full-frame-content`, and its environment
backup is in the private release evidence directory.
