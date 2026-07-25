import type { JobErrorCode, SubscriptionPhase } from "@clipclap/shared";

export type Locale = "en" | "ru";

export function detectLocale(languageCode?: string | null): Locale {
  if (languageCode?.toLowerCase().startsWith("ru")) return "ru";
  return "en";
}

export type LangChoice = "en" | "ru";

export function parseLangCommand(text: string): LangChoice | "usage" | null {
  if (!/^\/lang(@\S+)?(\s|$)/.test(text)) return null;
  const arg = text
    .replace(/^\/lang(@\S+)?\s*/, "")
    .trim()
    .toLowerCase();
  if (!arg) return "usage";
  if (arg === "en" || arg === "english" || arg === "англ" || arg === "английский") return "en";
  if (arg === "ru" || arg === "russian" || arg === "рус" || arg === "русский") return "ru";
  return "usage";
}

export interface Dict {
  welcomeNew: string;
  welcomeFirstChoice: string;
  welcomeBack: string;
  welcomeNeedsPlan: string;
  newAccountBtn: string;
  linkAccountBtn: string;
  newAccountCreated: string;
  linkAccountInstructions: (code: string, url: string) => string;
  callbackAck: string;
  linkCodePrompt: (code: string, url: string) => string;
  linkSuccess: (mergedClips: number) => string;
  linkAlready: string;
  linkInvalid: string;
  linkExpired: string;
  linkConflict: string;
  linkWrongDirection: string;
  sendVideoHint: string;
  uploading: string;
  queued: string;
  fileTooLarge: (url: string) => string;
  /** Takes the code parsed out of Job.error, NEVER the raw message: the stored
   *  text is engineer prose in English and must not reach a user. Unknown or
   *  untagged (null) falls back to the generic line. */
  processingFailed: (code: JobErrorCode | null) => string;
  done: (n: number) => string;
  doneNoClips: (reason: string) => string;
  lowQualityNote: string;
  blocked: (reason: string) => string;
  langUsage: string;
  langSetEn: string;
  langSetRu: string;
  planStarterWeeklyBtn: string;
  planStarterBtn: string;
  planPlusBtn: string;
  planMaxBtn: string;
  menuAccount: string;
  menuHelp: string;
  menuSettings: string;
  menuAffiliate: string;
  menuPlans: string;
  plansText: string;
  plansSubscribed: (plan: string, periodEnd: string | null) => string;
  noPlanNudge: string;
  helpText: (url: string) => string;
  helpMenuPrompt: string;
  helpHowBtn: string;
  helpSupportBtn: string;
  supportPrompt: string;
  supportCloseBtn: string;
  supportClosed: string;
  supportReplyPrefix: string;
  supportUnavailable: string;
  supportVideoInSession: string;
  supportMediaUnsupported: string;
  accountText: (params: {
    plan: string;
    billingCycle: string | null;
    periodEnd: string | null;
    daysUntilPeriodEnd: number | null;
    phase?: SubscriptionPhase;
    minutesUsed: number;
    minutesLimit: number;
    topUpMinutes: number;
    clipsStored: number;
    storageClipsLimit: number;
    retentionDays: number;
    clipsTotal: number;
  }) => string;
  planNone: string;
  settingsMenuPrompt: string;
  settingsLangBtn: string;
  settingsVideoBtn: string;
  settingsBackBtn: string;
  langMenuPrompt: string;
  videoSettingsPrompt: string;
  subtitlesToggleBtn: (enabled: boolean) => string;
  subtitlesAck: (enabled: boolean) => string;
  menuHint: string;
  botDescription: string;
  botShortDescription: string;
  commands: Array<{ command: string; description: string }>;
  langBtnEn: string;
  langBtnRu: string;
  manageSubscriptionBtn: string;
  editInBrowserBtn: string;
  checkingLink: string;
  urlAccessFailed: string;
  referralInfo: (web: string, tg: string, earned: string, pending: string) => string;
  referralWithdrawBtn: string;
  referralWithdrawStub: string;
  balanceInfo: (available: string, clearing: string) => string;
  payBtn: string;
  checkoutReady: (plan: string) => string;
  checkoutError: string;
  cycleWeekly: string;
  cycleMonthly: string;
}

