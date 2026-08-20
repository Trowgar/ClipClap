import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";

/**
 * There was no robots.txt at all until 2026-08-20 - the path 404'd, which leaves crawling to
 * each crawler's default. Nothing here restricts an AI or search crawler on purpose: answer
 * engines are the one acquisition channel already sending real traffic, so the public marketing
 * surface stays open and only the signed-in areas and the API are kept out of an index where
 * they would be useless anyway.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/admin", "/dashboard"],
      },
    ],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
