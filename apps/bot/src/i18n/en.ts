import type { JobErrorCode } from "@clipclap/shared";
import type { Dict } from "./types";

/** Keyed by the full JobErrorCode union so adding a code to the shared list is
 *  a compile error here until this locale has a string for it - which is what
 *  the job-error module promises consumers. A nested ternary silently fell
 *  through to the generic line instead.
 *
 *  The lookup still falls back at runtime: the bot and @clipclap/shared are
 *  built separately, so a deploy can pair a fresh shared that tags a brand-new
 *  code with a bot binary whose dictionary predates it. An index miss there
 *  would hand grammY an undefined message text and the user would hear nothing
 *  at all about the failed job. */
const enFailure: Record<JobErrorCode, string> = {
  UNSUPPORTED_INPUT:
    "This file has no video track - only sound. Send a video file and I'll clip it.",
  // Same rule as enFailureGeneric, for the same reason: all this code knows is
  // that the failure was in analysis. It is written on attempt 1 of 3 and on
  // the last burned one alike, so "I'm retrying automatically" is a promise it
  // cannot keep, and "send it again in a few minutes" invites a second job -
  // and a second charge - for a video whose first attempt may still heal and
  // deliver. So: no cause named, no outcome asserted, and the imperative spent
  // on not paying twice.
  ANALYSIS_UNAVAILABLE:
    "I could not work out which moments to clip from this video, and your minutes were not used. I cannot tell yet whether this one will finish - wait a few minutes to see if the clips arrive before sending it again, so the same video does not use your minutes twice. If nothing arrives by then, send it again or send a different file.",
  // Hedged on purpose: a non-zero yt-dlp exit does not say why, so the copy
  // names no cause as fact and leads with the remedy that always works.
  SOURCE_UNAVAILABLE:
    "I could not download the video from that link - it may be private, region-locked, removed, or temporarily unavailable. Check that the link opens in a browser, or send me the file directly. Your minutes were not used.",
  // Not hedged, unlike SOURCE_UNAVAILABLE: yt-dlp measured the file and said in
  // as many words that it was over the cap, so the cause is stated and the
  // number is quoted - "too large" alone gives a clipper with a 6-hour VOD
  // nothing to act on. It also has to take back the sibling's remedy: the same
  // 2 GB is my own Telegram ceiling (TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES in
  // handlers.ts) and the plan upload cap, so "send me the file directly" would
  // send the user off to fail a second time.
  SOURCE_TOO_LARGE:
    "That video is over my 2 GB limit, so I could not download it. Your minutes were not used. Sending me the file will not help - the same 2 GB limit applies - so trim the video to the part you want clipped and send that instead.",
  // The one line here that can say the allowance is intact and mean it: the
  // download stage refunds the reservation before marking the job failed. No
  // number - /account shows the real balance - and both exits named, because a
  // clipper whose VOD overruns the remaining free minutes can act on either but
  // will guess neither.
  FREE_ALLOWANCE_EXCEEDED:
    "This video is longer than the free minutes you have left, so I stopped before processing it. Your free minutes are still there - clip a shorter video with them, or pick a plan to run this one in full.",
};

// The "unknown failure" line, so it may assert neither transience nor
// permanence - both are live when it is sent. It covers permanent failures
// (undecodable codec, transcript below the coverage floor, or the last of the 3
// BullMQ attempts already burned), where "I'm retrying, resend in a few
// minutes" is false and loops the user. It equally covers attempt 1 of 3,
// because markJobFailed writes FAILED on every attempt - and there "try sending
// it again" is false too: the original heals on attempt 2, the re-send is a
// second job, and usage.service bills both. So: state the outcome as unknown
// and spend the imperative on not paying twice.
//
// "wait a few minutes to see if the clips arrive" is a promise the product now
// keeps: a delivery is parked in FAILURE_NOTIFIED rather than FAILED, and
// getPendingTelegramDeliveries re-picks it the moment the job reaches DONE
// (packages/shared/src/services/telegram-delivery.service.ts). Before that, a
// healed job was billed and silently never delivered, which made this sentence
// the worst kind of copy - the one that talks a user out of the only action
// that would have got them their clips. If that pickup is ever removed, this
// line has to go with it.
//
// The second half of the promise is in deliverReadyTelegramJobs: a delivery
// that throws before a clip reaches the chat - a locale read, a signed URL, a
// 429 on this very message - leaves the row where it is instead of closing it,
// so the re-pick above still has something to pick up. Both halves are needed
// for this sentence to be true.
const enFailureGeneric =
  "Something went wrong while processing this video and your minutes were not used. I cannot tell yet whether this one will finish - wait a few minutes to see if the clips arrive before sending it again, so the same video does not use your minutes twice. If nothing arrives by then, send it again or send a different file.";

