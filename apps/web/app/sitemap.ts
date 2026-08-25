import type { MetadataRoute } from "next";
import { COMPARISON_PAGES } from "@/components/related-comparisons";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";

/**
 * The public surface is the home page plus the comparison pages. /pricing, /faq and /blog
 * do not exist yet and listing them would hand crawlers a set of 404s, so this file is
 * short by honesty rather than by oversight.
 *
 * The comparison entries are DERIVED from COMPARISON_PAGES rather than repeated here. That
 * same list renders the cross-links between the pages, so a new page cannot end up
 * linked-but-unlisted or listed-but-unlinked - which is exactly the drift that had already
 * happened once, when the first two pages shipped with no links between them at all.
 *
 * `lastModified` stays HAND-MAINTAINED per page, and the Record type below is what forces
 * it: adding a slug to COMPARISON_PAGES without a date here is a type error rather than a
 * silent fallback. A sitemap that claims every page changed on every build teaches a
 * crawler that the field carries no information, and it then stops using it to prioritise
 * recrawls. Bump the date in the same commit that changes the page.
 *
 * /login is deliberately absent. It is thin, it cannot rank, and it is noindex.
 */
const HOME_LAST_MODIFIED = "2026-08-24";

const COMPARISON_LAST_MODIFIED: Record<
  (typeof COMPARISON_PAGES)[number]["slug"],
  string
> = {
  "opus-clip-alternative": "2026-08-24",
  "submagic-alternative": "2026-08-24",
  "eklipse-alternative": "2026-08-24",
  "klap-alternative": "2026-08-24",
  "crayo-alternative": "2026-08-24",
  "telegram-video-clipper-bots": "2026-08-25",
  "ai-clipping-tools-compared": "2026-08-25",
};

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE,
      lastModified: new Date(HOME_LAST_MODIFIED),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...COMPARISON_PAGES.map((page) => ({
      url: `${SITE}/${page.slug}`,
      lastModified: new Date(COMPARISON_LAST_MODIFIED[page.slug]),
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
  ];
}
