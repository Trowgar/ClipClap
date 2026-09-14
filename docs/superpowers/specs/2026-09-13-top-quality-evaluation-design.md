# Top Quality Evaluation Design

## Goal

Measure whether `core-supplemental-recall-v1` gives customers more useful clips in the first three and five results, then use the largest measured pipeline loss to drive the next core change.

## Data and isolation

Use only deduplicated external-customer September sources and the recorded baseline/candidate analyzer outputs. Exact or near-identical intervals receive one blind review identity. Customer feedback remains a separate, higher-authority signal. A deterministic source-level split is sealed before reviewing; development reviews may guide changes and holdout reviews are opened only for the final candidate.

## Review rubric

Each finished clip is reviewed without engine/version labels for: publishable, boring, coherent independent value, start boundary, end boundary, sufficient setup/context, delivered payoff, and cross-scene contamination. Transcript evidence is available for every clip. Finished rendered media and ordered frames are used where retained source media permits it. Model judgments are auxiliary and kept separate from customer feedback and independent adjudication.

## Metrics

Report clip-level Precision@3 and Precision@5, unique publishable moments per source, boring rate, good-moment recall, missed good moments per source, bad-boundary rate, incomplete/setup-without-payoff rate, and cross-scene rate. Report the extra 18 supplemental clips as their own cohort. Empty and short result lists stay in source denominators; unknown reviews remain unknown rather than negative.

## Failure tracing and iteration

For every labeled good moment absent from a publishable Top-3 clip, trace candidate discovery, critic decision, rank/final selection, episode construction, context, boundaries, scene consistency, independent value, payoff, and rendering/finalization. Aggregate the first decisive loss by source and moment. Change one root cause at a time, replay the same development sources, perform the same blind comparison, inspect regressions, and open the sealed holdout only after selecting a final candidate.

## Release gate

Do not deploy unless development and sealed holdout improve publishable Top-3/Top-5 yield without a material recall regression, existing safety tests and builds pass, production smoke is stable, and the existing rollback branch remains valid.

## Iteration 2: episode integrity after finalization

The first candidate improved development quality but did not recover the traced
setup loss. A critic-prompt experiment was tested and rejected after labeled
pilot coverage fell from 3/11 to 2/11. Generic end extension was also rejected:
it reduced one source from five clips to four without recovering its moment.

The selected design restores only scanner setup that the critic removed: at most
two nodes and eight seconds, inside the same scene, with a clean start and without
violating hook, NMS, or duration gates. Restoration runs after finalization so a
later stage cannot repeat the loss. Every changed delivered cut must receive a
clean post-final entry, exit, and standalone audit; a missing or adverse audit
restores the already-reviewed old geometry. The exact-literal switch therefore
depends on the delivered-payoff audit switch and leaves the dark path unchanged.

Strict deletion of an audited supplemental terminal failure caused a publishable
Top-5 regression on `b002`. The final design quarantines such clips behind verified
supplemental results and prevents them from replacing primary clips. This keeps
recall when the model cannot supply a safe repair. The eight-source set was opened
to diagnose this regression and is consequently a regression set, not a clean
final holdout. The original 18-source holdout was also opened for the `s011`
setup fix; final reporting must state both limitations rather than describe either
set as independently sealed.
