import type { Metadata } from "next";
import Link from "next/link";
import { RelatedComparisons } from "@/components/related-comparisons";

/**
 * The hub. Every other page here is a head-to-head; this one is the master table, and it
 * is the only page on the site that carries the whole 2026-08-19 pricing sweep in one
 * place.
 *
 * Its reason to exist is a single observation that no listicle on this query makes: these
 * tools do not sell the same unit. Clips, export minutes, source minutes, credits, videos
 * per month - a "cheapest AI clipper" ranking that puts those in one column is comparing
 * numbers that measure different things. The table below therefore has a UNIT column, and
 * it refuses to compute a per-minute price for any vendor that does not publish enough to
 * derive one.
 *
 * UNKNOWN appears a lot and stays. Nine of these vendors hide something material behind a
 * signup, a slider, a 403 or annual-only billing, and a page that filled those in from a
 * secondary blog would be repeating numbers rather than reporting them - which is the
 * failure mode of every page currently ranking for this.
 *
 * No FAQPage JSON-LD (retired 7 May 2026). No AggregateRating anywhere. ItemList is also
 * NOT used: Google's list carousels do not cover software, so it would be markup added on
 * the theory that something might read it, and every other schema decision on this site
 * was made against exactly that reasoning.
 *
 * Trademark: competitors named in plain text only, nominative use to identify the products
 * being compared.
 */

const CHECKED = "19 August 2026";
const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
const BOT = "https://t.me/clipclapio_bot";

export const metadata: Metadata = {
  title: "AI clipping tools compared: prices, units and free tiers (2026)",
  description:
    "Eighteen tools that cut long video into shorts, with prices read on their own pages on 19 August 2026 - and the column nobody else publishes: what each one actually bills you for. Clips, export minutes, source minutes and credits are not the same unit.",
  alternates: { canonical: "/ai-clipping-tools-compared" },
  openGraph: {
    type: "article",
    url: `${SITE}/ai-clipping-tools-compared`,
    title: "AI clipping tools compared: prices, units and free tiers (2026)",
    description:
      "The prices, the free tiers, and what each vendor actually charges you for - with UNKNOWN left in wherever a vendor does not publish it.",
  },
};

/** Every row read on the vendor's own page on the date above, unless the note says
 *  otherwise. UNKNOWN is a finding, not a gap to be filled in later. */
