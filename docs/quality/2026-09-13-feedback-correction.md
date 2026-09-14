# Correction: September customer-feedback association

The earlier manual analysis reversed two s037 judgments. Immutable feedback snapshots establish:

- AS_IS: **544.6100–571.8200s**, the later face/dialogue episode.
- NO / QUALITY / “Удали”: **147.2900–155.5800s**, the jump.

Earlier claims that the jump was customer-approved, that its retention preserved an AS_IS reference, and that the supplemental candidate retained 2/2 development approvals are false. Frame-based editorial preference must not overwrite a real customer verdict. The raw feedback export was correct; the manual interpretation and derived labels/reviews were wrong.

Original label/review artifacts remain private for audit and are superseded by corrected-moments.json and the corrected manifests. The 32-opportunity development set replaces the falsely approved jump with the actual accepted interval. It is still sparse and predominantly provisional editorial evidence, not exhaustive ground truth.

Final preserved-primary candidate: **19/32 → 21/32** sparse coverage; actual accepted snapshot coverage **0/2 → 1/2**. It still misses the accepted s037 episode and repeats the rejected jump. Across 31 unique development sources, two rejected intervals are reproduced in both versions, including another previously rejected discussion fragment. Do not infer absence of boring clips from incomplete review.

A fresh h001 AS_IS snapshot covers 154–176s and survives both versions. The longer preliminary editorial reference incorrectly implies this approved short cut is a miss; report the two signals separately, giving approval higher weight.

The new evaluation/customer-feedback.ts derives retention and rejection repetition directly from verdict-plus-snapshot, independently of list order or current clip rows. It treats EDIT separately and rejects missing/invalid snapshots. The comparator accepts feedbackFile, validates technical completeness and reports this signal separately from editorial opportunity coverage. Source-identity joins include feedback from retries of the same original; unique-source manifests avoid counting duplicate jobs as independent sources.

No engine version was deployed. The latest candidate also fails to reproduce its extra recall in three wholly fresh model runs; completed cached comparisons are not a proof of stable production superiority.
