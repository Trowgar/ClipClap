# Sales-path release — 21 September 2026

Deployed at approximately 14:57 UTC. Runtime commit: `e42e01c`, layered on
isolated snapshot `5469727` of the pre-existing dirty workspace. Existing user
changes were preserved; the live branch was not reset or replaced.
Next build: `Qa1TP3r9KwFkhQq6Owslx`.

## What is live, and what is not complete

1. **Purchase path deployed.** Upload compares seconds, not rounded minute
   labels. Duration selects a sufficient existing plan: 60m weekly Starter,
   92/177m monthly Starter; >180m has no whole-source purchase promise. Both
   web and bot explain the source-minute allowance. Checkout validates the
   requested duration server-side. Top-ups require a live unexpired
   subscription and cover the actual balance, including an existing deficit.
2. **Payment investigation and follow-up performed; causes partly unknown.**
   Stripe confirms five expired unpaid sessions across three people, without
   PaymentIntent/Charge evidence. The first $0.33 difference is tax. Tribute
   confirms the two failed renewals, but supplies no bank decline reason in
   the inspected records. One diagnostic email and two Telegram messages
   were accepted; replies are pending. Telegram support sessions and operator
   reply threads are open. Email replies are directed to the bot because the
   sending domain cannot receive mail. See payment-followup.md for receipts.
   Fulfillment now checks `paid`; async-success delivery was enabled on the
   existing Stripe webhook without changing its URL/version/other events.
3. **File fallback and manual repair deployed; automatic quality NOT fixed.**
   Link failures expose a file chooser. Editor +2/+5 seconds and full-frame
   mode create a new clip from the retained source, preserving the original.
   Missing/short sources are refused; no silently shortened repair. Real
   production media checks pass. The attempted automatic-boundary change
   regressed five approved examples and was withdrawn. Automatic CUTOFF,
   FRAMING and BORING require further evidence-led work; manual controls do
   not satisfy the original automatic-quality acceptance criterion. No model
   switch, customer-job regeneration or paid model evaluation was performed.
4. **Timestamped conversion reporting deployed.** `/admin` now shows separate
   people/actions, distinct provider Checkout IDs, and ordered offer → click
   → Checkout → paid → paid-result people from the same window. Linked web
   and Telegram identities are deduplicated; own/synthetic users excluded.
   A bot offer means successfully sent, not read. Browser impressions require
   visibility. The cohort establishes order, not causal purchase attribution.
   Historical Checkout remains provider evidence, not invented local events.

Thus this is a verified production release, **not completion of every original
acceptance criterion**, and not evidence of increased sales yet. The remaining
business diagnosis depends on replies/new real journeys; automatic quality
still needs a safe fix validated against frozen cases and approvals.

## Verification

- 627 tests passed across 59 suites; final telemetry adjustment additionally
  passed 33 focused tests. Shared build, web production build and bot/worker
  typechecks passed. Worker checks used its proper image (web image lacks
  `fs-ext`). Two real FFmpeg fixtures also passed in isolation.
- Independent review found no remaining deployment blocker. An additional
  top-up negative-balance regression was corrected before deployment.
- Additive migration `20260921143000_conversion_events` applied, all seven
  live Prisma clients regenerated, migration status up to date (46 total).
- Production browser: 8 checks passed, no page errors: 1742s fits 1755s;
  177m defaults to monthly; insufficient weekly purchase rejected; 181m
  disables subscription choices; file fallback opens; contextual offer click
  navigates with duration; editor saves a separate rendered copy; forged
  browser payment event rejected. Rapid repeated QA hit existing nginx rate
  limiting once; the paced final run passed without weakening the limiter.
- Login HTTP 200 and all 12 referenced static assets HTTP 200. Web, bot and
  five worker roles running after restart; analyze/transcribe containers were
  restarted in place, preserving their custom configuration.
- Production +2/+5 repair outputs are 5s/8s, 1080×1920, with correct audio,
  tail-caption pixels, full-width edge markers and newly recovered frames.
  Parent row and media SHA-256 unchanged. Missing-source and beyond-source
  requests create no placeholders. Browser created a third valid +2 copy.
- Actual offer/click/fallback events read back from DB. The synthetic account
  contributes zero people/events to the external report. No real charge was
  created. Temporary synthetic 645-second ledger row removed; QA free balance
  restored to 2400 seconds. Labelled synthetic media remains for inspection
  and ordinary retention; real user records/media were not deleted.

## Operational evidence and rollback

- Backup directory: `/tmp/clipclap-sales-release-qd78GC` contains the pre-release
  database dump, source archive, shared dist and Next build, plus new build and
  browser test/screenshot. Production media proof:
  `/tmp/clipclap-production-proof-SwAHK9/report.json`, `negative-checks.json`,
  `plus-2.png`, `plus-5.png`.
- Synthetic QA job: `cmubddbgb0001ke4hlk1uo4kx`; parent:
  `cmubddbtk0003ke4hdnvxx2vv`. Do not count these as customer outcomes.
- Roll back only this task's source delta and restore the backed-up shared
  dist/Next artifacts while app processes are stopped, then restart existing
  containers. Preserve the additive nullable schema/table and customer data;
  do not restore the entire DB dump over newer transactions. No broad Git
  reset, container recreation or destructive schema downgrade is required.
- Follow-up messaging is an external action and cannot be undone by code
  rollback. Do not resend without checking the recorded receipts.

Ponytail kept existing plans, the existing editor/render pipeline and simple
DB event storage; no new billing product, model or analytics dependency.
