# ClipClap US SEO Growth Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship the approved P0 technical SEO fixes and five distinct US-focused product landing pages, then verify and deploy the web surface to production.

**Architecture:** Store the five page records in one typed, framework-light data module. Render them through one server-rendered SEO landing component and one metadata helper, while keeping each Next.js route explicit and independently canonical. Extend the existing sitemap and curated internal-link graph; use a Next.js permanent redirect for the legacy Crayo URL.

**Tech Stack:** Next.js 15 App Router, TypeScript, React server components, existing Tailwind utilities, Vitest, Docker Compose/Caddy production runtime.

---

## Baseline and environment

The worktree is /home/trowgar/.config/superpowers/worktrees/clipclap.io/seo-us-growth on branch feature/seo-us-growth. The repository's current production convention is documented in CLAUDE.md: the host runs the plain development-target docker compose stack as production, and docker compose up -d --build web recreates the web container. Do not use TARGET=production.

The system Node is 18.19.1 while the lockfile resolves Vite/Vitest packages that require Node 20 for the current test runner. Do not edit dependency versions for this task. Run local tests/build with Node 20+ if available; otherwise run the same checks inside the repository's supported Docker environment and record the Node-18 limitation separately.

## File map

Create:

- apps/web/lib/seo-landing-pages.ts — typed records for the five new URLs, metadata facts, content sections, CTA targets, and curated related links.
- apps/web/lib/seo-metadata.ts — one helper that turns a page record into Next Metadata with a self-canonical and matching social metadata.
- apps/web/components/seo-landing-page.tsx — shared server-rendered layout, visible breadcrumbs, content blocks, CTA links, and WebPage/BreadcrumbList JSON-LD.
- apps/web/src/__tests__/seo-landing-pages.test.ts — contract tests for the page set, uniqueness, links, and factual content.
- apps/web/app/ai-video-clipper/page.tsx — explicit route wrapper.
- apps/web/app/podcast-to-shorts/page.tsx — explicit route wrapper.
- apps/web/app/twitch-clip-maker/page.tsx — explicit route wrapper.
- apps/web/app/youtube-to-shorts/page.tsx — explicit route wrapper.
- apps/web/app/telegram-video-clipper/page.tsx — explicit route wrapper.

Modify:

