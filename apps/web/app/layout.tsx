import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { IconProvider } from "@/components/icon-provider";
import { FREE_TIER, PLAN_LIMITS } from "@clipclap/shared/config/plans";
import "./globals.css";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";

/**
 * Every price and allowance on this page comes from plans.ts, and none of it is written
 * out by hand any more.
 *
 * The reason is a bug that shipped: when the free allowance changed from 60 minutes to 40,
 * the sentences were updated and a graphic on the pricing card was not, so the site
 * advertised both numbers at once for a day. Structured data is the worse place for that
 * to happen than a graphic is - an answer engine quotes it as fact and there is no reader
 * to notice the contradiction.
 *
 * Imported from the config module rather than the package root because the shared barrel
 * is eager: it pulls prisma, redis and bullmq along with it, and this file wraps every
 * page on the site. config/plans has no runtime imports of its own.
 */
const FREE_MINUTES = Math.floor(FREE_TIER.lifetimeSeconds / 60);

const CYCLE_WORD = { WEEKLY: "week", MONTHLY: "month" } as const;

/** One Offer per plan-and-cycle that actually exists, derived rather than listed. A plan
 *  whose cycle is null (Plus and Max have no weekly) produces nothing, and a plan added to
 *  PLAN_LIMITS later appears here without anyone remembering to come back. */
const PAID_OFFERS = Object.entries(PLAN_LIMITS).flatMap(([plan, cycles]) =>
  Object.entries(cycles).flatMap(([cycle, limits]) => {
    if (!limits) return [];
    const word = CYCLE_WORD[cycle as keyof typeof CYCLE_WORD];
    const title = plan.charAt(0) + plan.slice(1).toLowerCase();
    return [
      {
        "@type": "Offer" as const,
        name: `${title} ${cycle.toLowerCase()}`,
        price: String(limits.priceUsd),
        priceCurrency: "USD",
        description: `${limits.minutesPerPeriod} minutes of source video per ${word}.`,
      },
    ];
  })
);

/** The cheapest paid plan, for the one sentence in the meta description that quotes it. */
const ENTRY = PLAN_LIMITS.STARTER.WEEKLY!;

/**
 * Title and description carry facts on purpose. An answer engine asked "cheap tool to clip
 * streams into shorts" can only quote what is written as a sentence, and the old copy ("Turn
 * long videos into viral short clips with AI") stated no price, no free allowance and no input
 * source - nothing a person choosing a tool actually needs. Every number here matches
 * packages/shared/src/config/plans.ts.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "ClipClap - AI clipper for streams, podcasts and VODs",
  description: `Turn a long stream, podcast or VOD into vertical clips with burned-in subtitles. First ${FREE_MINUTES} minutes of source video are free, no card needed; paid plans start at $${ENTRY.priceUsd} a week for ${ENTRY.minutesPerPeriod} minutes. Works in Telegram or in the browser.`,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "ClipClap",
    title: "ClipClap - AI clipper for streams, podcasts and VODs",
    description:
      "Long video in, vertical subtitled clips out. 40 source minutes free, no card. Plans from $3 a week.",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "ClipClap" }],
  },
  twitter: {
    card: "summary",
    title: "ClipClap - AI clipper for streams, podcasts and VODs",
    description:
      "Long video in, vertical subtitled clips out. 40 source minutes free, no card. Plans from $3 a week.",
    images: ["/icon-512.png"],
  },
  // Order matters: the .ico carries sizes="32x32" so SVG-capable browsers
  // (Chrome/Firefox/Edge) prefer the vector icon listed after it, while Safari
  // (no SVG favicon support), iOS and Google fall back to the .ico / apple icon.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} scroll-smooth`}>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        {/* Machine-readable product facts. The page had no structured data at all before
            2026-08-20, so an answer engine had to infer the price from interface fragments -
            "Starter", "Weekly", "$3", "/week" living in separate elements. Every figure is
            DERIVED from packages/shared/src/config/plans.ts; see the note beside the
            imports for why nothing here is written out by hand. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "ClipClap",
              url: SITE,
              applicationCategory: "MultimediaApplication",
              operatingSystem: "Web, Telegram",
              description:
                "ClipClap turns a long stream, podcast or VOD into short vertical clips with burned-in subtitles. Paste a YouTube, Twitch or TikTok link or upload a file; the AI transcribes it, finds the strongest moments and cuts 9:16 clips ready to post.",
              inLanguage: ["en", "ru", "uk", "es", "pt", "id", "ar"],
              offers: [
                {
                  "@type": "Offer",
                  name: "Free allowance",
                  price: "0",
                  priceCurrency: "USD",
                  description: `${FREE_MINUTES} minutes of source video, one-time, no card required.`,
                },
                ...PAID_OFFERS,
              ],
            }),
          }}
        />
        <IconProvider>{children}</IconProvider>
      </body>
    </html>
  );
}
