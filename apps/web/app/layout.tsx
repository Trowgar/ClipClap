import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { IconProvider } from "@/components/icon-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipClap - AI Video Clipper",
  description: "Turn long videos into viral short clips with AI",
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
        <IconProvider>{children}</IconProvider>
      </body>
    </html>
  );
}
