# ClipClap US SEO growth sprint design

**Date:** 2026-09-20  
**Status:** Design approved for specification review  
**Scope:** P0 technical SEO fixes plus five US-focused landing pages

## Objective

Increase ClipClap's qualified English-language visibility, with the United States as the first market, by fixing the known indexability and snippet issues and creating a small set of distinct pages that own non-brand product intents.

The sprint is intended to improve crawlability, relevance, click-through rate, and conversion paths. Top-three rankings are an external outcome and are not treated as a deployment guarantee.

## Evidence and constraints

- Search Console shows early visibility but almost no non-brand clicks; the US has the largest impression count and an average position in the low 40s.
- The public app is a Next.js 15 App Router site with server-rendered marketing routes, a shared root JSON-LD graph, generated sitemap/robots routes, and no blog/CMS.
- Existing product facts must continue to come from `packages/shared/src/config/plans.ts` where possible. The free allowance, prices, source-minute billing, input sources, Telegram workflow, and processing limitations must not drift between copy, UI, and structured data.
- Existing uncommitted user files are outside this sprint and must remain untouched.
- No new dependency, automatic geo-redirect, `/us/` duplicate, or unsupported product capability will be introduced.
- Google FAQ rich-result markup is not a goal. Visible FAQ-style answers may be used where helpful, but the new pages will not add `FAQPage` JSON-LD.

The earlier `docs/superpowers/plans/2026-09-09-seo-growth.md` strengthened the existing public surface. This sprint deliberately extends that plan because the owner has now chosen to add five intent-specific US pages.

## Selected approach

Use a shared, server-rendered SEO landing-page presentation with per-route content records. Each route owns its metadata, target intent, proof points, limitations, CTA labels, and internal-link set; the shared presentation owns layout, breadcrumbs, visible sections, and schema plumbing.

This keeps the five pages maintainable without creating a dynamic catch-all that makes every page look like a keyword substitution. It also avoids five copies of the same layout while preserving unique, reviewable content per intent.

### Rejected alternatives

1. **Five completely hand-written pages:** maximum local control, but repeated layout and metadata code would make future corrections drift.
2. **One dynamic `[slug]` route:** shortest file count, but too easy to produce thin template pages and harder to review canonical/page-specific content.
3. **Metadata-only changes:** low effort, but insufficient for the current content-gap and internal-link evidence.

## Public URL architecture

### New product-intent routes

| URL | Primary intent | Distinct angle | Primary CTA |
| --- | --- | --- | --- |
| `/ai-video-clipper` | AI video clipper | Long video in, AI-selected vertical clips and burned-in subtitles out; browser and Telegram workflows | Start a free clip |
| `/podcast-to-shorts` | podcast to Shorts | Turn interviews and podcasts into self-contained short clips; review transcription and framing before publishing | Turn a podcast into Shorts |
| `/twitch-clip-maker` | Twitch clip maker | Process streams/VODs and keep webcam plus gameplay context visible in a vertical frame | Clip a Twitch VOD |
| `/youtube-to-shorts` | YouTube to Shorts | Import a YouTube URL or upload an owned/permitted file, then review and export Shorts-ready clips | Make YouTube Shorts |
| `/telegram-video-clipper` | Telegram video clipper | Product landing page for sending a link/file to the bot and receiving clips in the same chat | Open ClipClap in Telegram |

The existing `/telegram-video-clipper-bots` remains the comparison/workflow guide. The new `/telegram-video-clipper` is a focused product page and must link to the guide for bot comparisons and limitations; its body must not duplicate the guide wholesale.

### Existing routes affected

- `/` links to all five product-intent pages from a visible, crawlable use-case section while retaining the current primary CTA and existing comparison links.
- `/telegram-video-clipper-bots` links to `/telegram-video-clipper` and keeps its independent guide intent.
- Existing comparison pages link to the most relevant product-intent page where a link is contextually useful; no site-wide keyword-stuffed footer will be added.
- The five new pages link back to the homepage, one relevant guide/comparison, and a small number of adjacent product pages selected by intent.

## Page composition

Each new page uses the same structural shell:

1. Header with a home link and a clear trial/Telegram CTA.
2. Breadcrumb: `Home → [page topic]` rendered visibly and as `BreadcrumbList` JSON-LD.
3. Intent-specific H1 and a short above-the-fold answer that states what ClipClap does and who it is for.
4. Proof-point row using verified facts: source inputs, vertical 9:16 output, burned-in subtitles, browser/Telegram access, free allowance, or no-watermark policy where applicable.
5. Intent-specific workflow with three or four steps.
6. “What to check before publishing” / limitation block that states unsupported or conditional behavior honestly.
7. Related use cases and guide/comparison links.
8. Visible questions and answers where they clarify the intent; no new FAQ schema.
9. Bottom CTA with the same tagged attribution convention already used by the site.

Content rules:

