# Faceless composition implementation plan

**Goal:** Preserve broad graphic inserts that current portrait cropping removes after faces disappear.

**Design:** Under the existing active safety planner plus safe-fit switches, a center-layout span may use existing safe-fit if every overlapping detector shot has no surviving face, has valid saliency, and needs more columns to retain 70% of measured edge energy than the portrait window provides. Read raw detector saliency, independently of the saliency-shadow switch. Unknown or concentrated saliency retains current behavior. Music and face/stream layouts remain unchanged. This is a conservative composition policy, not semantic object detection: textured backgrounds can trigger it and full-frame subjects are smaller.

**Evidence:** Recovered feedback16 original: current single faceless insert span4.67–15.47s loses moving frog/house graphics. Existing safe-fit visibly preserves them. Approved control13 animation also changes to full-frame, restoring scene context and making characters smaller; approved control45 lens-covered source changes without losing an observable subject. Control8 current face layouts remain unchanged. Feedback7's face-carryback over a graphic insert is a separate unresolved problem.

**Plan:**
- [x] Add integration tests for broad empty-face detector shots, flag gating, missing/invalid/concentrated evidence, merge alignment, and surviving faces.
- [x] Observe failing new regression test against main.
- [x] Pass an explicit wide-faceless shot set into the existing safety planner; use its coverage fallback and merge behavior.
- [x] Run focused compute/planner/safety/render tests.
- [x] Replay the implementation against recovered detection captures and render case16 plus approved controls; provide diff for review without deploying.

## Follow-up: leading lifecycle gap (case7)

The retained595–620s source window shows a text card in detector span13.28–25s; the first surviving face sample is22s. The static median anchor covered the card before the face existed. Under the same active flags, splice existing safe-fit into a broad composition's unobserved leading interval, retaining the exact static crop geometry outside it. Both resulting detector portions must satisfy existing minShotSec, the prefix must exceed one sample interval, and final segments must stay within MAX_PLAN_SHOTS. Do not alter detector samples, invent face times, re-run planning, or modify stream/split/trajectory layouts. Aggregate shot saliency is conservative evidence for the prefix, not an independent prefix measurement.

- [x] Demonstrate failed regression against612747f and preserve internal merged-span geometry/evidence.
- [x] Verify flags, cadence/short spans, missing evidence, and existing shot cap.
- [x] Pass164 focused tests and strict changed-file typecheck.
- [x] Render actual implementationcase7; verify full text card while surrounding portrait crops stay intact. Existing seven capture compositions remain as before this follow-up (case16 fallback count changes because segments split before merging).
