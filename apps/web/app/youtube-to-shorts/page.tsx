import type { Metadata } from "next";
import { SeoLandingPage } from "@/components/seo-landing-page";
import { createSeoMetadata } from "@/lib/seo-metadata";
import { PRODUCT_SEO_PAGES } from "@/lib/seo-landing-pages";

const page = PRODUCT_SEO_PAGES.find((candidate) => candidate.slug === "youtube-to-shorts")!;

export const metadata: Metadata = createSeoMetadata(page);

export default function YoutubeToShortsPage() {
  return <SeoLandingPage page={page} />;
}
