import type { Metadata } from "next";
import Link from "next/link";
import { RelatedComparisons } from "@/components/related-comparisons";
import { FREE_TIER, PLAN_LIMITS } from "@clipclap/shared/config/plans";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
const BOT = "https://t.me/clipclapio_bot?start=src_cmp_tgbots";
const FREE_MINUTES = Math.floor(FREE_TIER.lifetimeSeconds / 60);
const STARTER = PLAN_LIMITS.STARTER.WEEKLY!;
const TITLE = "Telegram Video Clipper Bots: AI Clips & Manual Trims";
const DESCRIPTION = "Turn long videos into subtitled clips in Telegram. Follow the ClipClap workflow and compare ClipClap, Clipline and Vyexa.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/telegram-video-clipper-bots" },
  openGraph: { type: "article", url: `${SITE}/telegram-video-clipper-bots`, title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default function TelegramClipperBotsPage() {
  return (
    <div className="min-h-screen bg-black text-neutral-200">
      <header className="border-b border-white/[0.06] px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <Link href="/" className="text-sm font-medium text-white">ClipClap</Link>
          <a href={BOT} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-white px-3.5 py-1.5 text-sm font-medium text-black hover:bg-neutral-200">Start free</a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Telegram video clipper bots: turn long videos into shorts</h1>
        <p className="mt-4 text-base leading-relaxed text-neutral-300">
          A Telegram video clipper bot lets you send a recording in chat and get short video files back.
          ClipClap selects highlights with AI and adds vertical framing and subtitles. A manual trimming bot
          is useful when you already know the timestamps. Choose based on which job you need done.
        </p>
        <p className="mt-3 text-sm text-neutral-400">Updated 9 September 2026 by the ClipClap team. ClipClap is our product. Competitor details below describe public documentation, not a hands-on benchmark or an exhaustive list of bots.</p>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">How to make AI clips in Telegram with ClipClap</h2>
          <ol className="list-decimal space-y-4 pl-5">
            <li><a href={BOT} target="_blank" rel="noopener noreferrer" className="text-white underline underline-offset-4">Open @clipclapio_bot</a> and press Start. Your account gets {FREE_MINUTES} source minutes once, with no card required.</li>
            <li>Send a YouTube, Twitch or TikTok link, or a video file you have permission to process. Start with a 5–10-minute recording so you can judge the output before using the rest of your allowance.</li>
            <li>Follow the bot&apos;s prompts to submit the job. ClipClap transcribes the audio, selects moments, crops the footage and adds subtitles. The time needed depends on the source and queue.</li>
            <li>Receive the clips in the chat. Play them through, check the opening and ending, and review names in the subtitles. Save the files you want to publish.</li>
          </ol>
          <p>You still choose where and when to post. The bot delivers video files; it does not publish them to your social accounts or guarantee that a clip will get views.</p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">What you can send and what comes back</h2>
          <dl className="grid gap-5 sm:grid-cols-2">
            {[
              ["Input", "A supported video link or a file up to 2 GB, at least 60 seconds long. Clear speech helps transcription and highlight selection."],
              ["Output", "Short vertical video clips with burned-in subtitles, delivered in Telegram. Review the framing and wording before posting."],
              ["Source length", `Paid plans accept sources up to ${STARTER.maxSourceDurationMinutes} minutes. Free usage is ${FREE_MINUTES} source minutes total, once per account.`],
              ["Billing", `Source video time, not the number of clips you keep. Starter is $${STARTER.priceUsd} per week for ${STARTER.minutesPerPeriod} source minutes. The free clips have no watermark.`],
            ].map(([label, value]) => <div key={label} className="border-t border-white/10 pt-4"><dt className="font-medium text-white">{label}</dt><dd className="mt-2">{value}</dd></div>)}
          </dl>
          <p>A two-hour podcast exceeds the free allowance. Use a shorter excerpt to evaluate selection and subtitles, or choose a paid plan with enough source minutes. If a platform blocks a link import, try a direct file upload.</p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">AI highlight selection or a timestamp cut?</h2>
          <p>For an interview, look for an answer that makes sense without the question. For a stream, keep enough of the setup to explain the reaction. AI selection can save reviewing time, but it can also miss an important moment or start too late.</p>
          <p>If you know that the usable moment is between 12:15 and 12:50, a manual trim may be the better fit. If you have a long recording and no shortlist, automatic selection gives you a starting point. Evaluate the actual clips, not the number generated.</p>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-white">Three options to check</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b border-white/10 text-neutral-400"><th scope="col" className="py-3 pr-4">Tool</th><th scope="col" className="py-3 pr-4">Workflow</th><th scope="col" className="py-3">Free access / source</th></tr></thead>
              <tbody className="text-neutral-300">
                <tr className="border-b border-white/10 align-top"><th scope="row" className="py-4 pr-4 font-medium text-white">ClipClap</th><td className="py-4 pr-4">AI-selected highlights in Telegram; browser access too.</td><td className="py-4">{FREE_MINUTES} source minutes once, no watermark. <Link href="/#pricing" className="underline underline-offset-4">Our plans</Link>.</td></tr>
                <tr className="border-b border-white/10 align-top"><th scope="row" className="py-4 pr-4 font-medium text-white">Clipline</th><td className="py-4 pr-4">Advertised as AI video clipping in Telegram.</td><td className="py-4">Check current allowance and pricing in the <a href="https://t.me/clipline_bot" className="underline underline-offset-4">official bot</a>; its public profile does not list them.</td></tr>
                <tr className="border-b border-white/10 align-top"><th scope="row" className="py-4 pr-4 font-medium text-white">Vyexa</th><td className="py-4 pr-4">Its bot page describes manual timestamp cuts; AI selection is on the website.</td><td className="py-4">The page lists 3 clips on first bot launch and 20 monthly on the website. <a href="https://vyexa.net/bot-crop-short" className="underline underline-offset-4">Official bot guide</a>.</td></tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-neutral-400">Sources checked 9 September 2026. Older figures and refund claims from third-party listings are not used here. Confirm the current terms inside a bot before paying; public descriptions can change.</p>
        </section>

        <section className="mt-10 space-y-4 text-[15px] leading-relaxed text-neutral-300">
          <h2 className="text-xl font-semibold text-white">When a browser tool is a better fit</h2>
          <p>Chat is convenient for submitting a video and receiving the result. A browser is easier for reviewing multiple clips on a larger screen. ClipClap supports both, but has no public API, automatic social posting or team seats.</p>
          <p>For a broader editing and publishing workflow, read our <Link href="/opus-clip-alternative" className="text-white underline underline-offset-4">Opus Clip alternative comparison</Link>. To compare billing units across products, use the <Link href="/ai-clipping-tools-compared" className="text-white underline underline-offset-4">AI clipping tools comparison</Link>.</p>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold text-white">Questions about Telegram video clipping</h2>
          <dl className="mt-4 space-y-6 text-[15px] leading-relaxed">
            {[
              ["Do I need a paid Telegram account?", "You can start a chat with ClipClap using a regular Telegram account. ClipClap has its own free allowance and paid plans; Telegram Premium is not a ClipClap subscription."],
              ["Can I use the same account in the browser?", "Yes. Use Telegram sign-in on the ClipClap login page to access the account associated with your Telegram identity."],
              ["Will every video produce useful clips?", "No. Selection depends on the recording. Incomplete stories, unclear audio or moments that need earlier context may need a different cut. Source-minute billing is not payment per accepted clip."],
              ["Can I get clips without using Telegram?", "Yes. ClipClap also works in the browser. Upload your video or paste a supported link there and review the generated clips in your project."],
            ].map(([q, a]) => <div key={q}><dt className="font-medium text-white">{q}</dt><dd className="mt-2 text-neutral-300">{a}</dd></div>)}
          </dl>
        </section>
        <section className="mt-12 rounded-xl border border-white/10 p-6">
          <h2 className="text-lg font-semibold text-white">Try one recording in Telegram</h2>
          <p className="mt-2 text-sm leading-relaxed text-neutral-300">{FREE_MINUTES} source minutes free, once. No card, no watermark. See whether the clips work for your footage.</p>
          <a href={BOT} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200">Start free in Telegram</a>
          <p className="mt-4 text-sm text-neutral-400">No Telegram? <Link href="/login" className="underline underline-offset-4">Use ClipClap in your browser</Link>.</p>
        </section>
        <RelatedComparisons current="telegram-video-clipper-bots" />
      </main>
    </div>
  );
}