const TOOLS = [
  {
    name: "ClipClap",
    price: "$3/week or $9/month",
    unit: "Source minutes",
    free: "40 source minutes, once, no watermark",
    note: "Ours. Telegram bot and browser; weekly billing.",
  },
  {
    name: "Clipbot",
    price: "$9/month",
    unit: "Not published",
    free: "7-day trial",
    note: "No watermark on any tier. Aimed at Twitch.",
  },
  {
    name: "Klap",
    price: "$14/month, annual billing shown",
    unit: "Clips per month (100)",
    free: "None listed",
    note: "Monthly price not shown. Talking-head focus.",
  },
  {
    name: "Opus Clip",
    price: "$15/month",
    unit: "Not published",
    free: "Renewing, watermarked, 3-day expiry",
    note: "Minutes per plan not on the pricing page.",
  },
  {
    name: "Ssemble",
    price: "$15/month",
    unit: "Credits (1 = up to 20 source min)",
    free: "None",
    note: "Annual drops to $6/month.",
  },
  {
    name: "Descript",
    price: "$16/month annual, $24 monthly",
    unit: "Media minutes and AI credits",
    free: "60 media minutes/month",
    note: "Full clip creation is on the $24 annual tier.",
  },
  {
    name: "Crayo",
    price: "$19/month",
    unit: "Export minutes (40)",
    free: "None",
    note: "All sales final. Also makes faceless content.",
  },
  {
    name: "SendShort",
    price: "$19/month",
    unit: "Shorts per month (20)",
    free: "3 videos",
    note: "Per-tier source length caps of 1:30 to 10 min.",
  },
  {
    name: "Submagic",
    price: "$19/month, but $38 to clip",
    unit: "Videos per month, plus a length cap",
    free: "3 videos/month, 1:30, watermarked",
    note: "Long-to-short is a paid add-on, not a base feature.",
  },
  {
    name: "Wisecut",
    price: "$23.25/month annual",
    unit: "Credits (300)",
    free: "60 credits/month, 360p",
    note: "Monthly price not shown.",
  },
  {
    name: "Captions",
    price: "$24.99/month",
    unit: "Credits (500)",
    free: "Basic trims only",
    note: "Credit cost of clipping not published.",
  },
  {
    name: "Eklipse",
    price: "$24.99/month, ~$12.50 annual",
    unit: "Highlights per stream",
    free: "15 highlights/stream, 720p, watermarked",
    note: "Pricing page returned 403; figures from its own blog.",
  },
  {
    name: "Spikes Studio",
    price: "$32.99/month, $14.09 annual",
    unit: "Source minutes",
    free: "About 30 minutes",
    note: "Web editor capped at 5-minute sources.",
  },
  {
    name: "Munch",
    price: "$38/month",
    unit: "Minutes of repurposing (500)",
    free: "7-day trial only",
    note: "Highest floor here. Aimed at brands and agencies.",
  },
  {
    name: "StreamLadder",
    price: "About $8.28/month",
    unit: "Not published",
    free: "Yes, capped at 720p",
    note: "Price from a third-party review; own page is JS-only.",
  },
  {
    name: "Vizard",
    price: "Not published",
    unit: "Not published",
    free: "60 minutes",
    note: "Pricing behind a slider we could not read.",
  },
  {
    name: "Clipline",
    price: "About $3, $9, $22.50",
    unit: "Each clip delivered, refunded if rejected",
    free: "5 minutes and 2 clips",
    note: "Telegram bot only. Figures from a Product Hunt listing.",
  },
  {
    name: "Vyexa",
    price: "Not published",
    unit: "Credits and clips",
    free: "20 clips on signup",
    note: "Its Telegram bot cuts manually; AI is on the website.",
  },
] as const;

