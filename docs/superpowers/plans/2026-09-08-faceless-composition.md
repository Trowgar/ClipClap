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
