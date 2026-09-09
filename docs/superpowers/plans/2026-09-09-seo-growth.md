# ClipClap SEO implementation and measurement plan

**Goal:** Improve the existing eight public URLs for English search, provisionally US. Ranking and indexing are external outcomes, not deployment acceptance tests.

**Architecture:** Keep the existing Next.js routes and dark landing design. Use native Image optimization, existing comparison links and plan constants; no dependencies or duplicate pillar pages. Keep login noindex.

- [x] Record live HTTP, canonical, robots and initial HTML checks; mobile Lighthouse baseline.
- [x] Update homepage H1/title, practical workflow, limits, FAQ and contextual comparison links. Make essential content visible before hydration. Optimize the five large images with Next Image.
- [x] Correct Opus credit allowances and API availability against https://www.opus.pro/pricing; qualify historical Telegram competitor claims and link primary sources. Add a usable Telegram workflow.
- [x] Add contextual links from hub and related comparisons; accurate sitemap modification dates; Organization/WebSite structured data using verifiable identity only.
- [x] Run existing web tests, production build and HTTP smoke checks on an isolated candidate. Check mobile layout and Lighthouse on home, Telegram, Opus and hub, both device presets.
- [x] Publish the verified web build with a rollback copy and recheck public URLs. Record remaining Search Console actions and weekly query/activation measurements in docs/seo/2026-09-09-growth.md.

## Query ownership

All target English / US initially. These are target hypotheses, not verified search volumes or difficulty scores.

| Query | URL | Intent / CTA |
| --- | --- | --- |
| AI video clipper | / | Product / browser trial |
| long video to short clips | / | Product / browser trial |
| Telegram video clipper bot | /telegram-video-clipper-bots | Workflow / tagged bot start |
| AI video clipper Telegram | /telegram-video-clipper-bots | Workflow / tagged bot start |
| Opus Clip alternative | /opus-clip-alternative | Comparison / tagged bot start or browser |
| Opus Clip alternative without watermark | /opus-clip-alternative | Comparison / trial |
| Submagic alternative | /submagic-alternative | Comparison / trial |
| Crayo AI alternative | /crayo-alternative | Comparison / trial |
| Klap alternative | /klap-alternative | Comparison / trial |
| AI clipping tools compared | /ai-clipping-tools-compared | Evaluation / comparison or trial |

## Alternatives considered

Only changing metadata is quick but leaves weak navigation and the image payload. Creating many new pages spreads a small site's evidence across overlapping intents. Strengthening existing routes is the first release; assess podcast and Twitch task pages after index coverage and query data improve.

## Outcome measurement

Baseline supplied by owner: 2 clicks, 113 impressions, average position 51.1; 6/8 useful URLs indexed. Weekly: same 28-day window and US/English query clusters; nonbrand clicks/impressions, indexed URLs, registrations and first successful jobs. Aspiration: three to five named long-tail queries in top five; no guaranteed deadline. Request indexing of Telegram and Opus once after release using Search Console UI. Neither a sitemap nor HTTP 200 guarantees indexing.
