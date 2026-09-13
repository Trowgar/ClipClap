# Independent supplemental recall experiment

The completed first holdout comparison does not establish superiority (9 sparse positives: 3 covered by both; 69 versus 65 outputs). Keep f48094d and its artifacts frozen. Do not tune on that holdout.

Development evidence: regional filling changed primary critic batches and displaced good clips; 21/33 jobs still have unjudged nominees below the existing budget. Test an independent pass using only unused budget and unseen, nonoverlapping nominees. Run the existing complete critic/boundary/finalizer/publishability lane separately. Preserve primary clips and ordering exactly; append only noncolliding outputs within the original soft cap. The primary empty-result technical guard remains authoritative. Optional supplemental failure must preserve an already completed primary result and be observable.

Prototype is opt-in through analyzer options, used only by the isolated private replay harness. No production configuration or default change until a broad real-source comparison supports it. Tests protect primary retention/order, overlap deduplication and output limit. Replay unchanged requests from the frozen candidate. Review additions against source and customer feedback; a larger output count alone is not a win.

Nine newly arrived jobs from seven accounts were reserved without content review for a potential fresh holdout; only one currently has a transcript. Do not train on them or claim adequate holdout coverage from one source. Further validation may remain blocked by data availability even with provider access restored.

Completed: 33-source development comparison and three-source fresh holdout. Candidate failed release: 22/32 versus 20/32 development coverage, but 0/15 versus 1/15 fresh coverage. No engine deployed. See docs/quality/2026-09-13-supplemental-recall-evaluation.md.
