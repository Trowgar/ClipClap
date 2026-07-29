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
  welcomeNew:
    "Welcome to ClipClap! Send me a video and I'll turn it into vertical clips with subtitles.\n\nLanguage: send /lang to switch.",
  welcomeFirstChoice:
    "Hi! I turn long videos into vertical clips with subtitles - ready for TikTok, Reels and Shorts.\n\nYour first video is free - no card, no plan. If it comes back with no clips, it doesn't count.\n\nHow it works:\n1. Send a video (up to 60 minutes on the free run)\n2. I find the strongest moments and cut them\n3. Your clips come back here - up to 10, depending on the video\n\nFirst - how do you want to set up?\n\n• New account - use this Telegram as your ClipClap account.\n• I already have an account - link this Telegram to your existing clipclap.io account.",
  welcomeBack: "Welcome back! Send a video and I'll generate clips.",
  welcomeNeedsPlan:
    "Send a video and I'll generate clips. A new account gets one free run - no card needed, up to 60 minutes of video.",
  newAccountBtn: "✨ Create new account",
  linkAccountBtn: "🔗 I already have an account",
  newAccountCreated:
    "Account created. Send a video now - the first one is free, no card needed.\n\nUp to 60 minutes. If it comes back with no clips, it doesn't count against your free run.",
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
  langUsage: (options) => `Usage: ${options}.`,
  langSet: "Language set to English.",
  langName: "English",
  langBtn: "🇬🇧 English",
  planStarterWeeklyBtn: "🌱 Starter - €3 / week",
  planStarterBtn: "💎 Starter - €9 / month",
  planPlusBtn: "🚀 Plus - €29 / month",
  planMaxBtn: "👑 Max - €89 / month",
  menuAccount: "📊 Account",
  menuHelp: "❓ Help",
  menuSettings: "⚙️ Settings",
  menuAffiliate: "🤝 Affiliate",
  menuPlans: "💳 Plans",
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
  settingsBackBtn: "⬅️ Menu",
  langMenuPrompt: "Choose your language:",
  videoSettingsPrompt: "🎬 Video settings",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Subtitles: on ✅" : "Subtitles: off ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Subtitles turned on."
      : "Subtitles turned off. New videos won't have burned-in subtitles.",
  menuHint: "Tap the menu buttons below for quick actions.",
  botDescription:
    "ClipClap turns long videos into short vertical clips with subtitles - ready for TikTok, Reels and Shorts.\n\nSend a video (up to 3 hours) - I'll find the highlights, cut them and burn in subtitles automatically.\n\nHow it works:\n1. Pick a plan\n2. Send a video\n3. Receive your clips\n\nTap START to begin.",
  botShortDescription:
    "Long video → vertical clips with subtitles. Send a video to start.",
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
  editInBrowserBtn: "✂️ Edit in browser",
  checkingLink: "Checking link…",
  urlAccessFailed:
    "Couldn't access the video at that link. Try a different URL or upload the file directly.",
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
