import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";

/**
 * The public surface is three pages today, so this sitemap is short by honesty rather than by
 * oversight - /pricing, /faq and /blog do not exist yet and listing them would hand crawlers a
 * set of 404s. Add entries here as real pages ship.
 *
 * `lastModified` is a hand-maintained constant per page, NOT `new Date()`. A sitemap that claims
 * every page changed on every build teaches a crawler that the field carries no information, and
 * it then stops using it to prioritise recrawls. Bump the date in the same commit that changes
 * the page.
 *
 * /login is deliberately absent. It is thin, it cannot rank, it is `noindex`, and in a
 * three-URL sitemap it was a third of the file.
 */
const LAST_MODIFIED = {
  home: "2026-08-24",
  opusClipAlternative: "2026-08-24",
  submagicAlternative: "2026-08-24",
} as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE,
      lastModified: new Date(LAST_MODIFIED.home),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE}/opus-clip-alternative`,
      lastModified: new Date(LAST_MODIFIED.opusClipAlternative),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE}/submagic-alternative`,
      lastModified: new Date(LAST_MODIFIED.submagicAlternative),
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
