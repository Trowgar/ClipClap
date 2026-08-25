import type { Metadata } from "next";
import Link from "next/link";
import { RelatedComparisons } from "@/components/related-comparisons";

/**
 * Fifth comparison page, and the closest audience match of any of them: Crayo names
 * "clippers and streamers" as a segment outright, which is exactly who ClipClap is for.
 *
 * Two things this page deliberately does NOT do:
 *
 * 1. It does not repeat the allegation, present in Crayo's Trustpilot reviews, that the
 *    company pays for fake reviews. Reporting an unproven accusation of fraud on a page
 *    whose whole purpose is to sell against them is not reporting, it is a smear with a
 *    citation. The billing complaints below are reported as what reviewers say, because
 *    those are about the product's own terms and a reader can act on them.
 * 2. It does not convert Crayo's EXPORT minutes into ClipClap's SOURCE minutes. They are
 *    different quantities and the ratio depends entirely on how much of a video becomes
 *    clips, which nobody can know in advance.
 *
 * No FAQPage JSON-LD (retired 7 May 2026), no AggregateRating (ClipClap has no reviews).
 * Competitor named in plain text, nominative use only.
 */

const CHECKED = "19 August 2026";
const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
const BOT = "https://t.me/clipclapio_bot";

export const metadata: Metadata = {
  title: "Crayo alternative: an honest comparison with ClipClap",
  description:
    "Crayo has no free tier and bills export minutes - 40 a month at $19. ClipClap bills source minutes from $3 a week and gives 40 minutes free. Why those units are not the same, and what ClipClap does worse.",
  alternates: { canonical: "/crayo-alternative" },
  openGraph: {
    type: "article",
    url: `${SITE}/crayo-alternative`,
    title: "Crayo alternative: an honest comparison with ClipClap",
    description:
      "Export minutes against source minutes, no free tier against 40 free minutes, and where ClipClap is the wrong choice.",
  },
};

const faq = [
  {
    q: "Can I try Crayo before paying?",
    a: "Not according to its pricing page as read on 19 August 2026 - there was no free tier of any kind, so the cheapest way to see output is $19 for a month of Hobby. ClipClap gives 40 minutes of source video free, once per account, with no card and no watermark. If you want to see what a tool does to your own footage before spending anything, that is the whole difference.",
  },
  {
    q: "Is $19 a month cheaper than $3 a week?",
    a: "Over a month, $3 a week is about $13 against Crayo's $19, so yes on the headline - but the units differ, so the headline is not the whole story. Crayo's Hobby gives 40 EXPORT minutes a month, meaning finished clip length. ClipClap's Starter gives 75 SOURCE minutes a week, meaning input length. Forty minutes of finished clips is a lot of clips; 75 minutes of input is roughly one long podcast. Which goes further depends on how much of your footage becomes clips.",
  },
  {
    q: "What is the difference between export minutes and source minutes?",
    a: "Source minutes are what you put in - a 60-minute stream costs 60. Export minutes are what comes out - if that stream produces eight clips of 45 seconds, that is six export minutes. Billing by exports is generous to people who send long footage and take few clips from it; billing by source is generous to people who take a lot of clips out of a little footage. Neither is a trick, and no honest page can convert one into the other for you.",
  },
  {
    q: "What does Crayo do that ClipClap does not?",
    a: "Quite a lot that is not clipping at all: AI avatars, voiceovers, Reddit-story video generators and 15 or more caption styles. If you want faceless content produced from scratch as well as clips cut from footage you already have, Crayo covers both and ClipClap covers only the second.",
  },
  {
    q: "Are there complaints worth knowing about?",
    a: "Crayo's Trustpilot page carries repeated reports of being charged after cancelling, with no support response and no refund, and its published policy is that all sales are final. Whether that is a billing system problem or a policy problem, it is the thing to read before you enter a card. ClipClap has no public reviews at all, which is missing evidence rather than good evidence.",
  },
];

