import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { IconProvider } from "@/components/icon-provider";
import "./globals.css";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";

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
  description:
    "Turn a long stream, podcast or VOD into vertical clips with burned-in subtitles. First 40 minutes of source video are free, no card needed; paid plans start at $3 a week for 75 minutes. Works in Telegram or in the browser.",
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
            "Starter", "Weekly", "$3", "/week" living in separate elements. Prices mirror
            packages/shared/src/config/plans.ts and must be changed together with it. */}
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
                  description:
                    "40 minutes of source video, one-time, no card required.",
                },
                {
                  "@type": "Offer",
                  name: "Starter weekly",
                  price: "3",
                  priceCurrency: "USD",
                  description: "75 minutes of source video per week.",
                },
                {
                  "@type": "Offer",
                  name: "Starter monthly",
                  price: "9",
                  priceCurrency: "USD",
                  description: "270 minutes of source video per month.",
                },
                {
                  "@type": "Offer",
                  name: "Plus",
                  price: "29",
                  priceCurrency: "USD",
                  description: "1000 minutes of source video per month.",
                },
                {
                  "@type": "Offer",
                  name: "Max",
                  price: "89",
                  priceCurrency: "USD",
                  description: "3500 minutes of source video per month.",
                },
              ],
            }),
          }}
        />
        <IconProvider>{children}</IconProvider>
      </body>
    </html>
  );
}
