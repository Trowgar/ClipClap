# Hook and safe-end observation rollout

**Date:** 2026-08-30
**Status:** approved for implementation

## Goal

Enable the observation-only parts of the 2026-08-29 hook and safe-end work
without changing clip selection, geometry, rendering, or delivery.

## Production configuration

Set exactly:

```env
POST_BOUNDARY_HOOK_GATE=observe
SAFE_END_AUDIT=shadow
```

`POST_BOUNDARY_HOOK_MAX_DELAY_SEC` and
`POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC` must remain absent. `observe` records
geometry but has no filtering authority. Safe-end V1 is shadow-only and may
write telemetry, but its result must not alter the clip list or boundaries.

`POST_BOUNDARY_HOOK_GATE=shadow` and `enforce` are outside this rollout.

## Deployment

Before recreating `worker-analyze`, verify that its BullMQ queue has no active
or waiting jobs. Update `.env`, then force-recreate only `worker-analyze` so it
receives the new environment. Do not restart unrelated services.

## Verification

After recreation:

1. Verify the effective container environment contains the two intended modes
   and no hook threshold variables.
2. Verify startup logs contain no configuration or runtime error.
3. After the first completed canary job, verify persisted ANALYZE telemetry
   contains `postBoundaryHookGate` and `safeEndAudit`.
4. Verify the job completes and its clips pass the existing delivery path.
5. Monitor `analyzeMs`, safe-end audit failures, and LLM usage because safe-end
   shadow adds one no-retry request per eligible job.

## Rollback

If worker startup fails, a canary job fails, or analysis latency becomes
unacceptable, set both modes to `off` and force-recreate only
`worker-analyze`. No data migration or code rollback is required.

## Follow-up gate

Do not approve thresholded shadow or enforcement from this rollout alone.
Hook thresholds require an observe report. Safe-end needs the specification's
minimum cohort and review period before any future action-authority design.
