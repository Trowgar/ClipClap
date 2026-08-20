import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";

/**
 * The public surface is one page today, so this sitemap is short by honesty rather than by
 * oversight - /pricing, /faq and /blog do not exist yet and listing them would hand crawlers a
 * set of 404s. Add entries here as real pages ship.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE}/opus-clip-alternative`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE}/login`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
