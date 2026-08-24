import type { Metadata } from "next";
import Link from "next/link";

/**
 * A comparison page that names a competitor, written to two rules that are not negotiable:
 *
 * 1. Every number about someone else was read on their own pricing page on the date stated. If
 *    they do not publish a figure - Opus Clip does not publish minutes - this page says so
 *    instead of repeating a number from a blog. An unverified competitor price is worse than no
 *    page at all.
 * 2. It states where ClipClap loses. Every page that ranks for this query today is one-sided
 *    about its own product, which is exactly why none of them is worth citing.
 *
 * Trademark: the competitor is named in plain text only, no logo, no implied endorsement -
 * nominative use to identify the product being compared.
 */

const CHECKED = "20 August 2026";
const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
const BOT = "https://t.me/clipclapio_bot";

export const metadata: Metadata = {
  title: "Opus Clip alternative: an honest comparison with ClipClap",
  description:
    "A side-by-side comparison of ClipClap and Opus Clip, checked on their own pricing pages. ClipClap starts at $3 a week for 75 source minutes with 15 minutes free; Opus Clip's Starter is $15 a month and its free plan watermarks clips. Includes what ClipClap does worse.",
  alternates: { canonical: "/opus-clip-alternative" },
  openGraph: {
    type: "article",
    url: `${SITE}/opus-clip-alternative`,
    title: "Opus Clip alternative: an honest comparison with ClipClap",
    description:
      "Prices read on both vendors' own pages, a table, and a plain list of what ClipClap does worse.",
  },
};

const faq = [
  {
    q: "Is ClipClap a free Opus Clip alternative?",
    a: "ClipClap gives 15 minutes of source video free, once per account, with no card required and no watermark on the clips. It is not free forever - after that allowance a plan starts at $3 a week for 75 source minutes. Opus Clip has a free plan that renews, but its free exports carry a watermark and expire after three days.",
  },
  {
    q: "What does ClipClap cost compared with Opus Clip?",
    a: "ClipClap: $3 a week for 75 source minutes, $9 a month for 270, $29 a month for 1000, $89 a month for 3500. Opus Clip: Starter $15 a month, Pro $29 a month, Business by quote, all read on opus.pro/pricing on 20 August 2026. A per-minute comparison is not possible from public information, because Opus Clip does not publish how many minutes a plan includes.",
  },
  {
    q: "What can I clip from?",
    a: "Paste a YouTube, Twitch or TikTok link, or upload a video file directly. Sources up to three hours and files up to 2 GB. YouTube links go through a proxy and occasionally fail - uploading the file or using a Twitch or TikTok link is the reliable path.",
  },
  {
    q: "Does ClipClap work in Telegram?",
    a: "Yes. The whole product runs inside @clipclapio_bot - send a link or a file in the chat and the clips come back in the same chat. There is also a browser version. The bot interface exists in English, Russian, Ukrainian, Spanish, Portuguese, Indonesian and Arabic.",
  },
  {
    q: "What does ClipClap not do?",
    a: "There is no public API, no post scheduling, no dubbing or voice cloning, and no team seats. Clips are kept 7 days on the free and Starter plans, 30 on Plus and 90 on Max. ClipClap is also a young product with no public review footprint, which is a fair reason to try the free allowance before paying anything.",
  },
];