- apps/web/components/landing-seo.tsx — crawlable links to all five product pages without moving the existing primary CTA.
- apps/web/app/layout.tsx — shorten the root description and matching Open Graph description.
- apps/web/app/telegram-video-clipper-bots/page.tsx — concise description, stronger opening/product link, and a contextual link to the new Telegram product page.
- apps/web/components/related-comparisons.tsx — add a small curated map from existing public pages to relevant new product pages; do not create a dense all-to-all footer.
- apps/web/app/sitemap.ts — include the five new canonical routes with explicit lastModified dates.
- apps/web/next.config.ts — permanent redirect from /crayo-ai-alternative to /crayo-alternative.
- Existing comparison route metadata files under apps/web/app/*-alternative/page.tsx and apps/web/app/ai-clipping-tools-compared/page.tsx — shorten descriptions where they exceed useful snippet length without changing comparison claims.
- apps/web/src/__tests__/landing-cta.test.ts — assert that the homepage source exposes all five product links.

## Task 1: Establish and test the page data contract

**Files:**

- Create: apps/web/src/__tests__/seo-landing-pages.test.ts
- Create: apps/web/lib/seo-landing-pages.ts

- [ ] Step 1: Write the failing contract test.

Add this test before creating the data module:

    import { describe, expect, it } from "vitest";
    import { PRODUCT_SEO_PAGES } from "../../lib/seo-landing-pages";

    const EXPECTED_SLUGS = [
      "ai-video-clipper",
      "podcast-to-shorts",
      "twitch-clip-maker",
      "youtube-to-shorts",
      "telegram-video-clipper",
    ] as const;

    describe("US product SEO page contract", () => {
      it("owns exactly the five approved product intents", () => {
        expect(PRODUCT_SEO_PAGES.map((page) => page.slug)).toEqual(EXPECTED_SLUGS);
      });

      it("keeps metadata unique and concise", () => {
        expect(new Set(PRODUCT_SEO_PAGES.map((page) => page.title)).size).toBe(5);
        expect(new Set(PRODUCT_SEO_PAGES.map((page) => page.description)).size).toBe(5);
        for (const page of PRODUCT_SEO_PAGES) {
          expect(page.description.length).toBeLessThanOrEqual(165);
          expect(page.h1.toLowerCase()).toContain(page.primaryKeyword.toLowerCase());
        }
      });

      it("uses only known internal related-page slugs", () => {
        const known = new Set(EXPECTED_SLUGS);
        known.add("/");
        known.add("telegram-video-clipper-bots");
        known.add("ai-clipping-tools-compared");
        for (const page of PRODUCT_SEO_PAGES) {
          for (const related of page.relatedSlugs) expect(known.has(related)).toBe(true);
        }
      });

      it("keeps every intent specific instead of keyword-swapping one paragraph", () => {
        for (const page of PRODUCT_SEO_PAGES) {
          expect(page.workflow.length).toBeGreaterThanOrEqual(3);
          expect(page.limitations.length).toBeGreaterThanOrEqual(2);
          expect(page.intro).toContain(page.primaryKeyword);
        }
      });
    });

- [ ] Step 2: Run the focused test and confirm the expected RED failure.

Run with Node 20+:

    npx vitest run apps/web/src/__tests__/seo-landing-pages.test.ts

Expected result: startup or module failure because apps/web/lib/seo-landing-pages.ts does not exist yet. If the runner fails before collecting tests under Node 18, repeat inside the supported Node 20+ container; do not count the environment failure as a passing test.

- [ ] Step 3: Add the minimal typed data model and five records.

Define a plain TypeScript type with these fields:

    export type SeoLandingPage = {
      slug: string;
      path: string;
      primaryKeyword: string;
      title: string;
      description: string;
      breadcrumb: string;
      eyebrow: string;
      h1: string;
      intro: string;
      ctaLabel: string;
      ctaHref: string;
      proofPoints: readonly { label: string; value: string }[];
      workflow: readonly { title: string; text: string }[];
      limitations: readonly string[];
      questions: readonly { question: string; answer: string }[];
      relatedSlugs: readonly string[];
      lastModified: string;
    };

Add one record for each approved slug. Use American English copy and the real product facts already visible in the codebase: YouTube/Twitch/TikTok links or upload, 9:16 clips, burned-in subtitles, 40 free source minutes, no card, no watermark on the free output, browser/Telegram workflows, 2 GB file limit, 60-second minimum, paid source duration limit, manual review, and the product's lack of automatic publishing/account connection where relevant. Do not claim guaranteed views, Twitch account sync, auto-posting, or an API.

Set relatedSlugs as curated links, for example:

    relatedSlugs: ["ai-video-clipper", "ai-clipping-tools-compared", "/"]

Use the route's own slug only in the record's path, never in its relatedSlugs. Keep each description at or below 165 characters.

- [ ] Step 4: Run the focused test and confirm GREEN.

    npx vitest run apps/web/src/__tests__/seo-landing-pages.test.ts

Expected result: all four contract tests pass.

- [ ] Step 5: Commit the data contract.

    git add apps/web/lib/seo-landing-pages.ts apps/web/src/__tests__/seo-landing-pages.test.ts
    git commit -m "feat(web): define US SEO landing page content"

## Task 2: Build the shared renderer and metadata helper

**Files:**

- Create: apps/web/lib/seo-metadata.ts
- Create: apps/web/components/seo-landing-page.tsx

- [ ] Step 1: Add a metadata helper test to the existing contract test.

Add this import and test before implementing the helper:

    import { createSeoMetadata } from "../../lib/seo-metadata";

    it("creates a self-canonical metadata object", () => {
      const metadata = createSeoMetadata(PRODUCT_SEO_PAGES[0]);
      expect(metadata.title).toBe(PRODUCT_SEO_PAGES[0].title);
      expect(metadata.description).toBe(PRODUCT_SEO_PAGES[0].description);
      expect(metadata.alternates?.canonical).toBe(PRODUCT_SEO_PAGES[0].path);
      expect(metadata.openGraph?.url).toContain(PRODUCT_SEO_PAGES[0].path);
    });

- [ ] Step 2: Run the focused test and confirm RED.

    npx vitest run apps/web/src/__tests__/seo-landing-pages.test.ts

Expected result: module failure because apps/web/lib/seo-metadata.ts does not exist.

- [ ] Step 3: Implement the metadata helper.

Use NEXT_PUBLIC_APP_URL or https://clipclap.io as the metadata base and return title, description, alternates.canonical, Open Graph type website, matching Open Graph URL/title/description, and a summary Twitter card. Do not add per-page offers, reviews, or FAQ schema.

- [ ] Step 4: Implement the server-rendered landing component.

Render semantic main, a header with a home link and CTA, a visible breadcrumb, one H1, intro text, proof-point cards, a three-step workflow, limitations, visible questions/answers, curated related links, and a final CTA. Use only existing Link and Tailwind classes. Keep it a server component with no use-client directive.

Embed one JSON-LD graph with a WebPage and BreadcrumbList. The WebPage must contain the page URL, page title, description, English language, and the existing website identifier. The breadcrumb must contain Home at position 1 and the current page at position 2. Use JSON.stringify as the existing layout does. Render question/answer content as normal visible HTML; do not emit FAQPage JSON-LD.

- [ ] Step 5: Run the focused test and the web TypeScript check.

    npx vitest run apps/web/src/__tests__/seo-landing-pages.test.ts
    npx tsc --noEmit -p apps/web/tsconfig.json

Expected result: the contract and metadata tests pass, and TypeScript exits 0 under Node 20+ or the supported container.

- [ ] Step 6: Commit the shared renderer.

    git add apps/web/lib/seo-metadata.ts apps/web/components/seo-landing-page.tsx apps/web/src/__tests__/seo-landing-pages.test.ts
    git commit -m "feat(web): add shared SEO landing renderer"

## Task 3: Add the five explicit routes and the crawlable link graph

**Files:**

- Create: the five apps/web/app/<slug>/page.tsx route wrappers listed in the file map.
- Modify: apps/web/components/landing-seo.tsx
- Modify: apps/web/components/related-comparisons.tsx
- Modify: apps/web/app/sitemap.ts
- Modify: apps/web/src/__tests__/landing-cta.test.ts

- [ ] Step 1: Extend the homepage CTA test before changing the homepage.

Add this assertion to apps/web/src/__tests__/landing-cta.test.ts:

    it("exposes all approved product-intent pages to crawlers", () => {
      for (const href of [
        "/ai-video-clipper",
        "/podcast-to-shorts",
        "/twitch-clip-maker",
        "/youtube-to-shorts",
        "/telegram-video-clipper",
      ]) {
        expect(readFileSync(resolve(process.cwd(), "apps/web/components/landing-seo.tsx"), "utf8")).toContain(href);
      }
    });

- [ ] Step 2: Run the homepage test and confirm RED.

    npx vitest run apps/web/src/__tests__/landing-cta.test.ts

Expected result: the new test fails because the homepage source does not yet contain all five paths.

- [ ] Step 3: Add explicit route wrappers.

Each route must stay explicit and small:

    import type { Metadata } from "next";
    import { SeoLandingPage } from "@/components/seo-landing-page";
    import { createSeoMetadata } from "@/lib/seo-metadata";
    import { PRODUCT_SEO_PAGES } from "@/lib/seo-landing-pages";

    const page = PRODUCT_SEO_PAGES.find((candidate) => candidate.slug === "ai-video-clipper")!;

    export const metadata: Metadata = createSeoMetadata(page);

    export default function AiVideoClipperPage() {
      return <SeoLandingPage page={page} />;
    }

Use the correct slug and component name in each route. The non-null assertion is safe because Task 1's contract test owns the five-record invariant; no dynamic route is introduced.

- [ ] Step 4: Add the five homepage links.

In LandingSeo, add one crawlable “Use-case pages” section using PRODUCT_SEO_PAGES, showing each route-specific title summary and linking with next/link. Keep the current comparison section and primary /login CTA. Do not convert app/page.tsx from its existing client component.

- [ ] Step 5: Add curated cross-links.

Export a RelatedProductPages component that resolves relatedSlugs from the data module and skips the current page. Add a small route-to-product map inside related-comparisons.tsx so existing comparison pages expose only contextually relevant product links when they already render RelatedComparisons. The Telegram guide must resolve to the new Telegram product page. Avoid rendering every product page under every comparison.

- [ ] Step 6: Extend sitemap from the same data.

Import PRODUCT_SEO_PAGES into sitemap.ts and append entries using each page path and lastModified date, with monthly change frequency and priority 0.8. Keep the existing homepage/comparison entries and omit /crayo-ai-alternative, /login, assets, dashboard, and API routes.

- [ ] Step 7: Run the focused tests and inspect generated route sources.

    npx vitest run apps/web/src/__tests__/landing-cta.test.ts apps/web/src/__tests__/seo-landing-pages.test.ts
    npx tsc --noEmit -p apps/web/tsconfig.json

Expected result: all focused tests pass, all five route wrappers type-check, and no route imports a client-only component.

- [ ] Step 8: Commit the routes and link graph.

    git add apps/web/app/ai-video-clipper apps/web/app/podcast-to-shorts apps/web/app/twitch-clip-maker apps/web/app/youtube-to-shorts apps/web/app/telegram-video-clipper apps/web/components/landing-seo.tsx apps/web/components/related-comparisons.tsx apps/web/app/sitemap.ts apps/web/src/__tests__/landing-cta.test.ts
    git commit -m "feat(web): publish US SEO product routes"

## Task 4: Apply the P0 redirect, snippets, and Telegram guide changes

**Files:**

- Modify: apps/web/next.config.ts
- Modify: apps/web/app/layout.tsx
- Modify: apps/web/app/telegram-video-clipper-bots/page.tsx
- Modify: apps/web/app/ai-clipping-tools-compared/page.tsx
- Modify: apps/web/app/opus-clip-alternative/page.tsx
- Modify: apps/web/app/submagic-alternative/page.tsx
- Modify: apps/web/app/eklipse-alternative/page.tsx
- Modify: apps/web/app/klap-alternative/page.tsx
- Modify: apps/web/app/crayo-alternative/page.tsx
- Create: apps/web/src/__tests__/seo-public-surface.test.ts

- [ ] Step 1: Write source-level regression tests for P0 behavior.

Create seo-public-surface.test.ts:

    import { readFileSync } from "node:fs";
    import { resolve } from "node:path";
    import { describe, expect, it } from "vitest";

    const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

    describe("public SEO surface", () => {
      it("redirects the legacy Crayo URL to the canonical comparison", () => {
        const source = read("apps/web/next.config.ts");
        expect(source).toContain('source: "/crayo-ai-alternative"');
        expect(source).toContain('destination: "/crayo-alternative"');
        expect(source).toContain("permanent: true");
      });

      it("keeps the sitemap free of the redirect URL", () => {
        expect(read("apps/web/app/sitemap.ts")).not.toContain("crayo-ai-alternative");
      });

      it("keeps new Telegram product copy distinct from the comparison guide", () => {
        expect(read("apps/web/app/telegram-video-clipper-bots/page.tsx")).toContain(
          "/telegram-video-clipper",
        );
        expect(read("apps/web/lib/seo-landing-pages.ts")).toContain(
          "telegram-video-clipper-bots",
        );
      });
    });

- [ ] Step 2: Run the P0 tests and confirm the expected RED failures.

    npx vitest run apps/web/src/__tests__/seo-public-surface.test.ts

Expected result: redirect/link assertions fail before the corresponding changes are made.

- [ ] Step 3: Add the permanent redirect.

Implement async redirects in next.config.ts returning one source/destination/permanent entry. Do not add a catch-all redirect or IP-based US redirect.

- [ ] Step 4: Shorten the root, guide, hub, and comparison descriptions.

Keep each description factual and under 165 characters where possible. Preserve the page's actual differentiator; do not stuff every keyword into the description. Keep Open Graph descriptions aligned with the visible metadata. Use values derived from FREE_MINUTES and ENTRY in the root layout rather than duplicating numbers.

- [ ] Step 5: Strengthen the Telegram guide without duplicating it.

Keep the dated comparison sources and limitations. Add one early contextual link to /telegram-video-clipper, retain the bot CTA, and make the opening paragraph explicitly answer how to get a long video into Telegram and what comes back.

- [ ] Step 6: Run P0 tests and TypeScript.

    npx vitest run apps/web/src/__tests__/seo-public-surface.test.ts apps/web/src/__tests__/seo-landing-pages.test.ts
    npx tsc --noEmit -p apps/web/tsconfig.json

Expected result: all P0 assertions pass and TypeScript exits 0.

- [ ] Step 7: Commit the P0 fixes.

    git add apps/web/next.config.ts apps/web/app/layout.tsx apps/web/app/telegram-video-clipper-bots/page.tsx apps/web/app/ai-clipping-tools-compared/page.tsx apps/web/app/opus-clip-alternative/page.tsx apps/web/app/submagic-alternative/page.tsx apps/web/app/eklipse-alternative/page.tsx apps/web/app/klap-alternative/page.tsx apps/web/app/crayo-alternative/page.tsx apps/web/src/__tests__/seo-public-surface.test.ts
    git commit -m "fix(web): tighten SEO redirects and snippets"

## Task 5: Full verification, review, merge, and production deployment

**Files:** No new implementation files; use the complete feature diff and deployment environment.

- [ ] Step 1: Run the full verification suite under supported Node.

    npm test
    npx vitest run apps/web/src
    npx tsc --noEmit -p apps/web/tsconfig.json
    npm run build --workspace @clipclap/web
    git diff --check HEAD~4..HEAD

Expected result: test suites report zero failures, TypeScript exits 0, the Next build exits 0, and git diff --check is silent. If Node 18 cannot run these commands, run them in a Node 20+ container and retain the output as the verification evidence.

- [ ] Step 2: Run a local HTTP smoke test.

Start the web app in the supported environment and check:

    for path in / /ai-video-clipper /podcast-to-shorts /twitch-clip-maker /youtube-to-shorts /telegram-video-clipper /telegram-video-clipper-bots /sitemap.xml /robots.txt; do
      curl --fail --silent --show-error --location --head "http://127.0.0.1:3000$path"
    done
    curl --silent --show-error --head --max-redirs 0 http://127.0.0.1:3000/crayo-ai-alternative

Expected result: new/public routes return 200; sitemap and robots return 200; the legacy URL returns a permanent redirect with location /crayo-alternative.

- [ ] Step 3: Verify rendered SEO fields, not only status codes.

Fetch each new page HTML and assert the response contains one page-specific title, the page description, one H1, its self-canonical, BreadcrumbList, and no FAQPage string. Verify sitemap contains all five new URLs and not the redirect URL.

- [ ] Step 4: Request focused code review before merge.

Review the feature diff against the approved spec and this plan. Check factual claims against plans.ts, confirm no user-owned files were modified, confirm no client-only import entered the new server routes, and fix every critical/important finding before deployment.

- [ ] Step 5: Merge the verified feature branch into the production working branch.

From /srv/dev/clipclap.io, confirm the only worktree changes are the two pre-existing user-owned untracked files, then fast-forward:

    git merge --ff-only feature/seo-us-growth

Do not stage or remove the user-owned untracked files.

- [ ] Step 6: Rebuild only the web service using the documented production convention.

From /srv/dev/clipclap.io:

    docker compose up -d --build web

Do not use TARGET=production, docker compose restart web, or a worker-only production compose file for this web change.

- [ ] Step 7: Verify production before reporting completion.

Run:

    docker compose ps web
    curl --fail --silent --show-error --location https://clipclap.io/ai-video-clipper | rg -n "<title>|<h1|canonical|BreadcrumbList"
    curl --fail --silent --show-error --location https://clipclap.io/sitemap.xml | rg -n "ai-video-clipper|podcast-to-shorts|twitch-clip-maker|youtube-to-shorts|telegram-video-clipper"
    curl --silent --show-error --head --max-redirs 0 https://clipclap.io/crayo-ai-alternative

Expected result: the web container is running, the production page contains its expected SEO fields, sitemap lists all five new routes, and the legacy URL responds with a permanent redirect. If any production check fails, stop and report the exact failure instead of claiming deployment success.

- [ ] Step 8: Record the deployed commit and production evidence.

Record the merged commit SHA, container status, HTTP status/headers, and any remaining environment limitation in the handoff. The follow-up Search Console action is to request indexing for the five new URLs and the strengthened Telegram guide once, then monitor the 28-day metrics from the approved design.
