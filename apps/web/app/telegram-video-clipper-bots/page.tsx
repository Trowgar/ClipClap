import type { Metadata } from "next";
import Link from "next/link";
import { RelatedComparisons } from "@/components/related-comparisons";

/**
 * A category page rather than a head-to-head, and the only query in the whole competitor
 * map that nobody covers: what actually exists if you want a Telegram bot that cuts long
 * video into clips.
 *
 * Written to the same rules as the head-to-heads, plus one that matters more here. Two of
 * the three products on this page have no formal pricing page at all - the bot IS the
 * product - so the figures come from a Product Hunt listing and a feature page and are
 * labelled as approximate where the source labelled them so. A category page is where
 * invented numbers do the most damage, because a reader arrives with no priors at all.
 *
 * It also says plainly that one competitor's billing model is better than ours for a
 * common case. That is not modesty, it is the only reason a page like this is worth
 * reading instead of the ten listicles that rank above it.
 *
 * No FAQPage JSON-LD (retired 7 May 2026). No AggregateRating - none of these products has
 * a review base worth quoting, ours least of all.
 *
 * Trademark: competitors named in plain text only, nominative use to identify the products
 * being compared.
 */

const CHECKED = "19 August 2026";
const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
const BOT = "https://t.me/clipclapio_bot";

export const metadata: Metadata = {
  title: "Telegram bots that clip long video into shorts, compared",
  description:
    "Three Telegram bots cut long video into vertical clips: ClipClap, Clipline and Vyexa. One of them only cuts manually inside Telegram. What each costs, what each actually does in the chat, and which suits which footage. Checked 19 August 2026.",
  alternates: { canonical: "/telegram-video-clipper-bots" },
  openGraph: {
    type: "article",
    url: `${SITE}/telegram-video-clipper-bots`,
    title: "Telegram bots that clip long video into shorts, compared",
    description:
      "Only three of these exist, they work very differently, and one of them does not use AI inside the bot at all.",
  },
};

const faq = [
  {
    q: "Which Telegram bots actually cut long video into clips?",
    a: "Three that we could find and verify as of 19 August 2026: ClipClap, Clipline and Vyexa. ClipClap and Clipline both pick the moments for you. Vyexa's bot does not - inside Telegram it cuts a fragment you choose by timestamp, and its AI highlight detection lives on its website rather than in the chat.",
  },
  {
    q: "Can a Telegram bot really replace a web app for this?",
    a: "For clipping, yes, and that is the point of the format: you send a link or a file in a chat and the clips come back as videos in the same chat, on the phone you are already holding, with nothing installed. What you give up is a timeline editor, a library view and anything resembling a dashboard. If you want to hand-adjust a cut, none of these three is the right tool.",
  },
  {
    q: "Which one is cheapest?",
    a: "It depends on what you send, because they do not bill the same way. Clipline charges per delivered clip and refunds ones you do not take, with a free test of 5 minutes and 2 clips. ClipClap charges for minutes of source video, from $3 a week, with 40 minutes free once. Vyexa gives 20 free clips on signup, and its paid pricing we could not read. If you often reject the clips a tool produces, Clipline's model costs you less than ours does.",
  },
  {
    q: "Do any of them handle a full stream VOD?",
    a: "ClipClap takes sources up to three hours on paid plans and places webcam and gameplay together in the vertical frame, which is the case a stream needs. Clipline has no Twitch-specific handling that its listing describes. Vyexa's bot is for manual trims rather than long-form work. Maximum source lengths for the other two are not published anywhere we could read.",
  },
  {
    q: "Where does ClipClap lose to the others here?",
    a: "To Clipline, on billing: it charges per clip delivered and refunds what you reject, so a run that produces nothing you want costs you nothing. ClipClap charges the source minutes whether you like the clips or not. Clipline also translates subtitles and supports a custom watermark; ClipClap does neither. And all three are small products - ClipClap has no public reviews at all.",
  },
];

