export type Locale = "en" | "ru";

export function detectLocale(languageCode?: string | null): Locale {
  if (languageCode?.toLowerCase().startsWith("ru")) return "ru";
  return "en";
}

export type LangChoice = "en" | "ru" | "auto";

export function parseLangCommand(text: string): LangChoice | "usage" | null {
  if (!/^\/lang(@\S+)?(\s|$)/.test(text)) return null;
  const arg = text
    .replace(/^\/lang(@\S+)?\s*/, "")
    .trim()
    .toLowerCase();
  if (!arg) return "usage";
  if (arg === "en" || arg === "english" || arg === "англ" || arg === "английский") return "en";
  if (arg === "ru" || arg === "russian" || arg === "рус" || arg === "русский") return "ru";
  if (arg === "auto" || arg === "авто") return "auto";
  return "usage";
}

export interface Dict {
  welcomeNew: string;
  welcomeFirstChoice: string;
  welcomeBack: string;
  welcomeNeedsPlan: (url: string) => string;
  newAccountBtn: string;
  linkAccountBtn: string;
  newAccountCreated: (url: string) => string;
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
  processingFailed: (error: string) => string;
  done: (n: number) => string;
  blocked: (reason: string, url: string) => string;
  langUsage: string;
  langSetEn: string;
  langSetRu: string;
  langSetAuto: string;
  planStarterWeeklyBtn: string;
  planStarterBtn: string;
  planPlusBtn: string;
  planMaxBtn: string;
  menuPlans: string;
  menuAccount: string;
  menuHelp: string;
  menuLanguage: string;
  helpText: (url: string) => string;
  accountText: (params: {
    plan: string;
    billingCycle: string | null;
    periodEnd: string | null;
    clipsTotal: number;
  }) => string;
  planNone: string;
  languageMenuPrompt: string;
  menuHint: string;
  botDescription: string;
  botShortDescription: string;
  commands: Array<{ command: string; description: string }>;
  langBtnEn: string;
  langBtnRu: string;
  langBtnAuto: string;
}

const en: Dict = {
  welcomeNew:
    "Welcome to ClipClap! Send me a video and I'll turn it into vertical clips with subtitles.\n\nLanguage: /lang ru — switch to Russian.",
  welcomeFirstChoice:
    "Hi! I turn long videos into vertical clips with subtitles — ready for TikTok, Reels and Shorts.\n\nHow it works:\n1. Pick a plan\n2. Send a video (up to 3 hours)\n3. Get 5–15 short clips back\n\nFirst — how do you want to set up?\n\n• New account — use this Telegram as your ClipClap account.\n• I already have an account — link this Telegram to your existing clipclap.io account.",
  welcomeBack: "Welcome back! Send a video and I'll generate clips.",
  welcomeNeedsPlan: (url) =>
    `Send a video and I'll generate clips. To enable processing, pick a plan: ${url}/dashboard/plans`,
  newAccountBtn: "✨ Create new account",
  linkAccountBtn: "🔗 I already have an account",
  newAccountCreated: (url) =>
    `Account created. Send a video here and I'll start clipping.\n\nPick a plan to enable processing: ${url}/dashboard/plans`,
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
    `This video is over 20 MB — Telegram's Bot API limit. For now, upload longer videos on the website: ${url}/dashboard. We're working on lifting this limit soon.`,
  processingFailed: (error) => `Processing failed: ${error}`,
  done: (n) => `Done. ${n} clip${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} ready.`,
  blocked: (reason, url) => `${reason}\n\nManage your plan: ${url}/dashboard/plans`,
  langUsage:
    "Usage: /lang en — English, /lang ru — Russian, /lang auto — follow Telegram language.",
  langSetEn: "Language set to English.",
  langSetRu: "Язык установлен: русский.",
  langSetAuto: "Auto language detection enabled.",
  planStarterWeeklyBtn: "🌱 Starter — $3 / week",
  planStarterBtn: "💎 Starter — $9 / month",
  planPlusBtn: "🚀 Plus — $29 / month",
  planMaxBtn: "👑 Max — $99 / month",
  menuPlans: "💎 Plans",
  menuAccount: "📊 Account",
  menuHelp: "❓ Help",
  menuLanguage: "🌐 Language",
  helpText: (url) =>
    `Send me a video — I'll cut it into vertical clips with subtitles.\n\nLimits: up to 3 hours source, up to 2 GB file size.\n\nCommands:\n• /start — main menu\n• /link — connect an existing clipclap.io account\n• /lang en|ru|auto — switch language\n\nWebsite: ${url}/dashboard`,
  accountText: ({ plan, billingCycle, periodEnd, clipsTotal }) => {
    const planLine = plan === "NONE" ? "Plan: no active plan" : `Plan: ${plan}${billingCycle ? ` (${billingCycle.toLowerCase()})` : ""}`;
    const periodLine = periodEnd ? `\nRenews/expires: ${periodEnd}` : "";
    return `${planLine}${periodLine}\nClips created: ${clipsTotal}`;
  },
  planNone: "no active plan",
  languageMenuPrompt: "Pick a language:",
  menuHint: "Tap the menu buttons below for quick actions.",
  botDescription:
    "ClipClap turns long videos into short vertical clips with subtitles — ready for TikTok, Reels and Shorts.\n\nSend a video (up to 3 hours) — I'll find the highlights, cut them and burn in subtitles automatically.\n\nHow it works:\n1. Pick a plan\n2. Send a video\n3. Receive your clips\n\nTap START to begin.",
  botShortDescription:
    "Long video → vertical clips with subtitles. Send a video to start.",
  commands: [
    { command: "start", description: "Show main menu" },
    { command: "plans", description: "Choose a subscription" },
    { command: "account", description: "Your plan and stats" },
    { command: "help", description: "Limits and how it works" },
    { command: "lang", description: "Switch language" },
    { command: "link", description: "Connect your clipclap.io account" },
  ],
  langBtnEn: "🇬🇧 English",
  langBtnRu: "🇷🇺 Русский",
  langBtnAuto: "🤖 Auto-detect",
};

