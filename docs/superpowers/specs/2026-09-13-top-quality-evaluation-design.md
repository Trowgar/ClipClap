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
