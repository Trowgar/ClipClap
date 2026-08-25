import type { Metadata } from "next";
import Link from "next/link";
import { RelatedComparisons } from "@/components/related-comparisons";

/**
 * Second comparison page, written to the same two rules as /opus-clip-alternative:
 *
 * 1. Every number about someone else was read on their own pricing page on the date stated.
 * 2. It states where ClipClap loses - and against Submagic it loses on more than it wins,
 *    which is said plainly rather than buried.
 *
 * NO FAQPage JSON-LD here, unlike the Opus page. Google retired FAQ rich results for every
 * site on 7 May 2026, so the markup earns no SERP feature any more; the questions stay as
 * visible text because that is what they were always worth. The Opus page keeps its block
 * rather than being stripped - removing it gains nothing either.
 *
 * NO AggregateRating either, on any page: ClipClap has no public reviews, and schema that
 * invents a rating is both a lie and a structured-data violation.
 *
 * Trademark: the competitor is named in plain text only, no logo, no implied endorsement -
 * nominative use to identify the product being compared.
 */

const CHECKED = "19 August 2026";
const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
/** Tagged per page, so "did SEO send anybody into the bot" is a number rather than
 *  a guess about signup spikes. The bot records a bot_start_src_<slug> funnel event
 *  for a stranger arriving on this payload; slugs are lowercase [a-z0-9_-], 32 max. */
const BOT = "https://t.me/clipclapio_bot?start=src_cmp_submagic";

export const metadata: Metadata = {
  title: "Submagic alternative: an honest comparison with ClipClap",
  description:
    "Submagic is a captioning tool whose long-to-short clipping is a paid add-on, and its source-length caps run 1:30 to 30 minutes. ClipClap clips sources up to 3 hours from $3 a week. Prices read on both vendors' own pages, plus what ClipClap does worse.",
  alternates: { canonical: "/submagic-alternative" },
  openGraph: {
    type: "article",
    url: `${SITE}/submagic-alternative`,
    title: "Submagic alternative: an honest comparison with ClipClap",
    description:
      "Where the two products actually differ: what clipping costs, how long a source each will take, and what ClipClap does worse.",
  },
};

const faq = [
  {
    q: "Is ClipClap a cheaper Submagic alternative?",
    a: "For clipping long video, yes, and the gap is larger than the headline prices suggest. Submagic's long-to-short feature, Magic Clips, is an add-on rather than part of the base plan: the cheapest plan that includes it is $38 a month, or $24 a month billed annually. ClipClap's clipping is the product itself and starts at $3 a week. For captioning short videos you already have, Submagic's base Starter at $19 a month is a different job and this comparison does not apply.",
  },
  {
    q: "How long a video can each one take?",
    a: "This is the difference that decides it for most people clipping streams or podcasts. Submagic caps source length by tier: 1 minute 30 on the free plan, 2 minutes on Starter, 5 minutes on Pro, and 30 minutes on Business at $69 a month. ClipClap takes sources up to 3 hours on every paid plan and 40 minutes on the free allowance. A two-hour VOD cannot be sent to Submagic on any tier it publishes.",
  },
  {
    q: "What does the free tier give me?",
    a: "Submagic's free plan is 3 videos a month, up to 1 minute 30 each, with a watermark. ClipClap gives 40 minutes of source video once per account, with no card and no watermark on the clips - but it does not renew, so when it is gone it is gone. Both figures were read on the vendors' own pages on 19 August 2026.",
  },
  {
    q: "What does Submagic do that ClipClap does not?",
    a: "A great deal. Captions in 40 or more languages against ClipClap's seven interface languages, auto-zoom, AI eye-contact correction, a brand kit, social publishing on Pro and above, and a documented API with per-minute add-on packs. Submagic is a more complete editing product; ClipClap does one job.",
  },
  {
    q: "Are there complaints worth knowing about?",
    a: "Both products are worth checking rather than trusted. Submagic's Trustpilot page carries recurring reports of no refunds, renewals without notice, and support being hard to reach. ClipClap has no public review footprint at all, which is not the same as a good one - it is a reason to spend the free allowance on your own footage before paying anything.",
  },
];

