# Next-video sales test — proposal, not launched

Snapshot: 2026-09-21 UTC. No outreach sent by this task.

## Findings

Web and bot rounded source duration up to whole minutes before the allowance check. A 1742-second video was rejected with 1755 seconds available. Both callers now pass fractional minutes, preserving the existing gate API.

Five sampled local FAILED Tribute orders remain pending at Tribute. Reconciliation marks uncompleted orders FAILED after 24 hours. Do not count these as bank declines. Two September cancellations have explicit charge_failed reasons; the order API does not expose the underlying bank reason. Obtain provider transaction diagnostics before changing payment methods.

Recent DONE jobs including non-synthetic accounts: 140. Source median 19.03 minutes, p90 34.13 minutes, maximum 74.93 minutes. Of 126 jobs with transcription and analysis cost fields, summed API cost median $0.132, p90 $0.230, maximum $0.487. This is observed API cost, not total cost or a guarantee for 60-minute inputs; excludes hosting, payment fees, support and refunds. Own accounts were not separately excluded in this cost sample.

## Proposed offer

Web: $5 once for one source up to 60 minutes. No automatic renewal. Keep generated clips for 7 days; no guaranteed number of clips. The 60-minute cap covers most observed tasks. Price is a test, not a proven optimum. Subscription stays available for regular use.

Copy:

> Finish your next video
>
> Process one video up to 60 minutes for $5. One payment, no subscription. Review and download your clips within 7 days.
>
> Process this video — $5 once

Show only after a free user with a previous clip-producing job submits an otherwise valid source that exceeds their remaining free allowance. Explain the actual source length and remaining balance. This avoids asking them to buy before they have a next task.

Before launch: implement a job-bound entitlement separate from subscription top-ups; signed, idempotent payment fulfillment; verified paid status; retry/refund rules for failed or zero-clip jobs; price/fee verification; and exact paid-source binding. Existing top-ups require a subscription and expire with its billing period, so cannot be sold as this offer unchanged.

Measure unique eligible users, visible offers, checkout creation, confirmed payments, completed paid jobs, clip feedback and repeat purchases. Capture individual timestamped events if daily campaign attribution is required; lifetime occurrences cannot reconstruct historical daily counts.

First review after 20 eligible users actually see the offer, or 14 days if traffic is lower. Two purchases with successful delivery warrant another cohort, not a claim of proven uplift. Zero purchases warrants interviews before price cuts. This small sample is a directional test, not a statistically powered A/B experiment.

## Five interview drafts

Selection: five non-synthetic web accounts with clip-producing history and a recent FREE_EXHAUSTED refusal. Use the most recent source as context; verify preferred language and contact eligibility before sending. Do not imply clips were published. These drafts are not sent.

Subject: Did the clips work for your video?

1. Your recent 11-minute video produced 2 clips. Were either of them useful enough to publish? What stopped you from processing your next video?
2. Your recent 27-minute video produced 5 clips. Did any work as delivered, or did they need changes? What stopped you from continuing?
3. Your recent 16-minute video produced 6 clips. Which, if any, would you use? What was missing before you would pay for another video?
4. Your recent 20-minute video produced 6 clips. Were the selected moments and endings right? What stopped you from processing the next video?
5. Your recent 33-minute video produced 8 clips. Were any ready to publish? Was continuing blocked by the results, the subscription, or something else?

Send individually after reviewing the actual account context. Start with their result; introduce the proposed one-off purchase only after they describe the obstacle. Do not promise a product that is not yet implemented.