export default function OpusClipAlternativePage() {
  return (
    <div className="min-h-screen bg-black text-neutral-200">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faq.map((f) => ({
              "@type": "Question",
              name: f.q,
              acceptedAnswer: { "@type": "Answer", text: f.a },
            })),
          }),
        }}
      />

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
          Opus Clip alternative: an honest comparison with ClipClap
        </h1>
        <p className="mt-3 text-sm text-neutral-500">
          Prices below were read on each vendor&apos;s own pricing page on {CHECKED}.
          Where a vendor does not publish a number, this page says so rather than
          repeating one from somewhere else.
        </p>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">The short version</h2>
          <p>
            ClipClap and Opus Clip do the same core job: you give them a long video and
            they return short vertical clips with subtitles burned in. The differences
            that matter are what you pay, how the free tier behaves, and where the
            product lives.
          </p>
          <p>
            <strong className="text-white">ClipClap costs $3 a week for 75 minutes of source video</strong>, or
            $9 a month for 270 minutes, $29 a month for 1000, and $89 a month for 3500.
            Before paying anything you get{" "}
            <strong className="text-white">15 minutes of source video free, once, with no card and no watermark</strong>.
            The whole product also runs inside a Telegram bot, which is unusual in this
            category.
          </p>
          <p>
            <strong className="text-white">Opus Clip&apos;s paid plans start at $15 a month</strong> for
            Starter and $29 a month for Pro, with a Business tier by quote that adds an
            API. Its free plan renews rather than running out once, but free exports
            carry a watermark and expire after three days. Opus Clip does not publish how
            many minutes or clips a plan includes on its pricing page, so an honest
            per-minute comparison between the two is not possible from public
            information.
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
                  <th className="py-2 font-medium">Opus Clip</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {[
                  [
                    "Entry price",
                    "$3 a week for 75 source minutes",
                    "$15 a month (Starter)",
                  ],
                  [
                    "Free tier",
                    "60 source minutes, once, no card, no watermark",
                    "Renewing free plan, clips watermarked, 3-day export limit",
                  ],
                  [
                    "Largest plan",
                    "$89 a month for 3500 source minutes",
                    "Business, price by quote",
                  ],
                  [
                    "Unit you buy",
                    "Minutes of source video",
                    "Not published on the pricing page",
                  ],
                  [
                    "Where it runs",
                    "Telegram bot and browser",
                    "Browser",
                  ],
                  [
                    "Inputs",
                    "YouTube, Twitch, TikTok links or a file up to 2 GB, source up to 3 hours",
                    "YouTube links and local upload, 10 GB per video",
                  ],
                  ["API", "No", "Business tier"],
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
            If you need an API, scheduled posting, dubbing or voice cloning, or seats for
            a team, ClipClap does not have them and Opus Clip does. If you want a free
            tier that refills every month rather than a one-time allowance, Opus Clip and
            Vizard both do that and ClipClap does not.
          </p>
          <p>
            ClipClap is also young. It has no public review footprint to check, which is
            a real reason to spend the free 15 minutes on your own footage before paying
            for anything. And YouTube links are the one input that sometimes fails,
            because they are fetched through a proxy - uploading the file directly, or
            using a Twitch or TikTok link, avoids it entirely.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            Where ClipClap is the better choice
          </h2>
          <p>
            The weekly plan is the clearest difference. Clippers who are paid per view are
            paid weekly, and a $3 weekly plan matches that rhythm in a way a $15 monthly
            subscription does not. If a campaign ends, you stop after a week rather than
            carrying a month you will not use.
          </p>
          <p>
            The second is the Telegram bot. Sending a link in a chat and getting the clips
            back in the same chat removes the browser entirely, and the bot speaks English,
            Russian, Ukrainian, Spanish, Portuguese, Indonesian and Arabic.
          </p>
          <p>
            The third is that the free 15 minutes produce clips with no watermark, so what
            you get during the trial is what you would actually post.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-white">Questions</h2>
          <dl className="mt-4 space-y-6">
            {faq.map((f) => (
              <div key={f.q}>
                <dt className="font-medium text-white">{f.q}</dt>
                <dd className="mt-1.5 text-[15px] leading-relaxed text-neutral-300">
                  {f.a}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-12 rounded-xl border border-white/10 p-6">
          <p className="text-[15px] text-neutral-300">
            Try it on your own footage before deciding - 15 minutes of source video, no
            card, no watermark.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <a
              href={BOT}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl bg-[#2AABEE] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#229ED9]"
            >
              Start free in Telegram
            </a>
            <Link
              href="/login"
              className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
            >
              or use the web app
            </Link>
          </div>
        </section>

        <p className="mt-10 text-xs leading-relaxed text-neutral-600">
          Opus Clip is a product of its respective owner and is named here only to
          identify the product being compared. Figures for both products were read on
          their public pricing pages on {CHECKED} and may have changed since.
        </p>
      </main>
    </div>
  );
}