export default function SubmagicAlternativePage() {
  return (
    <div className="min-h-screen bg-black text-neutral-200">
      <header className="border-b border-white/[0.06] px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
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

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Submagic alternative: an honest comparison with ClipClap
        </h1>
        <p className="mt-3 text-sm text-neutral-500">
          Prices and limits below were read on each vendor&apos;s own pricing page on{" "}
          {CHECKED}. Where a vendor does not publish a number, this page says so rather
          than repeating one from somewhere else.
        </p>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">The short version</h2>
          <p>
            These two products are usually compared as if they did the same job. They do
            not. Submagic is a captioning and editing tool, and cutting a long video into
            short ones - the feature it calls Magic Clips -{" "}
            <strong className="text-white">is a paid add-on rather than part of a base plan</strong>.
            ClipClap does nothing except turn a long video into short vertical clips with
            subtitles burned in.
          </p>
          <p>
            That changes what the prices mean. Submagic&apos;s Starter is $19 a month, or
            $12 billed annually, and it{" "}
            <strong className="text-white">does not include Magic Clips</strong>. The
            cheapest plan that does is $38 a month, or $24 a month annually. Pro is $39,
            Pro with Magic Clips $58, and Business with an API $69, all monthly.
          </p>
          <p>
            <strong className="text-white">ClipClap costs $3 a week for 75 minutes of source video</strong>, or
            $9 a month for 270 minutes, $29 a month for 1000, and $89 a month for 3500.
            Before paying anything you get{" "}
            <strong className="text-white">40 minutes of source video free, once, with no card and no watermark</strong>.
            It also runs inside a Telegram bot, which nothing else in this comparison
            does.
          </p>
          <p>
            The limit that decides it for most people is not price at all. Submagic caps
            how long a source video may be, and the cap is tied to the tier: 1 minute 30
            free, 2 minutes on Starter, 5 minutes on Pro, and 30 minutes on Business at
            $69 a month.{" "}
            <strong className="text-white">
              A two-hour stream or podcast cannot be sent to Submagic on any tier it
              publishes.
            </strong>{" "}
            ClipClap takes sources up to three hours on every paid plan.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-white">Side by side</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-neutral-400">
                  <th className="py-2 pr-4 font-medium">&nbsp;</th>
                  <th className="py-2 pr-4 font-medium text-white">ClipClap</th>
                  <th className="py-2 font-medium">Submagic</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {[
                  [
                    "Cheapest plan that clips long video",
                    "$3 a week for 75 source minutes",
                    "$38 a month, or $24 a month annually (Starter plus Magic Clips)",
                  ],
                  [
                    "Longest source accepted",
                    "3 hours on every paid plan",
                    "30 minutes, and only on Business at $69 a month",
                  ],
                  [
                    "Free tier",
                    "40 source minutes, once, no card, no watermark",
                    "3 videos a month, 1:30 each, watermarked",
                  ],
                  [
                    "Unit you buy",
                    "Minutes of source video",
                    "Number of videos a month, plus a per-tier length cap",
                  ],
                  [
                    "Caption languages",
                    "7 interface languages",
                    "40 or more",
                  ],
                  [
                    "Where it runs",
                    "Telegram bot and browser",
                    "Browser",
                  ],
                  [
                    "Publishing and scheduling",
                    "No",
                    "Yes, on Pro and above",
                  ],
                  ["API", "No", "Business tier, plus $0.10-0.15 per minute packs"],
                ].map(([label, ours, theirs]) => (
                  <tr key={label} className="border-b border-white/[0.06]">
                    <td className="py-3 pr-4 text-neutral-500">{label}</td>
                    <td className="py-3 pr-4 text-white">{ours}</td>
                    <td className="py-3">{theirs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            Where ClipClap is the worse choice
          </h2>
          <p>
            Against Submagic, ClipClap loses on more than it wins, and the honest summary
            is that they are built for different people. Submagic captions in 40 or more
            languages; ClipClap&apos;s interface exists in seven and its subtitles follow
            what the transcription returns. Submagic has auto-zoom, AI eye-contact
            correction, a brand kit so every clip carries your fonts and colours, social
            publishing from inside the tool, and a documented API. ClipClap has none of
            those.
          </p>
          <p>
            If what you actually want is captions on short videos you have already cut,
            Submagic&apos;s $19 Starter does that and ClipClap is the wrong tool - it has
            no editor, and it will not take a 90-second video and hand it back prettier.
          </p>
          <p>
            ClipClap is also young, with no public review footprint to check. That is a
            fair reason to spend the free 40 minutes on your own footage before paying
            anything. And YouTube links are the one input that sometimes fails, because
            they are fetched through a proxy - uploading the file directly, or using a
            Twitch or TikTok link, is the reliable path.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            What people report about each
          </h2>
          <p>
            Submagic&apos;s Trustpilot page carries recurring themes worth reading before
            you subscribe: no refunds on unused time, renewals arriving without notice or
            a grace period, stretches where the site is unavailable, and support being
            hard to reach. Its free tier also still watermarks output, so &quot;try for
            free&quot; and &quot;try without a watermark&quot; are not the same thing
            there.
          </p>
          <p>
            ClipClap has no reviews at all. That is not the same as good reviews, and it
            should be read as the missing evidence it is. The free allowance exists so
            that the evidence you act on is your own footage rather than anybody&apos;s
            marketing.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-white">Questions</h2>
          <div className="mt-4 space-y-6">
            {faq.map((f) => (
              <div key={f.q}>
                <h3 className="text-[15px] font-medium text-white">{f.q}</h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-neutral-400">
                  {f.a}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12 rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <h2 className="text-lg font-semibold text-white">
            Try it on your own footage
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-neutral-300">
            40 minutes of source video, no card, no watermark. Send a link or a file to
            the bot and the clips come back in the same chat.
          </p>
          <a
            href={BOT}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-neutral-200"
          >
            Open the bot
          </a>
          <p className="mt-3 text-xs text-neutral-500">
            No Telegram?{" "}
            <Link
              href="/login"
              className="text-neutral-400 underline underline-offset-4 transition-colors hover:text-white"
            >
              Use it in your browser
            </Link>{" "}
            - same clips, same free allowance.
          </p>
        </section>

        <RelatedComparisons current="submagic-alternative" />
      </main>
    </div>
  );
}