export default function AiClippingToolsComparedPage() {
  return (
    <div className="min-h-screen bg-black text-neutral-200">
      <header className="border-b border-white/[0.06] px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <Link href="/" className="text-sm font-medium text-white">
            ClipClap
          </Link>
          <a
            href={BOT}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-white px-3.5 py-1.5 text-sm font-medium text-black transition-colors hover:bg-neutral-200"
          >
            Start free
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          AI clipping tools compared: prices, units and free tiers
        </h1>
        <p className="mt-3 text-sm text-neutral-500">
          Eighteen tools, every figure read on the vendor&apos;s own page on {CHECKED}
          unless the row says otherwise. ClipClap is our own product, and this page is
          ordered by price rather than by preference. Where a vendor does not publish
          something, the cell says so.
        </p>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            Read the unit column before the price column
          </h2>
          <p>
            Every &quot;cheapest AI clipper&quot; ranking you will find puts these prices
            in one column and sorts it. That comparison is broken, and the reason is in the
            third column below:{" "}
            <strong className="text-white">these tools do not sell the same thing</strong>.
          </p>
          <p>
            Some sell <strong className="text-white">source minutes</strong> - what you put
            in. Some sell <strong className="text-white">export minutes</strong> - what
            comes out, which for a typical stream is a tenth as much. Some sell{" "}
            <strong className="text-white">clips</strong>, some sell{" "}
            <strong className="text-white">videos per month</strong>, and several sell{" "}
            <strong className="text-white">credits</strong> without publishing what a credit
            buys. A $19 plan measured in export minutes and a $19 plan measured in source
            minutes are not competing offers; they are different products at a coincidental
            price.
          </p>
          <p>
            So this table does not compute a per-minute price for anybody, including us.
            Where a vendor publishes enough to work one out, you can; where it does not,
            nobody honest can, and the pages that print one anyway have invented a
            conversion.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-white">
            The table, cheapest entry plan first
          </h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-neutral-400">
                  <th className="py-2 pr-4 font-medium">Tool</th>
                  <th className="py-2 pr-4 font-medium">Entry price</th>
                  <th className="py-2 pr-4 font-medium">What it bills</th>
                  <th className="py-2 pr-4 font-medium">Free tier</th>
                  <th className="py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {TOOLS.map((t) => (
                  <tr key={t.name} className="border-b border-white/[0.06] align-top">
                    <td
                      className={`py-3 pr-4 ${
                        t.name === "ClipClap" ? "font-medium text-white" : ""
                      }`}
                    >
                      {t.name}
                    </td>
                    <td className="py-3 pr-4">{t.price}</td>
                    <td className="py-3 pr-4 text-neutral-400">{t.unit}</td>
                    <td className="py-3 pr-4 text-neutral-400">{t.free}</td>
                    <td className="py-3 text-neutral-500">{t.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-neutral-600">
            &quot;Not published&quot; means the figure was not on a page we could read -
            behind a signup, a slider, JavaScript, annual-only billing or an error. It is
            not a claim that the thing does not exist. Nine of the eighteen hide something
            material this way, which is itself worth knowing before you start a trial.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            Four things the table shows that a price ranking hides
          </h2>
          <p>
            <strong className="text-white">A cheap plan is not always a clipping plan.</strong>{" "}
            Submagic&apos;s $19 tier does not include long-to-short at all - the cheapest
            plan that clips is $38. Descript&apos;s full clip creation sits above its
            advertised entry price too. Read what the tier includes, not what the page
            header says.
          </p>
          <p>
            <strong className="text-white">Source length caps bite before price does.</strong>{" "}
            Several tools cap how long an input video may be, by tier: Submagic runs 1:30 to
            30 minutes, SendShort 1:30 to 10 minutes, Spikes&apos; web editor 5 minutes. If
            you clip two-hour streams, those caps rule the tool out no matter what it costs.
          </p>
          <p>
            <strong className="text-white">A free tier is not a free trial.</strong> Some
            here renew monthly, some are one-time, and several watermark the output - which
            means you can see the tool work but cannot use what it made. Only a handful let
            you leave with a usable clip without paying.
          </p>
          <p>
            <strong className="text-white">Refund policies vary more than prices do.</strong>{" "}
            Several of these publish all-sales-final terms, and complaints about
            renewals and refunds are the most common theme across their review pages. That
            matters more than a few dollars of monthly difference.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">Where we fit, honestly</h2>
          <p>
            ClipClap is the cheapest entry on this table and the only one billed by the
            week, it gives the largest unwatermarked free allowance, and it is one of three
            that work inside Telegram. Those are the reasons to try it.
          </p>
          <p>
            It is also the youngest product here with no public reviews at all, it has no
            API, no scheduling, no team seats and no analytics, and on heavy long-form work
            its source-minute billing is genuinely worse value than an export-minute or
            clip-count plan. If you are choosing between us and a tool with thousands of
            reviews and a decade of features, the free 40 minutes are the argument - not
            this page.
          </p>
        </section>

        <section className="mt-10 space-y-3 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">Head-to-head comparisons</h2>
          <p className="text-neutral-400">
            Longer pages on the five tools people ask about most, each with the same rule:
            what it costs, what it does better than ClipClap, and where ClipClap is the
            worse choice.
          </p>
        </section>

        <RelatedComparisons current="ai-clipping-tools-compared" />

        <section className="mt-12 rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <h2 className="text-lg font-semibold text-white">
            Try the cheapest row on your own footage
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-neutral-300">
            40 minutes of source video, no card, no watermark. Send a link or a file to the
            bot and the clips come back in the same chat.
          </p>
          <a
            href={BOT}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-neutral-200"
          >
            Open the bot
          </a>
        </section>

        <p className="mt-10 text-xs leading-relaxed text-neutral-600">
          All products other than ClipClap are products of their respective owners and are
          named here only to identify the products being compared. Figures were read on{" "}
          {CHECKED} from each vendor&apos;s own public pages, except where a row states
          another source, and may have changed since.
        </p>
      </main>
    </div>
  );
}
