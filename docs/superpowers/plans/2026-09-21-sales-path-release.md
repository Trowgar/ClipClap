# Sales path production release

User approved the four actions in the sales evidence audit; use ponytail full.
Preserve prior workspace changes. Implementation and tests run in an isolated
worktree/container; never build into the live Next directory.

- [ ] Exact seconds in upload UI/API; a shared duration-to-existing-plan choice;
  contextual CTA and plan validation; direct file fallback after probe failure.
- [ ] Read-only provider diagnosis of abandoned checkout and failed renewals;
  paid-only Stripe fulfillment and targeted followup, with unknowns explicit.
- [ ] Reproduce customer cutoff/framing defects; minimum tested safe quality fix,
  no unvalidated model/prompt switch or automatic regeneration of customer jobs.
- [ ] Append-only conversion events with unique paid-event keys, authenticated
  client visibility/click events, server checkout/paid/result events and report.
- [ ] Run targeted regression tests, shared/web/worker checks; independent review.
- [ ] Back up source/build; apply additive migration; build shared and web in
  isolation; deploy tested artifacts, gracefully restart needed processes.
- [ ] Verify public routes/assets, synthetic authenticated upload/CTA scenarios,
  event persistence, payment guards, worker health; record exact release limits.

Boundary examples: 1742s against 1755s allowed, 1756s rejected; 60m -> weekly
Starter, 92m/177m -> monthly Starter; >180m -> no whole-source purchase promise.
No new pricing, no charges, no mass email. Existing own/synthetic exclusions stay.