const en: Dict = {
  welcomeNew:
    "Welcome to ClipClap! Send me a video and I'll turn it into vertical clips with subtitles.\n\nLanguage: /lang ru - switch to Russian.",
  welcomeFirstChoice:
    "Hi! I turn long videos into vertical clips with subtitles - ready for TikTok, Reels and Shorts.\n\nHow it works:\n1. Pick a plan\n2. Send a video (up to 3 hours)\n3. Get back the strongest short clips (up to 12 - depends on the video)\n\nFirst - how do you want to set up?\n\n• New account - use this Telegram as your ClipClap account.\n• I already have an account - link this Telegram to your existing clipclap.io account.",
  welcomeBack: "Welcome back! Send a video and I'll generate clips.",
  welcomeNeedsPlan:
    "Send a video and I'll generate clips. To enable processing, tap 💳 Plans and pick a plan.",
  newAccountBtn: "✨ Create new account",
  linkAccountBtn: "🔗 I already have an account",
  newAccountCreated:
    "Account created. Send a video here and I'll start clipping.\n\nTo enable processing, tap 💳 Plans and pick a plan.",
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
  processingFailed: (code) =>
    code === "UNSUPPORTED_INPUT"
      ? "This file has no video track - only sound. Send a video file and I'll clip it."
      : code === "ANALYSIS_UNAVAILABLE"
        ? "Could not analyze this video right now - a temporary problem on our side. I'm retrying automatically and your minutes were not used. If nothing arrives, send it again in a few minutes."
        : "Something went wrong while processing this video. I'm retrying automatically and your minutes were not used. If nothing arrives, send it again in a few minutes.",
  done: (n) => `Done. ${n} clip${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} ready.`,
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Done, but I could not find usable speech in this video - no clips this time."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Done, but part of the video could not be processed and no strong moments were found in the rest."
        : "Done. I watched the whole video but did not find moments strong enough for clips - no clips this time. Try a video with more talk, emotion, or story.",
  lowQualityNote: "Heads up: no strong moments found - this is the best available.",
  blocked: (reason) => `${reason}\n\n💳 Plans - choose or manage your subscription.`,
  langUsage: "Usage: /lang en - English, /lang ru - Russian.",
  langSetEn: "Language set to English.",
  langSetRu: "Язык установлен: русский.",
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
    `Send me a video - I'll cut it into vertical clips with subtitles.\nYou can also paste a URL (YouTube, Twitch, TikTok, Vimeo, X and more).\n\nLimits: up to 3 hours source, up to 2 GB file size.\n\nCommands:\n• /start - main menu\n• /link - connect an existing clipclap.io account\n• /referral - your referral link & earnings\n• /lang en|ru - switch language\n\nWebsite: ${url}/dashboard`,
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
    billingCycle,
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
    const planLabel = `${plan}${billingCycle ? ` (${billingCycle})` : ""}`;
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
  langBtnEn: "🇬🇧 English",
  langBtnRu: "🇷🇺 Русский",
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

const ru: Dict = {
  welcomeNew:
    "Привет! Это ClipClap. Пришли видео - нарежу вертикальные клипы с субтитрами.\n\nЯзык: /lang en - переключиться на английский.",
  welcomeFirstChoice:
    "Привет! Нарезаю длинные видео на вертикальные клипы с субтитрами - для TikTok, Reels и Shorts.\n\nКак это работает:\n1. Выбери тариф\n2. Пришли видео (до 3 часов)\n3. Получи самые сильные короткие клипы (до 12 - зависит от видео)\n\nСначала - как тебе удобнее начать?\n\n• Новый аккаунт - Telegram станет твоим аккаунтом ClipClap.\n• Уже есть аккаунт - привяжем этот Telegram к существующему аккаунту на clipclap.io.",
  welcomeBack: "С возвращением! Пришли видео - сделаю клипы.",
  welcomeNeedsPlan:
    "Пришли видео - сделаю клипы. Чтобы запустить обработку, нажми 💳 Тарифы и выбери план.",
  newAccountBtn: "✨ Создать новый аккаунт",
  linkAccountBtn: "🔗 У меня уже есть аккаунт",
  newAccountCreated:
    "Аккаунт создан. Пришли видео - начну нарезку.\n\nЧтобы запустить обработку, нажми 💳 Тарифы и выбери план.",
  linkAccountInstructions: (code, url) =>
    `Код привязки: ${code}\n\n1. Открой ${url}/dashboard/settings на устройстве, где ты залогинен.\n2. Вставь код в течение 10 минут.\n\nЭтот Telegram привяжется к тому аккаунту.`,
  callbackAck: "Принято",
  linkCodePrompt: (code, url) =>
    `Код привязки: ${code}\n\nОткрой ${url}/dashboard/settings и введи код в течение 10 минут - Telegram привяжется к твоему аккаунту ClipClap.`,
  linkSuccess: (n) =>
    n > 0
      ? `Telegram привязан. Перенёс ${n} ${pluralizeRu(n, "клип", "клипа", "клипов")} из истории бота.`
      : "Telegram привязан к аккаунту.",
  linkAlready: "Этот Telegram уже привязан к твоему аккаунту.",
  linkInvalid: "Код привязки невалидный.",
  linkExpired:
    "Код истёк. Сгенерируй новый на clipclap.io/dashboard/settings.",
  linkConflict:
    "Твой аккаунт ClipClap уже привязан к другому Telegram. Сначала отвяжи его на сайте.",
  linkWrongDirection:
    "Этот код здесь не сработает. Набери /link, чтобы получить новый для этого Telegram.",
  sendVideoHint:
    "Пришли видео - нарежу вертикальные клипы. /start, если ещё не подключал аккаунт.",
  uploading: "Загружаю видео...",
  queued: "В очереди. Пришлю клипы сюда, когда рендер закончится.",
  fileTooLarge: (url) =>
    `Видео больше 20 МБ - это лимит Telegram Bot API. Пока что для длинных видео используй сайт: ${url}/dashboard. Скоро снимем это ограничение.`,
  processingFailed: (code) =>
    code === "UNSUPPORTED_INPUT"
      ? "В этом файле нет видеодорожки - только звук. Пришли видеофайл, и я нарежу клипы."
      : code === "ANALYSIS_UNAVAILABLE"
        ? "Не получилось проанализировать это видео - временная проблема на нашей стороне. Пробую автоматически ещё раз, минуты не списаны. Если ничего не придёт, пришли видео снова через несколько минут."
        : "Что-то пошло не так при обработке видео. Пробую автоматически ещё раз, минуты не списаны. Если ничего не придёт, пришли видео снова через несколько минут.",
  done: (n) =>
    `Готово. ${n} ${pluralizeRu(n, "клип", "клипа", "клипов")} ${pluralizeRu(n, "готов", "готовы", "готовы")}.`,
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Готово, но в этом видео не нашлось пригодной речи - клипов не будет."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Готово, но часть видео не удалось обработать, а в остальном сильных моментов не нашлось."
        : "Готово. Я просмотрел всё видео, но не нашёл достаточно сильных моментов - клипов в этот раз нет. Попробуй видео с большим количеством речи, эмоций или истории.",
  lowQualityNote: "Внимание: сильных моментов не нашлось - это лучшее из доступного.",
  blocked: (reason) => `${reason}\n\n💳 Тарифы - выбрать или управлять подпиской.`,
  langUsage: "Использование: /lang ru - русский, /lang en - английский.",
  langSetEn: "Language set to English.",
  langSetRu: "Язык установлен: русский.",
  planStarterWeeklyBtn: "🌱 Starter - €3 / неделя",
  planStarterBtn: "💎 Starter - €9 / мес",
  planPlusBtn: "🚀 Plus - €29 / мес",
  planMaxBtn: "👑 Max - €89 / мес",
  menuAccount: "📊 Аккаунт",
  menuHelp: "❓ Помощь",
  menuSettings: "⚙️ Настройки",
  menuAffiliate: "🤝 Рефералы",
  menuPlans: "💳 Тарифы",
  plansText:
    "💳 <b>Тарифы ClipClap</b>\nОплатил - пользуешься. Отменить можно в любой момент в Tribute.\n\n" +
    "🌱 <b>Starter</b> - €3/нед · €9/мес\n   • 75 мин/нед (270 мин/мес)\n   • 20 клипов в хранилище\n   • хранение 7 дней\n\n" +
    "🚀 <b>Plus</b> - €29/мес\n   • 1000 мин/мес\n   • 150 клипов\n   • хранение 30 дней\n\n" +
    "👑 <b>Max</b> - €89/мес\n   • 3500 мин/мес\n   • 1000 клипов\n   • хранение 90 дней\n   • ⚡ приоритетная очередь\n\n" +
    "Выбери план ниже 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `Ты на плане ${plan} ✅ Активен до ${periodEnd}.\nУправление и отмена - в Tribute.`
      : `Ты на плане ${plan} ✅\nУправление и отмена - в Tribute.`,
  noPlanNudge: "👉 Нажми 💳 Тарифы, чтобы оформить подписку.",
  helpText: (url) =>
    `Пришли видео - нарежу вертикальные клипы с субтитрами.\nМожно также прислать ссылку (YouTube, Twitch, TikTok, Vimeo, X и др.).\n\nЛимиты: до 3 часов исходник, до 2 ГБ размер файла.\n\nКоманды:\n• /start - главное меню\n• /link - привязать существующий аккаунт clipclap.io\n• /referral - реферальная ссылка и доход\n• /lang en|ru - сменить язык\n\nСайт: ${url}/dashboard`,
  helpMenuPrompt: "❓ Помощь - выбери:",
  helpHowBtn: "❓ Как это работает",
  helpSupportBtn: "💬 Поддержка",
  supportPrompt: "Напиши сообщение - передадим в поддержку, ответим здесь же.",
  supportCloseBtn: "⬅️ Закрыть диалог",
  supportClosed: "Диалог закрыт. Пришли видео - нарежу клипы.",
  supportReplyPrefix: "💬 Поддержка:",
  supportUnavailable: "Поддержка временно недоступна. Попробуй позже.",
  supportVideoInSession:
    "⚠️ Ты сейчас в чате поддержки.\n\n• Чтобы сделать клип - нажми «⬅️ Закрыть диалог» внизу и пришли видео снова.\n• Чтобы описать проблему - напиши текстом или пришли скриншот.",
  supportMediaUnsupported:
    "Не удалось переслать это. Пришли скриншот или опиши текстом.",
  accountText: ({
    plan,
    billingCycle,
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
      return `Тариф: нет активного\n\nВыбери тариф, чтобы начать.\nВсего создано: ${clipsTotal} ${pluralizeRu(clipsTotal, "клип", "клипа", "клипов")}`;
    }
    const cycleLabel =
      billingCycle === null
        ? ""
        : billingCycle === "weekly" || billingCycle === "WEEKLY"
          ? " (недельный)"
          : " (месячный)";
    const planLabel = `${plan}${cycleLabel}`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `Тариф: ${planLabel} - истёк${periodEnd ? ` ${periodEnd}` : ""}`;
      renewLine = "Продлите, чтобы продолжить нарезку.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `Тариф: ${planLabel} - отменён`;
      renewLine = "Оформите заново, чтобы продолжить.";
    } else {
      planLine = `Тариф: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (сегодня)"
            : ` (через ${daysUntilPeriodEnd} ${pluralizeRu(daysUntilPeriodEnd, "день", "дня", "дней")})`;
      renewLine = periodEnd ? `Продление: ${periodEnd}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${renewLine ? `${renewLine}\n` : ""}Проблема с оплатой - обновите способ оплаты.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Минуты: ${minutesUsed} / ${minutesLimit} в этом периоде (осталось ${minutesLeft})`;
    const topUpLine =
      topUpMinutes > 0 ? `+ Дополнительно: ${topUpMinutes} минут\n` : "";
    const storageLine = `Хранилище: ${clipsStored} / ${storageClipsLimit} ${pluralizeRu(clipsStored, "клип", "клипа", "клипов")} (хранятся ${retentionDays} ${pluralizeRu(retentionDays, "день", "дня", "дней")})`;
    const totalLine = `Всего создано: ${clipsTotal} ${pluralizeRu(clipsTotal, "клип", "клипа", "клипов")}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(/\n\n\n+/g, "\n\n");
  },
  planNone: "нет активного",
  settingsMenuPrompt: "⚙️ Настройки",
  settingsLangBtn: "🌐 Язык",
  settingsVideoBtn: "🎬 Настройки видео",
  settingsBackBtn: "⬅️ Меню",
  langMenuPrompt: "Выбери язык:",
  videoSettingsPrompt: "🎬 Настройки видео",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Субтитры: вкл ✅" : "Субтитры: выкл ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Субтитры включены."
      : "Субтитры выключены. На новых видео субтитров не будет.",
  menuHint: "Кнопки меню снизу - быстрый доступ к действиям.",
  botDescription:
    "ClipClap нарезает длинные видео на короткие вертикальные клипы с субтитрами - для TikTok, Reels и Shorts.\n\nПришли видео (до 3 часов) - найду самые цепляющие моменты, нарежу и наложу субтитры автоматически.\n\nКак это работает:\n1. Выбери тариф\n2. Пришли видео\n3. Получи клипы\n\nЖми START.",
  botShortDescription:
    "Длинное видео → вертикальные клипы с субтитрами. Пришли видео - нарежу.",
  commands: [
    { command: "start", description: "Главное меню" },
    { command: "account", description: "Тариф и статистика" },
    { command: "help", description: "Лимиты и как работает" },
    { command: "settings", description: "Настройки" },
    { command: "lang", description: "Сменить язык" },
    { command: "link", description: "Привязать аккаунт clipclap.io" },
    { command: "referral", description: "Реферальная ссылка и доход" },
  ],
  langBtnEn: "🇬🇧 English",
  langBtnRu: "🇷🇺 Русский",
  manageSubscriptionBtn: "🔧 Управление подпиской",
  editInBrowserBtn: "✂️ Редактировать в браузере",
  checkingLink: "Проверяю ссылку…",
  urlAccessFailed:
    "Не удалось получить видео по этой ссылке. Попробуй другую ссылку или загрузи файл напрямую.",
  referralInfo: (web, tg, earned, pending) =>
    `Ваши реферальные ссылки:\nСайт: ${web}\nTelegram: ${tg}\n\nЗаработано с рефералов: $${earned}\nВ ожидании (14-дневный холд): $${pending}`,
  referralWithdrawBtn: "💸 Запросить вывод средств",
  referralWithdrawStub: "У вас недостаточно средств для вывода.",
  balanceInfo: (available, clearing) =>
    `Баланс кошелька:\nДоступно: $${available}\nВ обработке: $${clearing} (комиссии ещё в 14-дневном холде)`,
  payBtn: "💳 Оплатить",
  checkoutReady: (plan) =>
    `Нажми «Оплатить», чтобы оформить подписку ${plan}. После оплаты вернёшься в бота.`,
  checkoutError: "Не удалось начать оплату. Попробуй ещё раз через минуту.",
  cycleWeekly: "недельный",
  cycleMonthly: "месячный",
};

const dictionaries: Record<Locale, Dict> = { en, ru };

export function t(locale: Locale): Dict {
  return dictionaries[locale];
}

function pluralizeRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
