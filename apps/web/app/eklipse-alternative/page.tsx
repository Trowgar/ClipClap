import type { Metadata } from "next";
import Link from "next/link";
import { RelatedComparisons } from "@/components/related-comparisons";

/**
 * Third comparison page, same two rules as the first two: every number about somebody else
 * was read on a source stated here, on the date stated, and the page says where ClipClap
 * loses.
 *
 * This one carries a data gap the other two do not, and it is stated in the body rather
 * than hidden: eklipse.gg/pricing returned HTTP 403 on two attempts, so the Premium price
 * here comes from Eklipse's own blog and a pricing-change post, and the figures that apply
 * to subscribers who joined after 1 January 2026 could not be read at all. A page that
 * quoted a confident number it could not verify would be exactly the kind of page this one
 * exists to be better than.
 *
 * No FAQPage JSON-LD - Google retired FAQ rich results for every site on 7 May 2026. No
 * AggregateRating - ClipClap has no reviews and inventing one is a lie in machine-readable
 * form.
 *
 * Trademark: the competitor is named in plain text only, no logo, no implied endorsement -
 * nominative use to identify the product being compared.
 */

const CHECKED = "19 August 2026";
const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
const BOT = "https://t.me/clipclapio_bot";

export const metadata: Metadata = {
  title: "Eklipse alternative: an honest comparison with ClipClap",
  description:
    "Eklipse is built for Twitch and gaming, with a free tier that watermarks at 720p and Premium at $24.99 a month. ClipClap starts at $3 a week, keeps webcam and gameplay both visible in the vertical crop, and has no reviews yet. Includes what ClipClap does worse.",
  alternates: { canonical: "/eklipse-alternative" },
  openGraph: {
    type: "article",
    url: `${SITE}/eklipse-alternative`,
    title: "Eklipse alternative: an honest comparison with ClipClap",
    description:
      "What each one costs, what the free tiers really give you, and the one thing ClipClap does that matters for gameplay clips.",
  },
};

const faq = [
  {
    q: "Is ClipClap cheaper than Eklipse?",
    a: "On monthly billing, clearly: ClipClap is $3 a week or $9 a month against Eklipse Premium at $24.99 a month. On annual billing the gap almost closes - Eklipse's annual rate works out at roughly $12.50 a month, about $3.47 a week, which is close to ClipClap's weekly price. The honest summary is that ClipClap is much cheaper if you do not want to commit to a year, and similar if you do.",
  },
  {
    q: "What does each free tier actually give me?",
    a: "Eklipse's free tier gives 15 highlights per stream, 14-day storage, 720p output, and a watermark. ClipClap gives 40 minutes of source video once per account, at full resolution, with no watermark and no card - but it does not refill, so when it is gone it is gone. Eklipse's free tier is the better one if you stream regularly; ClipClap's is the better one if you want to see unwatermarked output before deciding anything.",
  },
  {
    q: "Does ClipClap keep the webcam visible on gameplay clips?",
    a: "Yes. On a stream recording, ClipClap places the webcam and the gameplay in one vertical frame rather than cropping to whichever the face detector prefers, so a reaction and what caused it stay in the same clip. This is the feature most worth testing on your own VOD, because it is where a wrong choice is most obvious.",
  },
  {
    q: "Does ClipClap connect to my Twitch account?",
    a: "No. There is no account connection and no automatic import of new VODs - you paste a Twitch, YouTube or TikTok link, or send the video file, each time. If you want clips to appear without you doing anything after a stream, ClipClap does not do that.",
  },
  {
    q: "Which one should I not use?",
    a: "Do not use ClipClap if you need a public track record before you trust software: Eklipse has around 899 Trustpilot reviews and ClipClap has none at all. Do not use Eklipse if a watermark on free output or 720p is a blocker, or if you want to pay by the week. Both have documented complaints about clip selection, which is a reason to run the same VOD through both before paying either.",
  },
];

