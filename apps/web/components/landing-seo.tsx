import Link from "next/link";
import { FREE_TIER, PLAN_LIMITS } from "@clipclap/shared/config/plans";

const freeMinutes = Math.floor(FREE_TIER.lifetimeSeconds / 60);
const starter = PLAN_LIMITS.STARTER.WEEKLY!;

export function LandingSeo() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
      <section aria-labelledby="workflow-heading">
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">The workflow</p>
        <h2 id="workflow-heading" className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          How to turn a long video into short clips
        </h2>
        <ol className="mt-8 grid gap-8 md:grid-cols-3">
          {[
            ["01", "Send your video", "Paste a YouTube, Twitch or TikTok link, or upload a video file. Use the browser or send it to the ClipClap Telegram bot."],
            ["02", "Let AI find the moments", "ClipClap transcribes the audio, selects highlights and creates vertical clips with subtitles. Clear speech and a complete story help a clip stand on its own."],
            ["03", "Review and download", "Watch the clips, check the wording and framing, then download the ones you want to publish. Upload them to TikTok, Instagram Reels or YouTube Shorts yourself."],
          ].map(([number, title, text]) => (
            <li key={number} className="border-t border-white/15 pt-5">
              <span className="font-mono text-xs text-neutral-500">{number}</span>
              <h3 className="mt-3 font-medium text-white">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-400">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="footage-heading" className="mt-16 border-t border-white/10 pt-10">
        <h2 id="footage-heading" className="text-2xl font-semibold text-white">One recording, several ways to use it</h2>
        <div className="mt-6 grid gap-6 md:grid-cols-2 text-sm leading-relaxed text-neutral-400">
          <p><strong className="text-white">Video podcasts and interviews.</strong> Pull out a self-contained answer, anecdote or explanation. Review the start and ending so a viewer can understand the clip without the full episode.</p>
          <p><strong className="text-white">Streams and gaming VODs.</strong> Turn spoken reactions and highlights into vertical clips. ClipClap can combine webcam and gameplay in the frame; check that the action remains visible before posting.</p>
        </div>
        <p className="mt-6 text-sm leading-relaxed text-neutral-400">
          Source videos must be at least 60 seconds long; files can be up to 2 GB. Paid plans accept sources up to {starter.maxSourceDurationMinutes} minutes;
          the free allowance is {freeMinutes} source minutes total. If a platform link cannot be imported,
          upload a copy you have permission to use. Processing time and the number of useful clips depend on the footage.
        </p>
      </section>

      <section aria-labelledby="compare-heading" className="mt-16 border-t border-white/10 pt-10">
        <h2 id="compare-heading" className="text-2xl font-semibold text-white">Choose your clipping workflow</h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-3">
          {[
            ["/telegram-video-clipper-bots", "Telegram video clipper bots", "Send a video in chat and receive clips on your phone. See how to start and how the bots differ."],
            ["/opus-clip-alternative", "An Opus Clip alternative", "Compare free exports, source allowances and weekly billing, including where Opus Clip offers more."],
            ["/ai-clipping-tools-compared", "Compare AI clipping tools", "Check what each plan bills for: source minutes, credits or delivered clips."],
          ].map(([href, title, text]) => (
            <Link key={href} href={href} className="group rounded-xl border border-white/10 p-5 transition-colors hover:border-white/30 focus-visible:outline-2 focus-visible:outline-white">
              <h3 className="font-medium text-white group-hover:underline">{title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-neutral-400">{text}</p>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="questions-heading" className="mt-16 border-t border-white/10 pt-10">
        <h2 id="questions-heading" className="text-2xl font-semibold text-white">Before you make your first clip</h2>
        <dl className="mt-6 space-y-6 text-sm leading-relaxed">
          {[
            ["Is this AI video clipper free?", `You get ${freeMinutes} minutes of source video once per account, with no card and no watermark. After that, paid plans start at $${starter.priceUsd} a week for ${starter.minutesPerPeriod} source minutes. The free allowance does not renew every month.`],
            ["Can I turn YouTube videos into Shorts?", "Yes. Import a YouTube video you own or have permission to reuse, review the generated vertical clips and upload your chosen files to YouTube Shorts. If the link cannot be fetched, use a direct file upload."],
            ["Does it add subtitles automatically?", "Yes. Clips include burned-in subtitles. Check names, specialist terms and timing before publishing; automatic transcription can make mistakes."],
            ["Does ClipClap publish clips or guarantee views?", "No. You choose and publish the clips. ClipClap helps select and prepare moments; audience response depends on the footage, context and your channel. There is no automatic posting or guaranteed view count."],
          ].map(([question, answer]) => (
            <div key={question}>
              <dt className="font-medium text-white">{question}</dt>
              <dd className="mt-2 text-neutral-400">{answer}</dd>
            </div>
          ))}
        </dl>
        <Link href="/login" className="mt-8 inline-flex rounded-xl bg-white px-5 py-3 text-sm font-semibold text-black hover:bg-neutral-200">
          Try your first video free
        </Link>
      </section>
    </div>
  );
}
