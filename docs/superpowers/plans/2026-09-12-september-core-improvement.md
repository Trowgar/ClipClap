# September core improvement protocol

Goal: improve real customer moment recall and publishability, preserving accepted moments. The user authorizes investigation, implementation, live evaluation and deployment conditional on convincing quality and technical gates. Work is isolated from the source-mounted live workers.

- [x] Capture September 1–12 at 2026-09-12T23:27:42Z: 72 jobs, 52 external accounts, 213 stored clip rows, 18 feedback records. Exclude synthetic, configured owner/admin and identifiable test accounts.
- [x] Freeze account/source-connected split before experimenting: 52 development jobs, 20 holdout jobs. Same fingerprint, URL, upload key or identical transcript joins accounts. Previously read review cases are development. Private split and content remain outside git.
- [x] Capture effective production config and baseline commit c34dc27. Historical delivered results are distinct from a fresh baseline under today's code.
- [x] Review source media, original clips, feedback and stage telemetry across languages, duration ranges, zero-result and unrated cases. Count repeated uploads separately from distinct sources.
- [x] Record exact model requests/responses in invocation order. Replay unchanged requests; changed requests require fresh provider calls. Retain actual returned model, failures, tokens and latency.
- [x] Trace good and bad moments through discovery, candidate partition, critic, snap, NMS, arc repair, finalizer and publishability. Do not infer cause from the feedback reason alone.
- [x] Test candidate-partition hypothesis: regional diversity cap leaves affordable candidates unjudged even below total K. Compare filling remaining budget after the diversity pass, preserving every original selection, all quality thresholds and the global spend bound. Reject if extra candidates are useless or displace accepted moments.
- [x] Consider episode/finalizer changes only if observed errors justify them; avoid raising rejection thresholds to hide recall losses.
- [x] Extend eval with explicit moment labels, payoff/setup coverage, unique publishable yield per source, missed positives, P@3/P@5, fixed-K yield, boring and boundary counts. Unknown/unrated outputs are not negatives. Model scores are auxiliary; customer AS_IS remains a protected positive.
- [x] Add failing regression checks before production code. Test the actual cause, not a mock copy of implementation.
- [x] Compare development outputs, inspect changed cuts and diagnose regressions. Freeze code/config before opening holdout. Repeated attempts on development measure model variability.
- [ ] Evaluate holdout once; report independent source/account denominators and limitations. Do not retune on it.
- [ ] Run existing tests, typecheck, build and production-config replay; separate baseline test failures from regressions. No production deployment unless the requested technical and quality gates pass. Preserve baseline source/config and follow queue-drain/source-bind-mount deployment procedure.
- [x] Report actual code/eval/holdout/deployment outcome and remaining priorities, including any unmet user requirement.

Private evidence: apps/worker/tmp/september-core/ in this worktree. Media previews may be downscaled to control temporary disk use; original storage objects are unchanged. Full-quality renders must use retained originals. Frame/transcript review is not a full audio listening review.

Progress 2026-09-13: see [evidence report](../../quality/2026-09-13-september-core-evaluation.md). Investigation/replay and metric implementation are complete to the documented scope; review coverage is partial. Runtime frozen before holdout. Broad experimental variants were rejected. Production gates remain unmet: incomplete holdout/provider quota, unresolved quality regressions, incomplete audiovisual publishability reviews and pre-existing test failures. No deployment.