export default function EklipseAlternativePage() {
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
          Eklipse alternative: an honest comparison with ClipClap
        </h1>
        <p className="mt-3 text-sm text-neutral-500">
          Figures below were read on {CHECKED}. One caveat stated up front, because it
          matters: Eklipse&apos;s pricing page refused our request twice, so its prices
          here come from Eklipse&apos;s own blog and a pricing-change announcement, and
          the figures for subscribers who joined after 1 January 2026 could not be read
          at all.
        </p>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">The short version</h2>
          <p>
            Eklipse is built for one audience and does not pretend otherwise: Twitch and
            YouTube gaming streamers. Its highlight detection is tuned for gameplay, and
            it has the review history to go with it - around 899 Trustpilot reviews,
            averaging 4.2 out of 5 as of April 2026. ClipClap has none, which is the
            first honest thing to say on this page.
          </p>
          <p>
            <strong className="text-white">Eklipse&apos;s free tier gives 15 highlights per stream</strong>,
            kept 14 days, at 720p and with a watermark. Premium is{" "}
            <strong className="text-white">$24.99 a month</strong>, or roughly $12.50 a
            month - about $3.47 a week - if you pay for a year, and it removes the
            watermark and lifts output to 1080p.
          </p>
          <p>
            <strong className="text-white">ClipClap costs $3 a week for 75 minutes of source video</strong>, or
            $9 a month for 270 minutes, $29 for 1000 and $89 for 3500. The free allowance
            is{" "}
            <strong className="text-white">40 minutes of source video, once, at full resolution, with no card and no watermark</strong>.
            It runs inside a Telegram bot, so the clips arrive in a chat rather than a
            dashboard.
          </p>
          <p>
            The price comparison is less lopsided than it looks. Month to month ClipClap
            is a great deal cheaper; on a yearly commitment Eklipse lands near
            ClipClap&apos;s weekly rate. What actually separates them is the shape of the
            deal - Eklipse asks for a year to reach that price, ClipClap asks for a week.
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
                  <th className="py-2 font-medium">Eklipse</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {[
                  [
                    "Entry price",
                    "$3 a week, or $9 a month",
                    "$24.99 a month, about $12.50 a month on annual billing",
                  ],
                  [
                    "Free tier",
                    "40 source minutes, once, full resolution, no watermark",
                    "15 highlights per stream, 14-day storage, 720p, watermarked",
                  ],
                  [
                    "Unit you buy",
                    "Minutes of source video",
                    "Highlights per stream",
                  ],
                  [
                    "Longest source accepted",
                    "3 hours on paid plans",
                    "Not published on a page we could read",
                  ],
                  [
                    "Webcam and gameplay in one vertical frame",
                    "Yes",
                    "Not confirmed either way from public pages",
                  ],
                  [
                    "Where it runs",
                    "Telegram bot and browser",
                    "Browser, with support through Discord",
                  ],
                  [
                    "Connects to your Twitch account",
                    "No - paste a link or send the file each time",
                    "Not confirmed either way from public pages",
                  ],
                  ["Public reviews", "None yet", "About 899 on Trustpilot, 4.2 average"],
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
          <p className="mt-4 text-xs leading-relaxed text-neutral-600">
            &quot;Not confirmed either way&quot; means exactly that: we could not read it
            on a public page, so this table does not guess. It is not a claim that the
            feature is missing.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            The one thing worth testing on a gameplay VOD
          </h2>
          <p>
            A stream recording is a hard case for automatic vertical cropping, because
            there are two things on screen that matter and a 9:16 frame is not wide
            enough for both if you crop naively. Most tools pick one - usually the face -
            and the reaction survives while the thing being reacted to does not.
          </p>
          <p>
            ClipClap places the webcam and the gameplay together in the vertical frame
            instead, so the moment and the reaction to it stay in the same clip. This is
            the feature to try first on your own VOD, because when a tool gets it wrong
            you can see it in two seconds and no feature list will tell you in advance.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            Where ClipClap is the worse choice
          </h2>
          <p>
            ClipClap has no public reviews. Eklipse has around 899 and a 4.2 average. If
            your rule is that you do not put footage into software with no track record,
            that rule points away from ClipClap and it is a reasonable rule.
          </p>
          <p>
            There is no Twitch account connection either. ClipClap needs you to paste a
            link or send a file after every stream, every time. If you want clips waiting
            for you when you wake up without touching anything, ClipClap does not do that
            - and a tool built around your Twitch account may well be the better fit.
          </p>
          <p>
            Eklipse&apos;s free tier also renews with every stream, where ClipClap&apos;s
            40 minutes are one-time. A streamer going live several times a week gets more
            free output from Eklipse, watermark and 720p included, than from ClipClap.
          </p>
          <p>
            And ClipClap does not specialise. Eklipse&apos;s detection is built for
            gameplay specifically; ClipClap treats a stream, a podcast and an interview
            with the same pipeline. On pure gameplay that generality is a disadvantage,
            not a feature.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            What people report about each
          </h2>
          <p>
            Eklipse&apos;s 4.2 average is a real score on a real sample, and the recurring
            complaints underneath it are worth reading before subscribing: support only
            through Discord with bot replies that reviewers call unhelpful, uneven clip
            selection with key moments missed, a strict no-refund policy, and one reviewer
            reporting captions wrong every time. Reviewers also note that no company
            address or team is listed.
          </p>
          <p>
            ClipClap has nothing to show here at all. That is missing evidence, not good
            evidence. The free allowance exists so the evidence you act on is your own
            footage - and if you are choosing between these two, the useful test is to run
            the same VOD through both and compare which moments each one picked.
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
          <h2 className="text-lg font-semibold text-white">Try it on your own VOD</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-neutral-300">
            40 minutes of source video, no card, no watermark, full resolution. Send a
            Twitch link or the file to the bot and the clips come back in the same chat.
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

        <RelatedComparisons current="eklipse-alternative" />

        <p className="mt-10 text-xs leading-relaxed text-neutral-600">
          Eklipse is a product of its respective owner and is named here only to identify
          the product being compared. Eklipse figures were read on {CHECKED} from
          Eklipse&apos;s own blog and a pricing-change announcement, because its pricing
          page returned an error to us; ClipClap figures are its own current prices. Both
          may have changed since.
        </p>
      </main>
    </div>
  );
}