export default function CrayoAlternativePage() {
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
          Crayo alternative: an honest comparison with ClipClap
        </h1>
        <p className="mt-3 text-sm text-neutral-500">
          Prices below were read on each vendor&apos;s own pricing page on {CHECKED}.
          Where a vendor does not publish a number, this page says so rather than
          repeating one from somewhere else.
        </p>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">The short version</h2>
          <p>
            Of every tool ClipClap gets compared with, Crayo is aimed at the closest
            audience: it names clippers and streamers as a segment outright. But it is a
            wider product than a clipper - AI avatars, voiceovers and Reddit-story
            generators sit alongside the long-to-short repurposing, and if you want
            faceless content made from nothing, ClipClap does not do that at all.
          </p>
          <p>
            <strong className="text-white">Crayo has no free tier.</strong> Its plans are
            Hobby $19 a month, or $13.33 a month billed annually, for 40 export minutes;
            Clipper $39 a month, or $27.25 annually, for two hours of export; and Pro $79
            a month, or $55.33 annually. Its published refund policy is that all sales are
            final.
          </p>
          <p>
            <strong className="text-white">ClipClap is $3 a week for 75 minutes of source video</strong>,
            or $9 a month for 270 minutes, $29 for 1000 and $89 for 3500, and gives{" "}
            <strong className="text-white">40 minutes of source video free, once, with no card and no watermark</strong>.
          </p>
          <p>
            The number that looks comparable is not.{" "}
            <strong className="text-white">
              Crayo bills export minutes and ClipClap bills source minutes
            </strong>
            , and there is no fixed ratio between them - it depends on how much of your
            footage becomes clips.
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
                  <th className="py-2 font-medium">Crayo</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {[
                  [
                    "What you are buying",
                    "Minutes of source video (input)",
                    "Minutes of export (finished clip length)",
                  ],
                  [
                    "Entry price",
                    "$3 a week, or $9 a month for 270 source minutes",
                    "$19 a month, or $13.33 annually, for 40 export minutes",
                  ],
                  [
                    "Free tier",
                    "40 source minutes, once, no card, no watermark",
                    "None",
                  ],
                  [
                    "Shortest commitment",
                    "One week",
                    "One month",
                  ],
                  [
                    "Refunds",
                    "Not offered as a policy; the free allowance is the trial",
                    "All sales final, per its own page",
                  ],
                  [
                    "Also makes content from scratch",
                    "No",
                    "Yes - AI avatars, voiceovers, Reddit-story videos",
                  ],
                  [
                    "Longest source accepted",
                    "3 hours on paid plans",
                    "Not published as a source limit",
                  ],
                  [
                    "Where it runs",
                    "Telegram bot and browser",
                    "Browser",
                  ],
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
            Export minutes and source minutes, plainly
          </h2>
          <p>
            Say you have a 60-minute podcast and you want eight clips of about 45 seconds
            each. On ClipClap that costs 60 minutes, because it charges for what you put
            in. On Crayo it costs roughly six export minutes, because it charges for what
            comes out.
          </p>
          <p>
            On those numbers Crayo&apos;s 40 export minutes go a very long way and
            ClipClap&apos;s 75 weekly source minutes cover barely one podcast. If instead
            you are cutting many short sources and keeping most of each, the balance moves
            the other way.
          </p>
          <p>
            The practical rule: if you feed in a lot of footage and keep a little, export
            billing is on your side. If you feed in a little and keep a lot, source
            billing is. Anyone who tells you one is simply cheaper has not asked what you
            are putting in.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            Where ClipClap is the worse choice
          </h2>
          <p>
            For long-form work, honestly, the billing unit favours Crayo. Hours of podcast
            or stream every week will exhaust ClipClap&apos;s source minutes long before
            they exhaust an export allowance. That is a real disadvantage and no amount of
            framing changes it.
          </p>
          <p>
            Crayo also makes content ClipClap cannot: AI avatars, voiceovers, Reddit-story
            videos, and more caption styles than ClipClap offers. If a faceless channel is
            what you are building, ClipClap only does the half of the job that starts with
            footage you already have.
          </p>
          <p>
            And ClipClap has no public reviews to check at all. That is a fair reason to
            spend the free 40 minutes on your own footage before paying for anything, from
            anyone.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            What people report about each
          </h2>
          <p>
            Crayo&apos;s Trustpilot page carries repeated reports of subscribers being
            charged after cancelling, with no support response and no refund afterwards.
            Its own published policy is that all sales are final. Whether those reports
            describe a billing fault or the policy working as written, it is the thing
            worth reading before entering a card - particularly given there is no free
            tier, so entering a card is the only way to see the product at all.
          </p>
          <p>
            ClipClap has no reviews, and that is missing evidence rather than good
            evidence. What it has instead is 40 minutes you can spend without a card,
            which is the same information gathered a different way.
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
            See the output before you pay anything
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

        <RelatedComparisons current="crayo-alternative" />

        <p className="mt-10 text-xs leading-relaxed text-neutral-600">
          Crayo is a product of its respective owner and is named here only to identify the
          product being compared. Figures for both products were read on their public pages
          on {CHECKED} and may have changed since.
        </p>
      </main>
    </div>
  );
}
