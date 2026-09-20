import type { Metadata } from "next";
import type { SeoLandingPage } from "./seo-landing-pages";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";

export function createSeoMetadata(page: SeoLandingPage): Metadata {
  const url = new URL(page.path, SITE).toString();

  return {
    metadataBase: new URL(SITE),
    title: page.title,
    description: page.description,
    alternates: { canonical: page.path },
    openGraph: {
      type: "website",
      url,
      siteName: "ClipClap",
      title: page.title,
      description: page.description,
    },
    twitter: {
      card: "summary",
      title: page.title,
      description: page.description,
    },
  };
}