export default function TelegramClipperBotsPage() {
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
          Telegram bots that clip long video into shorts, compared
        </h1>
        <p className="mt-3 text-sm text-neutral-500">
          Checked {CHECKED}. Two of the three products here have no formal pricing page -
          the bot is the whole product - so their figures come from a Product Hunt listing
          and a feature page, and are marked approximate where the source marked them so.
          ClipClap is our own product and this page says where it loses.
        </p>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">The short version</h2>
          <p>
            There are three of these, not thirty. Every listicle that promises you
            &quot;the 15 best Telegram video bots&quot; is padding the list with
            downloaders, converters and trimmers. If what you want is{" "}
            <em>send a long video, get short vertical clips back in the chat</em>, the
            real options as of {CHECKED} are ClipClap, Clipline and Vyexa - and they are
            not variations on the same thing.
          </p>
          <p>
            <strong className="text-white">The single most useful fact on this page:</strong>{" "}
            Vyexa&apos;s Telegram bot does not choose moments for you. Inside the chat it
            cuts a fragment that <em>you</em> pick by timestamp and crops it to 9:16 with
            subtitles. Its AI highlight detection exists on the Vyexa website, not in the
            bot. If you found it while searching for an AI clipper in Telegram, that is
            worth knowing before you start.
          </p>
          <p>
            <strong className="text-white">Clipline</strong> is bot-only with no web app
            at all, uses Gemini to pick moments, and bills in a way none of the others do:
            pay per delivered clip, with a hold-and-refund model, so clips you reject are
            refunded. Its listing shows a free test of 5 minutes and 2 clips, then tiers
            at roughly $3, $9 and $22.50 - approximate, because that is how they are
            listed. It also does subtitle translation and custom watermarks, and deletes
            the source video after three hours.
          </p>
          <p>
            <strong className="text-white">ClipClap</strong> - ours - picks the moments,
            runs in both the bot and a browser, bills minutes of source video from $3 a
            week, and gives 40 minutes free once per account with no card and no
            watermark. It handles sources up to three hours on paid plans and puts webcam
            and gameplay in the same vertical frame for stream footage.
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
                  <th className="py-2 pr-4 font-medium">Clipline</th>
                  <th className="py-2 font-medium">Vyexa</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {[
                  [
                    "Picks the moments for you",
                    "Yes",
                    "Yes",
                    "No - the bot cuts a timestamp you choose",
                  ],
                  [
                    "Works without leaving Telegram",
                    "Yes, and there is a browser version too",
                    "Yes, bot only - no web app",
                    "Bot for manual cuts; AI features are on the website",
                  ],
                  [
                    "What you pay for",
                    "Minutes of source video",
                    "Each clip delivered, refunded if rejected",
                    "Credits and clips; paid tiers not published where we could read",
                  ],
                  [
                    "Entry price",
                    "$3 a week",
                    "About $3, then $9 and $22.50 as listed",
                    "Not published on the page we read",
                  ],
                  [
                    "Free to start",
                    "40 source minutes, once, no card",
                    "5 minutes and 2 clips",
                    "20 clips on signup, no card",
                  ],
                  [
                    "Longest source",
                    "3 hours on paid plans",
                    "Not published",
                    "Not published",
                  ],
                  [
                    "Stream layout, webcam plus gameplay",
                    "Yes",
                    "No Twitch-specific handling described",
                    "Not applicable - manual cuts",
                  ],
                  [
                    "Subtitle translation",
                    "No",
                    "Yes",
                    "Not described",
                  ],
                  [
                    "Interface languages",
                    "7",
                    "Not published",
                    "9 listed",
                  ],
                ].map(([label, ours, clipline, vyexa]) => (
                  <tr key={label} className="border-b border-white/[0.06]">
                    <td className="py-3 pr-4 text-neutral-500">{label}</td>
                    <td className="py-3 pr-4 text-white">{ours}</td>
                    <td className="py-3 pr-4">{clipline}</td>
                    <td className="py-3">{vyexa}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-neutral-600">
            &quot;Not published&quot; means we could not read it on a page these products
            make public. It is not a claim that the thing is missing.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            The billing model is the real difference
          </h2>
          <p>
            Ignore the headline numbers for a moment, because the three products are not
            selling the same thing.
          </p>
          <p>
            <strong className="text-white">Clipline charges for clips you keep.</strong> If
            a run produces six clips and you reject four, you are refunded for the four.
            That directly solves the worst thing about automatic clipping - that the tool
            decides what is good and you pay either way.
          </p>
          <p>
            <strong className="text-white">ClipClap charges for minutes you send</strong>,
            whether the clips are any good or not. That is better when you trust the
            output and want to process a lot of footage predictably, and{" "}
            <strong className="text-white">worse when you do not</strong>. We are not going
            to pretend otherwise: if you expect to reject most of what a clipper produces,
            Clipline&apos;s model costs you less than ours.
          </p>
          <p>
            <strong className="text-white">Vyexa charges for clips you cut yourself</strong>,
            which is a different job entirely - closer to a trimming tool with automatic
            vertical cropping than to an AI clipper.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            Which one fits which footage
          </h2>
          <p>
            <strong className="text-white">A stream or gameplay VOD.</strong> ClipClap, for
            one specific reason: a 9:16 frame is not wide enough for both the webcam and
            the gameplay, and a naive crop keeps the face while losing what the face
            reacted to. ClipClap puts both in the frame. Neither of the others describes
            handling this case.
          </p>
          <p>
            <strong className="text-white">A podcast or interview, and you are picky.</strong>{" "}
            Clipline. Talking-head footage is the easiest case for any of these tools, so
            the selection quality gap narrows, and being refunded for clips you reject
            matters more than it does elsewhere.
          </p>
          <p>
            <strong className="text-white">You already know the exact moment you want.</strong>{" "}
            Vyexa. If you can give a timestamp, no AI needs to guess, and a manual cut with
            automatic vertical framing and subtitles is the shortest path there.
          </p>
          <p>
            <strong className="text-white">You want to see output before paying.</strong>{" "}
            All three let you, which is unusual for this category - the mainstream web
            tools mostly do not. ClipClap gives the largest free window at 40 minutes of
            source with no watermark; Clipline gives 5 minutes and 2 clips; Vyexa gives 20
            clips.
          </p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">
            What none of these three has
          </h2>
          <p>
            A review history. All three are small products. Clipline is a solo-founder
            product too new for review-site coverage; Vyexa we found no reviews for;
            ClipClap has none at all. If your rule is to only use software with a public
            track record, that rule rules out this entire category and points you at the
            web tools instead - Opus Clip, Submagic, Eklipse and the rest, which have
            thousands of reviews between them and none of the Telegram convenience.
          </p>
          <p>
            None of the three offers an API, team seats, scheduled posting or analytics
            either. These are phone-first tools for one person clipping their own footage,
            and that is the whole shape of the category.
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
          <h2 className="text-lg font-semibold text-white">Try ours in the chat</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-neutral-300">
            40 minutes of source video, no card, no watermark. Send a link or a file and
            the clips come back in the same conversation.
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

        <RelatedComparisons current="telegram-video-clipper-bots" />

        <p className="mt-10 text-xs leading-relaxed text-neutral-600">
          Clipline and Vyexa are products of their respective owners and are named here
          only to identify the products being compared. Their figures were read on{" "}
          {CHECKED} from a Product Hunt listing and a public feature page respectively,
          because neither publishes a conventional pricing page; ClipClap figures are its
          own current prices. All may have changed since.
        </p>
      </main>
    </div>
  );
}
