export type SeoLandingPage = {
  slug: string;
  path: `/${string}`;
  primaryKeyword: string;
  title: string;
  description: string;
  breadcrumb: string;
  eyebrow: string;
  h1: string;
  intro: string;
  summary: string;
  ctaLabel: string;
  ctaHref: string;
  proofPoints: readonly { label: string; value: string }[];
  workflow: readonly { title: string; text: string }[];
  limitations: readonly string[];
  questions: readonly { question: string; answer: string }[];
  relatedSlugs: readonly string[];
  lastModified: string;
};

const BROWSER_CTA = "/login";
const TELEGRAM_BOT =
  "https://t.me/clipclapio_bot?start=src_seo_telegram_video_clipper";

export const PRODUCT_SEO_PAGES = [
  {
    slug: "ai-video-clipper",
    path: "/ai-video-clipper",
    primaryKeyword: "AI video clipper",
    title: "AI Video Clipper for Long Videos | ClipClap",
    description:
      "Turn long videos into vertical clips with AI subtitles. Get 40 free source minutes with no card or watermark in ClipClap.",
    breadcrumb: "AI video clipper",
    eyebrow: "Long-form to short-form",
    h1: "AI Video Clipper for Long Videos",
    intro:
      "An AI video clipper for streams, podcasts and VODs: send a long video, let ClipClap find strong moments, then review vertical clips with burned-in subtitles before publishing.",
    summary:
      "Turn long streams, podcasts and VODs into review-ready vertical clips.",
    ctaLabel: "Start a free clip",
    ctaHref: BROWSER_CTA,
    proofPoints: [
      { label: "Bring", value: "YouTube, Twitch or TikTok links, or a file" },
      { label: "Get", value: "9:16 clips with burned-in subtitles" },
      { label: "Try", value: "40 source minutes free, no card" },
    ],
    workflow: [
      {
        title: "Send long-form footage",
        text: "Paste a supported video link or upload a file you own or have permission to reuse. Files can be up to 2 GB and must be at least 60 seconds long.",
      },
      {
        title: "Let ClipClap find moments",
        text: "The pipeline transcribes the audio, selects moments that can stand on their own and cuts them into vertical clips with subtitles.",
      },
      {
        title: "Review before you post",
        text: "Watch each result, correct names or wording if needed, check the opening and ending, and download only the clips you want to publish.",
      },
    ],
    limitations: [
      "ClipClap prepares clips but does not publish them, schedule posts or guarantee views.",
      "Automatic transcription and selection can miss context, names or the best moment, so every clip needs a human review.",
    ],
    questions: [
      {
        question: "Is ClipClap free to try?",
        answer:
          "You get 40 source minutes once per account, with no card required and no watermark on the free clips. The allowance does not renew automatically.",
      },
      {
        question: "Can I use ClipClap from Telegram?",
        answer:
          "Yes. Send a link or file to the ClipClap Telegram bot, or use the browser when you want to upload and review from a larger screen.",
      },
    ],
    relatedSlugs: [
      "podcast-to-shorts",
      "twitch-clip-maker",
      "ai-clipping-tools-compared",
    ],
    lastModified: "2026-09-20",
  },
  {
    slug: "podcast-to-shorts",
    path: "/podcast-to-shorts",
    primaryKeyword: "podcast to Shorts",
    title: "Podcast to Shorts Converter with AI | ClipClap",
    description:
      "Convert podcast and interview recordings into subtitled vertical Shorts. Try 40 free source minutes in ClipClap with no card or watermark.",
    breadcrumb: "Podcast to Shorts",
    eyebrow: "For podcasts and interviews",
    h1: "Podcast to Shorts Converter for Long Interviews",
    intro:
      "Podcast to Shorts starts with a useful answer, story or exchange—not a random slice. ClipClap turns long interviews and video podcasts into vertical clips with subtitles for review.",
    summary:
      "Find self-contained answers and stories inside long podcast recordings.",
    ctaLabel: "Turn a podcast into Shorts",
    ctaHref: BROWSER_CTA,
    proofPoints: [
      { label: "Input", value: "A podcast link or uploaded recording" },
      { label: "Selection", value: "AI highlights moments from the transcript" },
      { label: "Output", value: "Vertical clips with burned-in subtitles" },
    ],
    workflow: [
      {
        title: "Start with the full conversation",
        text: "Send a YouTube link or upload the recording. Use footage you own or have permission to republish, especially when a guest or publisher owns the original episode.",
      },
      {
        title: "Look for complete thoughts",
        text: "ClipClap transcribes the audio and looks for moments with enough context to work as a short. Clear questions, answers and anecdotes are easier to review than isolated sentences.",
      },
      {
        title: "Check the cut and captions",
        text: "Review the first and last line, speaker names and subtitle timing. Download the clips that make sense without asking the viewer to watch the entire episode first.",
      },
    ],
    limitations: [
      "A podcast with overlapping speakers, music or poor audio may need more subtitle and cut review.",
      "ClipClap does not add a podcast cover, publish to social networks or replace an editor's final approval.",
    ],
    questions: [
      {
        question: "Does it choose clips from the whole podcast?",
        answer:
          "It can process long source video on paid plans within the published source-duration limit. The result is a set of candidate moments, not a promise that every important exchange will be selected.",
      },
      {
        question: "Can I add the clips to YouTube Shorts?",
        answer:
          "Yes. Download the vertical clips, review the subtitles and rights, then upload the files to YouTube Shorts yourself.",
      },
    ],
    relatedSlugs: [
      "ai-video-clipper",
      "youtube-to-shorts",
      "ai-clipping-tools-compared",
    ],
    lastModified: "2026-09-20",
  },
  {
    slug: "twitch-clip-maker",
    path: "/twitch-clip-maker",
    primaryKeyword: "Twitch clip maker",
    title: "Twitch Clip Maker for Streams and VODs | ClipClap",
    description:
      "Turn Twitch VODs and streams into vertical clips with subtitles while keeping gameplay and webcam context visible. Try ClipClap free.",
    breadcrumb: "Twitch clip maker",
    eyebrow: "For streams and gaming VODs",
    h1: "Twitch Clip Maker for Streams and VODs",
    intro:
      "A Twitch clip maker for long VODs should preserve the reaction and the thing that caused it. ClipClap finds spoken highlights and reframes the result for vertical video with subtitles.",
    summary:
      "Turn stream reactions and gameplay moments into vertical clips with context.",
    ctaLabel: "Clip a Twitch VOD",
    ctaHref: BROWSER_CTA,
    proofPoints: [
      { label: "Source", value: "Twitch links or uploaded VOD files" },
      { label: "Frame", value: "Gameplay and webcam context in 9:16" },
      { label: "Try", value: "40 source minutes free, no watermark" },
    ],
    workflow: [
      {
        title: "Send a VOD you can reuse",
        text: "Paste a Twitch link or upload the recording. There is no Twitch account connection or automatic VOD import, so submit the source you want processed each time.",
      },
      {
        title: "Find the reaction and payoff",
        text: "ClipClap transcribes the stream and searches for moments that can become a short. The vertical framing is designed to keep the webcam and gameplay visible when both matter.",
      },
      {
        title: "Review action, names and timing",
        text: "Check that the action remains visible, the opening explains the moment and subtitles spell usernames or game terms correctly before you download the clip.",
      },
    ],
    limitations: [
      "No automatic Twitch account sync, scheduled VOD processing or direct publishing is included.",
      "Fast gameplay, tiny webcam windows and loud streams can still require manual framing and subtitle review.",
    ],
    questions: [
      {
        question: "Does ClipClap connect to my Twitch account?",
        answer:
          "No. Paste a Twitch URL or upload a VOD file you have permission to use. This keeps the workflow explicit but does not monitor your channel automatically.",
      },
      {
        question: "Is the free output watermarked?",
        answer:
          "The one-time 40-minute source allowance produces clips without a watermark and does not require a card. Review the results before choosing a paid plan.",
      },
    ],
    relatedSlugs: [
      "ai-video-clipper",
      "youtube-to-shorts",
      "eklipse-alternative",
    ],
    lastModified: "2026-09-20",
  },
  {
    slug: "youtube-to-shorts",
    path: "/youtube-to-shorts",
    primaryKeyword: "YouTube to Shorts",
    title: "YouTube to Shorts Converter with AI | ClipClap",
    description:
      "Convert a YouTube video you can reuse into vertical Shorts with AI-selected moments and subtitles. Try 40 source minutes free in ClipClap.",
    breadcrumb: "YouTube to Shorts",
    eyebrow: "From YouTube video to Shorts",
    h1: "YouTube to Shorts Converter With AI",
    intro:
      "YouTube to Shorts conversion is useful when the source is long but the audience needs one clear moment. ClipClap imports a permitted video, finds highlights and returns subtitled vertical clips.",
    summary:
      "Make review-ready Shorts from a YouTube video you own or can reuse.",
    ctaLabel: "Make YouTube Shorts",
    ctaHref: BROWSER_CTA,
    proofPoints: [
      { label: "Import", value: "Paste a YouTube link or upload a file" },
      { label: "Format", value: "Vertical 9:16 clips ready to review" },
      { label: "Captions", value: "Burned-in subtitles included" },
    ],
    workflow: [
      {
        title: "Use a video you can publish",
        text: "Paste a YouTube URL or upload a copy you own or have permission to reuse. A successful import does not change the video's copyright or publishing rights.",
      },
      {
        title: "Let the transcript surface moments",
        text: "ClipClap transcribes the source, identifies candidate highlights and cuts them into short vertical videos instead of making you scrub through the full recording manually.",
      },
      {
        title: "Review, download and upload",
        text: "Check the first seconds, ending, crop and subtitles. Download the clips that represent the source accurately, then add them to YouTube Shorts from your own channel workflow.",
      },
    ],
    limitations: [
      "ClipClap does not publish to YouTube, schedule Shorts or guarantee that a clip will receive views.",
      "Link imports can fail when a platform blocks access; when that happens, upload a file you are allowed to process.",
    ],
    questions: [
      {
        question: "Can I convert someone else's YouTube video?",
        answer:
          "Only when you own the rights or have permission to reuse it. ClipClap helps prepare the file; it does not grant permission to republish another creator's work.",
      },
      {
        question: "How many free minutes do I get?",
        answer:
          "ClipClap includes 40 source minutes once per account, with no card required and no watermark on the free clips. The allowance is based on source video, not exported clip length.",
      },
    ],
    relatedSlugs: [
      "ai-video-clipper",
      "podcast-to-shorts",
      "opus-clip-alternative",
    ],
    lastModified: "2026-09-20",
  },
  {
    slug: "telegram-video-clipper",
    path: "/telegram-video-clipper",
    primaryKeyword: "Telegram video clipper",
    title: "Telegram Video Clipper for Long Videos | ClipClap",
    description:
      "Send a YouTube, Twitch or TikTok link to a Telegram video clipper and get subtitled vertical clips back. Try ClipClap with 40 free minutes.",
    breadcrumb: "Telegram video clipper",
    eyebrow: "Clip from the chat",
    h1: "Telegram Video Clipper for Long Videos",
    intro:
      "A Telegram video clipper is useful when the whole workflow needs to happen on your phone. Send ClipClap a supported link or file, receive vertical clips with subtitles in the chat, then review before posting.",
    summary:
      "Send a link or file in Telegram and receive subtitled vertical clips back.",
    ctaLabel: "Open ClipClap in Telegram",
    ctaHref: TELEGRAM_BOT,
    proofPoints: [
      { label: "Send", value: "A YouTube, Twitch or TikTok link, or a file" },
      { label: "Receive", value: "Vertical subtitled clips in the same chat" },
      { label: "Try", value: "40 source minutes, no card or watermark" },
    ],
    workflow: [
      {
        title: "Open the ClipClap bot",
        text: "Start the bot from Telegram and send a link or upload a video you own or have permission to use. The chat is the input surface, so no separate editor is required to begin.",
      },
      {
        title: "Wait while the video is processed",
        text: "ClipClap transcribes the audio, selects candidate moments, reframes the video and adds burned-in subtitles. Processing time depends on the source and queue.",
      },
      {
        title: "Review the returned clips",
        text: "Play the clips in Telegram, check the opening, ending, framing and subtitle names, and save only the files you want to publish.",
      },
    ],
    limitations: [
      "The bot does not publish to TikTok, Reels or YouTube for you; it delivers files for your review.",
      "A two-hour podcast can exceed the one-time free allowance, and a blocked link may need a direct file upload instead.",
    ],
    questions: [
      {
        question: "Do I need a separate app or account?",
        answer:
          "You need Telegram to use the bot workflow. ClipClap also has a browser version when you prefer a larger upload and review surface.",
      },
      {
        question: "How is this different from the Telegram bot comparison?",
        answer:
          "This page explains the ClipClap workflow. The Telegram video clipper bots guide compares ClipClap with other bots and documents the dated evidence behind that comparison.",
      },
    ],
    relatedSlugs: [
      "ai-video-clipper",
      "telegram-video-clipper-bots",
      "ai-clipping-tools-compared",
    ],
    lastModified: "2026-09-20",
  },
] as const satisfies readonly SeoLandingPage[];