const en: Dict = {
  welcomeFirstScreen:
    "Hi! Send me a long video - or a link to one - and I'll cut it into vertical clips with subtitles, ready for TikTok, Reels and Shorts.\n\nWorks with podcasts, Twitch streams, interviews, webinars and reviews.\n\nYour first video is free - no card, no plan. If it comes back with no clips, it doesn't count.",
  welcomeBack: "Welcome back! Send a video and I'll generate clips.",
  menuTitle: "Main menu",
  welcomeNeedsPlan:
    "Send a video and I'll generate clips. A new account gets one free run - no card needed, up to 60 minutes of video.",
  // Appended by the handler to the onboarding screens, and only while
  // freeBudgetStatus() reports the month's ceiling closed. See the note on
  // freeRunsPausedNote in types.ts for why the promise above is left intact
  // rather than rewritten.
  freeRunsPausedNote:
    "⏳ One thing before you start: free runs are paused until the first of next month. That is a limit on my side, not on your account - your free minutes stay waiting for you. If you want clips today, open 💳 Plans.",
  linkAccountInstructions: (code, url) =>
    `Your linking code: ${code}\n\n1. Open ${url}/dashboard/settings on the device where you're logged in.\n2. Paste this code within 10 minutes.\n\nThis Telegram will be connected to that account.`,
  callbackAck: "Got it",
  linkCodePrompt: (code, url) =>
    `Your linking code: ${code}\n\nOpen ${url}/dashboard/settings, paste it within 10 minutes, and your Telegram will be connected to your ClipClap account.`,
  linkSuccess: (n) =>
    n > 0
      ? `Telegram connected. Imported ${n} clip${n === 1 ? "" : "s"} from your bot history.`
      : "Telegram connected to your account.",
  linkAlready: "This Telegram is already connected to your account.",
  linkInvalid: "Linking code is invalid.",
  linkExpired: "Linking code expired. Generate a new one on clipclap.io/dashboard/settings.",
  linkConflict:
    "Your ClipClap account is already linked to a different Telegram. Unlink it on the site first.",
  linkWrongDirection:
    "This code can't be used here. Use /link to get a new one for this Telegram.",
  sendVideoHint:
    "Send me a video and I'll turn it into vertical clips. Use /start to get going.",
  uploading: "Uploading your video...",
  queued: "Queued. I'll send the clips back here when rendering finishes.",
  progressTitle: "🎬 Working on your video",
  progressQueuedNote: "In the queue - starting any moment.",
  progressStepDownload: "Getting the video",
  progressStepTranscribe: "Listening to the speech",
  progressStepAnalyze: "Finding the best moments",
  progressStepRender: "Cutting and adding subtitles",
  fileTooLarge: (url) =>
    `This video is over 20 MB - Telegram's Bot API limit. For now, upload longer videos on the website: ${url}/dashboard. We're working on lifting this limit soon.`,
  processingFailed: (code) => (code && enFailure[code]) || enFailureGeneric,
  done: (n) => `Done. ${n} clip${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} ready.`,
  donePartial: (sent, total) =>
    `Sent ${sent} of ${total} clips - something went wrong before the rest could be delivered. All ${total} are ready in your dashboard.`,
  deliveryGivenUp: (url, clips) => {
    if (clips === 0) {
      return `I could not deliver the result of this video to this chat and have stopped trying. Open ${url}/dashboard to see how it ended - nothing is lost. Don't send this video again before you have looked there: processing it a second time would use your minutes twice.`;
    }
    const them = clips === 1 ? "it" : "them";
    return `${clips === 1 ? "Your clip is" : `All ${clips} clips are`} ready, but I could not send ${them} to this chat and have stopped trying. Nothing is lost - open ${url}/dashboard to watch or download ${them}. Don't send this video again: the clips already exist, and processing it a second time would use your minutes twice.`;
  },
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Done, but I could not find usable speech in this video - no clips this time."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Done, but part of the video could not be processed and no strong moments were found in the rest."
        : "Done. I watched the whole video but did not find moments strong enough for clips - no clips this time. Try a video with more talk, emotion, or story.",
  lowQualityNote: "Heads up: no strong moments found - this is the best available.",
  blocked: (reason) => `${reason}\n\n💳 Plans - choose or manage your subscription.`,
  freeExhausted: (remainingMinutes, lifetimeMinutes, planMinutes, planPriceEur) =>
    `Your free minutes will not cover this - ${remainingMinutes} of ${lifetimeMinutes} left. Anything I already made for you is yours to keep.\n\nTo carry on: Starter is €${planPriceEur} a week for ${planMinutes} minutes of video, sources up to 3 hours, and 20 clips kept for 7 days.`,
  freeNotAnchored: (planMinutes, planPriceEur) =>
    `Your free minutes are not unlocked on this account yet. Write to support from the Help menu and I'll sort it out - or start straight away with Starter: €${planPriceEur} a week for ${planMinutes} minutes of video.`,
  freeBudgetClosed: (planMinutes, planPriceEur) =>
    `Free runs are paused until the first of next month. That is a limit on my side, not on your account - your free minutes are still waiting for you.\n\nIf you want to clip now: Starter is €${planPriceEur} a week for ${planMinutes} minutes of video.`,
  freeSourceTooLong: (freeMaxMinutes, planMaxMinutes) =>
    `Your free run covers videos up to ${freeMaxMinutes} minutes, and this one is longer. Send a shorter video - or a ${freeMaxMinutes}-minute section of this one - to try it free. A plan takes sources up to ${planMaxMinutes} minutes.`,
  planSourceTooLong: (maxMinutes) =>
    `This video is longer than ${maxMinutes} minutes, which is the longest source I can take. Send a shorter cut and I'll clip it.`,
  planNotActive:
    "There is no active subscription on this account, so I cannot process videos yet. Pick a plan and I'll start right away.",
  planCanceled:
    "Your subscription is canceled, so processing is off. Resubscribe and everything carries on from where you left it - your clips are still there.",
  planPeriodEnded:
    "Your paid period has ended, so processing is paused. Renew and I'll pick this video up straight away.",
  planQuotaExceeded: (usedMinutes, limitMinutes, topUpMinutes) =>
    `You have used ${usedMinutes} of your ${limitMinutes} minutes this period, and this video does not fit in what is left.${
      topUpMinutes > 0
        ? ` Your ${topUpMinutes} top-up minutes are not enough for it either.`
        : ""
    } Wait for the period to renew, or top up minutes or move to a bigger plan.`,
  planDailyLimit: (limit) =>
    `You have hit the daily limit of ${limit} videos. It resets at midnight - send this one again then.`,
  planConcurrentLimit: (active, limit) =>
    `I am still working on ${active === 1 ? "your video" : `${active} of your videos`}, and your plan processes ${limit} at a time. Send this one again once that is done - I'll message you when it is.`,
  submitBusy:
    "Something else from your account is still going through. Give it a moment and send this again.",
  langUsage: (options) => `Usage: ${options}.`,
  langSet: "Language set to English.",
  langName: "English",
  langBtn: "🇬🇧 English",
  planStarterWeeklyBtn: "🌱 Starter - €3 / week",
  planStarterBtn: "💎 Starter - €9 / month",
  planPlusBtn: "🚀 Plus - €29 / month",
  planMaxBtn: "👑 Max - €89 / month",
  menuCreate: "🎬 Create clips",
  createPrompt: ({ freeMaxMinutes, planMaxMinutes, maxFileGb }) =>
    `Send me the video - upload the file or paste a link.\n\nUp to ${planMaxMinutes / 60} hours of video, up to ${maxFileGb} GB per file.${
      freeMaxMinutes === null
        ? ""
        : `\nOn the free run: up to ${freeMaxMinutes} minutes.`
    }`,
  menuAccount: "📊 Account",
  menuHelp: "❓ Help",
  menuSettings: "⚙️ Settings",
  menuEarn: "💰 Earn",
  menuPlans: "💳 Plans",
  earnMenuPrompt: "💰 Earn - choose:",
  earnReferralBtn: "🔗 Referral program",
  earnAdvertisersBtn: "🎯 Find advertisers",
  earnAdvertisersSoon:
    "🎯 Find advertisers\n\nIf you have an audience but no advertisers, I can look for them for you - I only take a cut of deals I find.\n\nThis is not open yet. I'm still setting it up, and I'm counting how many people tap this - so tapping it is a vote.",
  plansText:
    "💳 <b>ClipClap Plans</b>\nPay once - start using. Cancel anytime in Tribute.\n\n" +
    "🌱 <b>Starter</b> - €3/wk · €9/mo\n   • 75 min/wk (270 min/mo)\n   • 20 clips stored\n   • 7-day retention\n\n" +
    "🚀 <b>Plus</b> - €29/mo\n   • 1000 min/mo\n   • 150 clips\n   • 30-day retention\n\n" +
    "👑 <b>Max</b> - €89/mo\n   • 3500 min/mo\n   • 1000 clips\n   • 90-day retention\n   • ⚡ priority queue\n\n" +
    "Pick a plan below 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `You're on ${plan} ✅ Active until ${periodEnd}.\nManage or cancel your subscription in Tribute.`
      : `You're on ${plan} ✅\nManage or cancel your subscription in Tribute.`,
  noPlanNudge: "👉 Tap 💳 Plans to subscribe.",
  helpText: (url) =>
    `Send me a video - I'll cut it into vertical clips with subtitles.\nYou can also paste a URL (YouTube, Twitch, TikTok, Vimeo, X and more).\n\nLimits: up to 3 hours source, up to 2 GB file size.\n\nCommands:\n• /start - main menu\n• /link - connect an existing clipclap.io account\n• /referral - your referral link & earnings\n• /lang - switch language\n\nWebsite: ${url}/dashboard`,
  helpMenuPrompt: "❓ Help - choose:",
  helpHowBtn: "❓ How it works",
  helpSupportBtn: "💬 Support",
  supportPrompt:
    "Write your message - we'll pass it to support and reply right here.",
  supportCloseBtn: "⬅️ Close chat",
  supportClosed: "Chat closed. Send a video anytime to make clips.",
  supportReplyPrefix: "💬 Support:",
  supportUnavailable: "Support is temporarily unavailable. Please try again later.",
  supportVideoInSession:
    '⚠️ You\'re in the support chat right now.\n\n• To make a clip - tap "⬅️ Close chat" below and send the video again.\n• To describe your issue - send text or a screenshot.',
  supportMediaUnsupported:
    "Couldn't send that. Send a screenshot or describe it in text.",
  accountText: ({
    plan,
    billingCycleLabel,
    periodEnd,
    daysUntilPeriodEnd,
    phase,
    minutesUsed,
    minutesLimit,
    topUpMinutes,
    clipsStored,
    storageClipsLimit,
    retentionDays,
    clipsTotal,
  }) => {
    if (plan === "NONE" || phase === "NONE") {
      return `Plan: no active plan\n\nPick a plan to start clipping.\nTotal clips created: ${clipsTotal}`;
    }
    const planLabel = `${plan}${billingCycleLabel ? ` (${billingCycleLabel})` : ""}`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `Plan: ${planLabel} - ended${periodEnd ? ` ${periodEnd}` : ""}`;
      renewLine = "Renew to keep clipping.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `Plan: ${planLabel} - canceled`;
      renewLine = "Resubscribe to keep clipping.";
    } else {
      planLine = `Plan: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (today)"
            : ` (in ${daysUntilPeriodEnd} day${daysUntilPeriodEnd === 1 ? "" : "s"})`;
      renewLine = periodEnd ? `Renews: ${periodEnd}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${renewLine ? `${renewLine}\n` : ""}Payment issue - please update your payment method.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Minutes: ${minutesUsed} / ${minutesLimit} this period (${minutesLeft} left)`;
    const topUpLine = topUpMinutes > 0 ? `+ Top-up: ${topUpMinutes} minutes\n` : "";
    const storageLine = `Storage: ${clipsStored} / ${storageClipsLimit} clips (kept for ${retentionDays} days)`;
    const totalLine = `Total clips created: ${clipsTotal}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(/\n\n\n+/g, "\n\n");
  },
  planNone: "no active plan",
  settingsMenuPrompt: "⚙️ Settings",
  settingsLangBtn: "🌐 Language",
  settingsVideoBtn: "🎬 Video settings",
  settingsLinkBtn: "🔗 Link account",
  settingsBackBtn: "⬅️ Menu",
  langMenuPrompt: "Choose your language:",
  videoSettingsPrompt: "🎬 Video settings",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Subtitles: on ✅" : "Subtitles: off ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Subtitles turned on."
      : "Subtitles turned off. New videos won't have burned-in subtitles.",
  // The one screen every single visitor reads, and the only one they read
  // BEFORE deciding whether to press START - so it may not open by asking for
  // money. It used to: step 1 of 3 was "Pick a plan", which also contradicted
  // welcomeFirstScreen one tap later.
  //
  // No plan, no price and no limits here on purpose. "Up to 3 hours" was the
  // PAID ceiling quoted to someone whose free run caps at 60 minutes, and a
  // third number - the 2 GB file cap - lived only in helpText. Those belong in
  // the submit flow, where they are an answer to "what may I send", not a wall
  // in front of a stranger.
  //
  // "Tap START to begin" is gone: Telegram already renders START across the
  // full width, so the line spent the screen's most valuable real estate
  // telling someone to press the only button on it.
  //
  // Telegram supports NO markup in this field - no HTML, no Markdown - so all
  // structure has to come from line breaks. Hard cap 512 chars, asserted per
  // locale in i18n.test.ts.
  //
  // THE LAST LINE IS COUPLED TO FREE_TIER_MONTHLY_BUDGET_USD.
  //
  // This text is static - written once at boot, and it cannot be conditional -
  // while the free run is gated at request time by freeBudgetStatus(), which
  // reads that ceiling and reports the trial CLOSED whenever it is unset or
  // unparseable. So "Your first video is free" is only true while a usable
  // ceiling is configured; without one, this screen promises something that
  // freeRunsPausedNote takes back on the very next tap. It was held out of this
  // copy until the ceiling was set for exactly that reason. If the free tier is
  // ever rolled back, this line comes out in the same commit.
  //
  // "First video" rather than "60 free minutes" is a deliberate simplification:
  // the ledger grants FREE_TIER.lifetimeSeconds = 3600 in total, not per video,
  // so someone who sends a 15-minute source still has 45 minutes left. The
  // phrasing therefore under-promises, which is the safe direction, and it
  // matches welcomeFirstScreen one screen later.
  botDescription:
    "Turn any long video into short viral clips with subtitles - ready for TikTok, Reels and Shorts!\n\nWorks with podcasts, Twitch streams, interviews, webinars and reviews.\n\n1. Send a video or paste a link\n2. AI finds the best moments and creates clips\n3. Get ready-to-post videos right here in Telegram\n\nYour first video is free - no card needed.",
  // Shown on the bot's profile card, in search results, and in the link preview
  // whenever someone forwards t.me/<bot>. It has to stand alone: a person
  // reading it in a search list has no other context and has not opened
  // anything yet.
  //
  // Source types lead on purpose - "podcasts, streams, interviews" is what a
  // clipper scans a search list for, while "long video" is what every rival
  // says. The arrow survives from the old copy because it buys compression
  // inside a 120-char ceiling that a verb would spend.
  //
  // "Send a video to start" is gone for the same reason "Tap START" left
  // botDescription: the profile card already carries a Message button and a
  // search row already opens the bot when tapped, so the instruction spent a
  // fifth of the budget telling someone to do the obvious.
  //
  // "Long ... -> short ..." is load-bearing and may not be dropped for space.
  // A draft that led with the source types alone tested badly on exactly the
  // question that matters here: it left the long-to-short transformation to be
  // INFERRED from the arrow plus the reader's knowledge that a stream runs for
  // hours. That inference is safe for a clipper and unsafe for everyone else,
  // and this string is the one piece of copy with nothing beside it to lean on.
  //
  // Hard cap 120 chars, asserted for every locale in i18n.test.ts.
  botShortDescription:
    "Long podcasts, streams and interviews → short viral clips with subtitles for TikTok, Reels and Shorts.",
  commands: [
    { command: "start", description: "Show main menu" },
    { command: "account", description: "Your plan and stats" },
    { command: "help", description: "Limits and how it works" },
    { command: "settings", description: "Open settings" },
    { command: "lang", description: "Switch language" },
    { command: "link", description: "Connect your clipclap.io account" },
    { command: "referral", description: "Your referral link & earnings" },
  ],
  manageSubscriptionBtn: "🔧 Manage subscription",
  checkingLink: "Checking link…",
  urlAccessFailed:
    "Couldn't access the video at that link. Try a different URL or upload the file directly.",
  urlYouTubeUnavailable:
    "YouTube links don't work right now - YouTube is blocking us, not you, so another YouTube link won't help. Upload the video file here instead, or send a TikTok or Twitch link.",
  referralInfo: (web, tg, earned, pending) =>
    `Your referral links:\nWeb: ${web}\nTelegram: ${tg}\n\nReferral earnings: $${earned}\nPending (14-day hold): $${pending}`,
  referralWithdrawBtn: "💸 Request withdrawal",
  referralWithdrawStub: "You don't have enough funds to withdraw yet.",
  balanceInfo: (available, clearing) =>
    `Wallet balance:\nAvailable: $${available}\nClearing: $${clearing} (commissions still in a 14-day hold)`,
  payBtn: "💳 Pay",
  checkoutReady: (plan) =>
    `Tap "Pay" to subscribe to ${plan}. You'll return to the bot after payment.`,
  checkoutError: "Could not start checkout. Please try again in a moment.",
  cycleWeekly: "weekly",
  cycleMonthly: "monthly",
};

export default en;
