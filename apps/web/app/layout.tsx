import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { IconProvider } from "@/components/icon-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipClap - AI Video Clipper",
  description: "Turn long videos into viral short clips with AI",
  icons: {
    icon: "/favicon.svg",
  },
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