- The first paragraph must answer the query without requiring JavaScript or interaction.
- Each page must contain at least two sections whose examples and limitations are specific to its intent; swapping the keyword alone is not acceptable.
- All claims about current pricing, allowances, source-length limits, and integrations must be sourced from existing code or explicitly described as conditional.
- YouTube/Twitch content must include a short rights reminder: process content the visitor owns or is permitted to reuse.
- No promise of virality, guaranteed views, automatic publishing, account connection, or features the product does not currently provide.
- New copy should use American English spelling and terminology while remaining globally accurate.

## Metadata and structured data

Every new route will define:

- a unique title focused on the route intent and ClipClap;
- a description kept concise enough for normal search snippets, with the benefit early;
- a self-referencing canonical;
- Open Graph metadata matching the visible page;
- a `WebPage` plus `BreadcrumbList` JSON-LD block, referencing the existing site/organization identifiers where practical.

The root `Organization`, `WebSite`, and `SoftwareApplication` graph remains the single source for site-wide product identity and offers. The new pages will not repeat a full offer catalog or invent ratings/reviews. Existing FAQ markup on older pages is outside this sprint; new pages will not add more of it.

## P0 technical fixes

### Legacy URL

Add a permanent redirect from `/crayo-ai-alternative` to `/crayo-alternative`, because it is a near-match legacy/product URL and the target already exists. This removes the observed 404-plus-home-canonical ambiguity while preserving any legitimate external signal.

### Sitemap

Extend the generated sitemap with the five new canonical routes. Keep the existing hand-maintained `lastModified` discipline, include only routes intended to rank, and do not add `/login`, dashboard routes, assets, or the legacy redirect URL.

### Snippets

Shorten the current overly long descriptions on the homepage, Telegram guide, and comparison routes where they exceed useful snippet length. Preserve factual specificity; do not reduce them to generic keyword strings.

### Telegram guide

Improve the existing guide's opening answer, CTA path, and links to the new Telegram product page. Keep its comparison evidence and dated source notes intact. Use existing screenshots/assets only unless a real product screenshot is supplied; no synthetic proof image will be presented as a user result.

## Internal-link model

Create one small reusable component/data source for curated product links rather than expanding the existing comparison list into a dense link-everything graph.

The homepage is the strongest internal authority and links to every new intent page. Each new page receives links from the homepage and at least one relevant existing public page. Link text describes the destination naturally, for example “AI video clipper for long videos” or “turn a podcast into Shorts,” not repeated exact-match anchors on every page.

## Mobile and performance constraints

- Keep new pages server components with no client-side animation or third-party widget.
- Reuse existing CSS utilities and public assets; do not add a visual library or large media bundle.
- Keep the first-screen CTA visible on narrow screens and avoid layout shifts from un-sized media.
- Use semantic headings, lists, navigation landmarks, keyboard-visible focus, and readable contrast.
- Validate that the new pages do not increase the initial JavaScript payload through accidental client-component imports.

## Measurement and falsifiability

### THINK

The primary observed constraint is not a missing canonical on every page; it is weak non-brand relevance and low authority after Google has already discovered the public surface. The new URLs therefore own distinct intents and connect them to the existing evidence rather than multiplying near-duplicate comparison pages.

### CONNECT

The redirect and snippet fixes remove technical/CTR ambiguity first. Sitemap and internal links then expose the new pages. Unique intent content supplies relevance, while external mentions and Search Console performance remain later dependencies that code alone cannot create.

### ACCEPT

The sprint is considered unsuccessful for SEO if, after reasonable indexing time, the new URLs remain discovered but not indexed, or impressions rise without any improvement in query-level average positions/CTR. That outcome would trigger content/evidence and authority investigation, not more duplicate landing pages.

### GROW

Track weekly in a consistent 28-day window:

- US impressions and clicks for each new URL;
- non-brand queries and queries in positions 4–20;
- indexed versus “crawled, currently not indexed” URLs;
- page-level CTR;
- CTA clicks, registrations, first successful jobs, and Telegram bot starts by tagged source.

Ranking targets are hypotheses. The first leading indicators are index coverage, impressions for the owned query cluster, and CTA engagement.

## Verification and rollout

Before claiming completion:

1. Run the web TypeScript/build checks and the existing relevant tests.
2. Run a local HTTP smoke check for all new pages, the redirect, sitemap, robots, and representative existing pages.
3. Verify each new page's status, title, description, H1, canonical, robots behavior, JSON-LD parseability, and internal links.
4. Check responsive layout and CTA visibility at a mobile viewport.
5. Review the diff to confirm no user-owned untracked files were modified.
6. Deploy only after the production build passes; then request indexing once for the new URLs and the strengthened Telegram guide.

The implementation does not include backlink purchasing, automatic US redirection, a duplicated `/us/` site, a blog CMS, generated images, or a promise of top-three placement.

