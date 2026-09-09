# Fresh BORING feedback: core audit

Date: 2026-09-07. Scope: the latest NO/BORING rating, submitted on
2026-09-06, its ten-clip job, delivered evidence, nearby source context, and
current analyzer code. Investigation only; no production behavior changed.

## Conclusion

The report exposes a likely selection-quality weakness and a separately
confirmed title-grounding defect. It does not establish a render failure or
a recovery-path regression. A user's BORING label alone cannot make interest
an objective, deterministic property.

The selected passage is a complete, emphatic explanation. Its dramatic value
depends on a preceding dispute; extracted alone, it offers limited novelty,
development, or surprise. This is an editorial assessment supported by the
transcript and sampled source/delivery frames, not a universally valid reject
label for gaming explanations.

## Recorded production evidence

- Source duration: 3,308 seconds; transcript coverage: 1.0, not partial.
- Output: ten clips. Rated clip: 19.34-second selected interval, score 0.72,
  kind `insight`, `lowQuality=false`; fifth in score ordering.
- Analyzer ran the standard rubric. A stream-shaped source does not imply
  that the stream analysis rubric fired.
- Scanner: 119 raw candidates, 70 merged; 36 received critic verdicts.
  The target received `keep=true` and score 0.72.
- Target arc entry, exit, and standalone flags all passed. It was absent
  from the recorded drops; finalization retained it and rewrote its title.
- Recovery attribution: `core-v4-recovery-v1`, mode `shadow`,
  `not_eligible`, reason `non_empty`, zero added model requests.
  The target was not recovered or resurrected after a rejection.

## Fresh diagnostic reproduction

Rebuilt the sentence graph from the stored transcript and verified that the
shipped node interval maps back to its recorded hook. Ran the current
`runCritic` three times on that interval, with its normal surrounding context,
standard rubric, configured model `gpt-5.6-luna`, and reasoning effort `low`.

All three returned `keep=true`, `grounded=true`, `selfContained=true`, and
the same boundary nodes. Scores were 0.78, 0.72, and 0.78. No fallback,
truncation, omission, or invariant drop occurred.

This is fresh isolated rejudging, **not exact production replay**: the original
scanner range, full critic batch, and raw model responses were not available
in the captured job. It demonstrates repeatable acceptance of the shipped
passage, not deterministic reproduction of the whole selection process.

## Mechanisms

1. **Likely interest overvaluation at the critic.** The rubric already asks
   for scroll-stopping value and rejection of generic information
   (`apps/worker/src/analyze-v2/prompts.ts`, critic rules). Nonetheless, this
   emphatic, coherent passage repeatedly passes. The current scalar score
   does not reliably distinguish coherence/emphasis from standalone appeal.
2. **Limited final editorial correction.** The finalizer assumes an earlier
   strict judge has passed every clip, cannot rescore, and explicitly prefers
   keeping a mediocre clip to dropping a good one. Its explicit checks focus
   on coherence, boundaries, duplication, and copy. It has a general final
   verdict rule, but no dedicated low-interest rejection reason. This is a
   plausible contributor, not proof that a new enum would solve selection.
3. **Confirmed semantic drift in the title rewrite.** The final title changes
   the proposition from who can win to whom one cannot defeat. The clip does
   not establish the latter. Telemetry attributes the change to finalization.
   `tryRewrite` in `apps/worker/src/analyze-v2/finalize.ts` checks length,
   in-range evidence indices, and script compatibility; those checks cannot
   detect reversal of semantic roles. The model supplied the semantic error;
   the structural validator accepted it within its existing contract.

The title defect is attributable to the engine. Its contribution to the
user's BORING rating is unknown and should not be conflated with moment appeal.

## Media and comparison limits

The permanent feedback copy decodes as 1080x1920, square pixels, duration
19.366 seconds. FFmpeg found no black interval at least 0.1 seconds long and
no silence interval at least 0.5 seconds at -35 dB. Sampled frames show the
speaker and subtitles. These checks do not certify all aspects of render,
subtitle, or audio quality.

Reviewed an approximately 78-second source excerpt around the target using
sampled frames and the stored transcript. The preceding dispute provides
context; the selected passage completes before the source outro. There is
no demonstrated missing immediate payoff that a simple end extension fixes.

Compared metadata and descriptions of all ten siblings. Other selected
moments contain more concrete conflicts or contradictions, but they have no
positive ratings in this audit. They are not validated preferred alternatives.
The full source and all unjudged candidates were not exhaustively reviewed.

## Next development target

Keep interest assessment and title truthfulness as separate work items.
For selection, evaluate concrete viewer value, novelty, and dependence on
off-clip conflict against both rejected clips and known positive niche clips.
Do not raise the global score threshold on the strength of this case.
For titles, add an evaluation case for subject/object and claim-direction
preservation; repair bad copy without discarding an otherwise valid clip.

Private evidence, source excerpt, request fingerprint, runnable probe, and
three complete diagnostic results are in the ignored worker corpus directory
`boring-audit-2026-09-07`, with directory mode 0700 and file mode 0600.
No customer rows, deployed prompts/configuration, or services were changed.