const ru: Dict = {
  welcomeNew:
    "Привет! Это ClipClap. Пришли видео — нарежу вертикальные клипы с субтитрами.\n\nЯзык: /lang en — переключиться на английский.",
  welcomeFirstChoice:
    "Привет! Нарезаю длинные видео на вертикальные клипы с субтитрами — для TikTok, Reels и Shorts.\n\nКак это работает:\n1. Выбери тариф\n2. Пришли видео (до 3 часов)\n3. Получи 5–15 коротких клипов\n\nСначала — как тебе удобнее начать?\n\n• Новый аккаунт — Telegram станет твоим аккаунтом ClipClap.\n• Уже есть аккаунт — привяжем этот Telegram к существующему аккаунту на clipclap.io.",
  welcomeBack: "С возвращением! Пришли видео — сделаю клипы.",
  welcomeNeedsPlan: (url) =>
    `Пришли видео — сделаю клипы. Чтобы запустить обработку, выбери тариф: ${url}/dashboard/plans`,
  newAccountBtn: "✨ Создать новый аккаунт",
  linkAccountBtn: "🔗 У меня уже есть аккаунт",
  newAccountCreated: (url) =>
    `Аккаунт создан. Пришли видео — начну нарезку.\n\nЧтобы запустить обработку, выбери тариф: ${url}/dashboard/plans`,
  linkAccountInstructions: (code, url) =>
    `Код привязки: ${code}\n\n1. Открой ${url}/dashboard/settings на устройстве, где ты залогинен.\n2. Вставь код в течение 10 минут.\n\nЭтот Telegram привяжется к тому аккаунту.`,
  callbackAck: "Принято",
  linkCodePrompt: (code, url) =>
    `Код привязки: ${code}\n\nОткрой ${url}/dashboard/settings и введи код в течение 10 минут — Telegram привяжется к твоему аккаунту ClipClap.`,
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
    "Пришли видео — нарежу вертикальные клипы. /start, если ещё не подключал аккаунт.",
  uploading: "Загружаю видео...",
  queued: "В очереди. Пришлю клипы сюда, когда рендер закончится.",
  fileTooLarge: (url) =>
    `Видео больше 20 МБ — это лимит Telegram Bot API. Пока что для длинных видео используй сайт: ${url}/dashboard. Скоро снимем это ограничение.`,
  processingFailed: (error) => `Обработка не удалась: ${error}`,
  done: (n) =>
    `Готово. ${n} ${pluralizeRu(n, "клип", "клипа", "клипов")} ${n === 1 ? "готов" : "готовы"}.`,
  blocked: (reason, url) => `${reason}\n\nУправление тарифом: ${url}/dashboard/plans`,
  langUsage:
    "Использование: /lang ru — русский, /lang en — английский, /lang auto — по языку Telegram.",
  langSetEn: "Language set to English.",
  langSetRu: "Язык установлен: русский.",
  langSetAuto: "Авто-определение языка включено.",
  planStarterWeeklyBtn: "🌱 Starter — $3 / неделя",
  planStarterBtn: "💎 Starter — $9 / мес",
  planPlusBtn: "🚀 Plus — $29 / мес",
  planMaxBtn: "👑 Max — $99 / мес",
  menuPlans: "💎 Тарифы",
  menuAccount: "📊 Аккаунт",
  menuHelp: "❓ Помощь",
  menuLanguage: "🌐 Язык",
  helpText: (url) =>
    `Пришли видео — нарежу вертикальные клипы с субтитрами.\n\nЛимиты: до 3 часов исходник, до 2 ГБ размер файла.\n\nКоманды:\n• /start — главное меню\n• /link — привязать существующий аккаунт clipclap.io\n• /lang en|ru|auto — сменить язык\n\nСайт: ${url}/dashboard`,
  accountText: ({ plan, billingCycle, periodEnd, clipsTotal }) => {
    const planLine = plan === "NONE" ? "Тариф: нет активного" : `Тариф: ${plan}${billingCycle ? ` (${billingCycle === "WEEKLY" ? "недельный" : "месячный"})` : ""}`;
    const periodLine = periodEnd ? `\nДо: ${periodEnd}` : "";
    return `${planLine}${periodLine}\nКлипов сделано: ${clipsTotal}`;
  },
  planNone: "нет активного",
  languageMenuPrompt: "Выбери язык:",
  menuHint: "Кнопки меню снизу — быстрый доступ к действиям.",
  botDescription:
    "ClipClap нарезает длинные видео на короткие вертикальные клипы с субтитрами — для TikTok, Reels и Shorts.\n\nПришли видео (до 3 часов) — найду самые цепляющие моменты, нарежу и наложу субтитры автоматически.\n\nКак это работает:\n1. Выбери тариф\n2. Пришли видео\n3. Получи клипы\n\nЖми START.",
  botShortDescription:
    "Длинное видео → вертикальные клипы с субтитрами. Пришли видео — нарежу.",
  commands: [
    { command: "start", description: "Главное меню" },
    { command: "plans", description: "Выбрать тариф" },
    { command: "account", description: "Тариф и статистика" },
    { command: "help", description: "Лимиты и как работает" },
    { command: "lang", description: "Сменить язык" },
    { command: "link", description: "Привязать аккаунт clipclap.io" },
  ],
  langBtnEn: "🇬🇧 English",
  langBtnRu: "🇷🇺 Русский",
  langBtnAuto: "🤖 Авто-определение",
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
