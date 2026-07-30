import type { JobErrorCode } from "@clipclap/shared";
import { plural } from "@clipclap/shared";
import type { Dict } from "./types";

/** Russian-bound convenience over the shared CLDR selector: the arithmetic it
 *  used to do by hand now comes from ICU, and every other language gets the
 *  same treatment by calling `plural(<its code>, ...)` with its own categories.
 *  `other` repeats `many` because Russian only selects it for fractions, which
 *  no counter in this file produces. */
function pluralizeRu(n: number, one: string, few: string, many: string): string {
  return plural("ru", n, { one, few, many, other: many });
}

const ruFailure: Record<JobErrorCode, string> = {
  UNSUPPORTED_INPUT:
    "В этом файле нет видеодорожки - только звук. Пришли видеофайл, и я нарежу клипы.",
  // См. комментарий к ANALYSIS_UNAVAILABLE в enFailure: известно только, что
  // сломался анализ. Ни «пробую ещё раз», ни «пришли заново» утверждать нельзя -
  // первое неверно на последней из трёх попыток, второе списывает минуты второй
  // раз, если первая попытка всё-таки доедет до конца.
  ANALYSIS_UNAVAILABLE:
    "Не получилось понять, какие моменты нарезать из этого видео, минуты не списаны. Пока непонятно, получится ли доделать это видео - подожди несколько минут: если клипы всё-таки придут, а ты пришлёшь видео заново, минуты спишутся дважды за одно и то же. Если ничего не пришло, пришли его ещё раз или другой файл.",
  SOURCE_UNAVAILABLE:
    "Не получилось скачать видео по этой ссылке - возможно, оно приватное, удалено, недоступно в этом регионе или временно не отдаётся. Проверь, открывается ли ссылка в браузере, или пришли файл напрямую. Минуты не списаны.",
  // См. комментарий к SOURCE_TOO_LARGE в enFailure: причина известна точно, так
  // что называем её прямо и приводим число. Совет «пришли файл напрямую» из
  // SOURCE_UNAVAILABLE здесь надо именно отменить - те же 2 ГБ стоят и на
  // загрузке, так что это была бы вторая неудачная попытка.
  SOURCE_TOO_LARGE:
    "Это видео больше моего лимита в 2 ГБ, скачать его не получилось. Минуты не списаны. Прислать файл напрямую не поможет - лимит те же 2 ГБ. Обрежь видео до той части, которую нужно нарезать, и пришли её.",
  // Единственная строка здесь, которая может честно сказать, что минуты на
  // месте: стадия загрузки возвращает резерв до того, как задача помечается
  // как FAILED.
  FREE_ALLOWANCE_EXCEEDED:
    "Это видео длиннее, чем осталось бесплатных минут, поэтому я остановился до обработки. Бесплатные минуты на месте - нарежь ими видео покороче или выбери тариф, чтобы обработать это целиком.",
};

// Same rule as enFailureGeneric: neither "жди, я повторяю" nor "пришли заново"
// may be stated as fact - the first is false on a permanent failure, the second
// double-charges when attempt 2 of 3 heals. "подожди несколько минут: если
// клипы всё-таки придут" holds for the same reason as in EN - the delivery row
// is re-picked once the job heals to DONE.
const ruFailureGeneric =
  "Что-то пошло не так при обработке видео, минуты не списаны. Пока непонятно, получится ли доделать это видео - подожди несколько минут: если клипы всё-таки придут, а ты пришлёшь видео заново, минуты спишутся дважды за одно и то же. Если ничего не пришло, пришли его ещё раз или другой файл.";

const ru: Dict = {
  welcomeFirstScreen:
    "Привет! Пришли мне длинное видео - или ссылку на него - и я нарежу вертикальные клипы с субтитрами, готовые для TikTok, Reels и Shorts.\n\nРаботает с подкастами, стримами с Twitch, интервью, вебинарами и обзорами.\n\nПервое видео - бесплатно, без карты и подписки. Если клипов не получится, попытка не засчитается.",
  welcomeBack: "С возвращением! Пришли видео - сделаю клипы.",
  menuTitle: "Главное меню",
  welcomeNeedsPlan:
    "Пришли видео - сделаю клипы. Новому аккаунту даю один бесплатный запуск - карта не нужна, видео до 60 минут.",
  // Appended by the handler to the onboarding screens, and only while
  // freeBudgetStatus() reports the month's ceiling closed. See the note on
  // freeRunsPausedNote in types.ts for why the promise above is left intact
  // rather than rewritten.
  freeRunsPausedNote:
    "⏳ Сразу предупрежу: бесплатные запуски на паузе до первого числа следующего месяца. Это ограничение с моей стороны, а не на твоём аккаунте - бесплатные минуты никуда не денутся. Если хочешь клипы уже сегодня, открой 💳 Тарифы.",
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
  progressTitle: "🎬 Работаю над твоим видео",
  progressQueuedNote: "В очереди - начну с минуты на минуту.",
  progressStepDownload: "Забираю видео",
  progressStepTranscribe: "Слушаю речь",
  progressStepAnalyze: "Ищу лучшие моменты",
  progressStepRender: "Нарезаю и накладываю субтитры",
  fileTooLarge: (url) =>
    `Видео больше 20 МБ - это лимит Telegram Bot API. Пока что для длинных видео используй сайт: ${url}/dashboard. Скоро снимем это ограничение.`,
  processingFailed: (code) => (code && ruFailure[code]) || ruFailureGeneric,
  done: (n) =>
    `Готово. ${n} ${pluralizeRu(n, "клип", "клипа", "клипов")} ${pluralizeRu(n, "готов", "готовы", "готовы")}.`,
  donePartial: (sent, total) =>
    `Отправил ${sent} из ${total} ${pluralizeRu(total, "клипа", "клипов", "клипов")} - остальные доставить не удалось. Все ${total} готовы в личном кабинете.`,
  deliveryGivenUp: (url, clips) => {
    if (clips === 0) {
      return `Не удалось доставить результат по этому видео в этот чат - больше не пытаюсь. Открой ${url}/dashboard, там видно, чем всё закончилось - ничего не потеряно. Не присылай это видео заново, пока не посмотришь: повторная обработка спишет минуты второй раз.`;
    }
    const them = clips === 1 ? "его" : "их";
    const ready =
      clips === 1
        ? "Клип готов"
        : `Все ${clips} ${pluralizeRu(clips, "клип", "клипа", "клипов")} готовы`;
    return `${ready}, но отправить ${them} в этот чат не получилось - больше не пытаюсь. Ничего не потеряно: открой ${url}/dashboard, там ${them} можно посмотреть и скачать. Не присылай это видео заново: клипы уже есть, а повторная обработка спишет минуты второй раз.`;
  },
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Готово, но в этом видео не нашлось пригодной речи - клипов не будет."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Готово, но часть видео не удалось обработать, а в остальном сильных моментов не нашлось."
        : "Готово. Я просмотрел всё видео, но не нашёл достаточно сильных моментов - клипов в этот раз нет. Попробуй видео с большим количеством речи, эмоций или истории.",
  lowQualityNote: "Внимание: сильных моментов не нашлось - это лучшее из доступного.",
  blocked: (reason) => `${reason}\n\n💳 Тарифы - выбрать или управлять подпиской.`,
  freeExhausted: (remainingMinutes, lifetimeMinutes, planMinutes, planPriceEur) =>
    `Бесплатных минут на это не хватит - осталось ${remainingMinutes} из ${lifetimeMinutes}. Всё, что я уже успел нарезать, остаётся у тебя.\n\nЧтобы продолжить: Starter - €${planPriceEur} в неделю за ${planMinutes} минут видео, исходники до 3 часов и 20 клипов, которые хранятся 7 дней.`,
  freeNotAnchored: (planMinutes, planPriceEur) =>
    `Бесплатные минуты на этом аккаунте ещё не открыты. Напиши в поддержку из меню помощи - я разберусь. Или начни сразу с тарифа Starter: €${planPriceEur} в неделю за ${planMinutes} минут видео.`,
  freeBudgetClosed: (planMinutes, planPriceEur) =>
    `Бесплатные запуски на паузе до первого числа следующего месяца. Это ограничение с моей стороны, а не на твоём аккаунте - бесплатные минуты никуда не денутся.\n\nЕсли хочешь резать прямо сейчас: Starter - €${planPriceEur} в неделю за ${planMinutes} минут видео.`,
  freeSourceTooLong: (freeMaxMinutes, planMaxMinutes) =>
    `Бесплатный запуск - это видео до ${freeMaxMinutes} минут, а это длиннее. Пришли видео покороче или фрагмент этого на ${freeMaxMinutes} минут, чтобы попробовать бесплатно. На тарифе исходники до ${planMaxMinutes} минут.`,
  planSourceTooLong: (maxMinutes) =>
    `Это видео длиннее ${maxMinutes} минут - это максимальная длина исходника, которую я беру. Пришли фрагмент покороче, и я нарежу клипы.`,
  planNotActive:
    "На аккаунте нет активной подписки, поэтому обработка пока недоступна. Выбери тариф - и я сразу возьмусь за работу.",
  planCanceled:
    "Подписка отменена, обработка выключена. Оформи подписку заново - всё продолжится с того же места, клипы никуда не делись.",
  planPeriodEnded:
    "Оплаченный период закончился, обработка на паузе. Продли подписку - и я сразу возьму это видео в работу.",
  planQuotaExceeded: (usedMinutes, limitMinutes, topUpMinutes) =>
    `За этот период израсходовано ${usedMinutes} ${pluralizeRu(usedMinutes, "минута", "минуты", "минут")} из ${limitMinutes}, и это видео в остаток не помещается.${
      topUpMinutes > 0
        ? ` Докупленных минут (${topUpMinutes}) на него тоже не хватает.`
        : ""
    } Дождись обновления периода, докупи минуты или перейди на тариф побольше.`,
  planDailyLimit: (limit) =>
    `Достигнут дневной лимит - ${limit} ${pluralizeRu(limit, "видео", "видео", "видео")} в сутки. Лимит обнулится в полночь, тогда пришли это видео снова.`,
  planConcurrentLimit: (active, limit) =>
    `Я ещё обрабатываю ${active === 1 ? "твоё видео" : `твои видео (${active})`}, а на твоём тарифе одновременно обрабатывается ${limit}. Пришли это видео снова, когда закончу - я напишу.`,
  submitBusy:
    "Другая заявка с твоего аккаунта ещё проходит. Подожди немного и пришли это снова.",
  langUsage: (options) => `Использование: ${options}.`,
  langSet: "Язык установлен: русский.",
  langName: "Русский",
  langBtn: "🇷🇺 Русский",
  planStarterWeeklyBtn: "🌱 Starter - €3 / неделя",
  planStarterBtn: "💎 Starter - €9 / мес",
  planPlusBtn: "🚀 Plus - €29 / мес",
  planMaxBtn: "👑 Max - €89 / мес",
  menuCreate: "🎬 Создать клипы",
  createPrompt: ({ freeMaxMinutes, planMaxMinutes, maxFileGb }) =>
    `Пришли мне видео - файлом или ссылкой.\n\nДо ${planMaxMinutes / 60} часов видео, до ${maxFileGb} ГБ на файл.${
      freeMaxMinutes === null
        ? ""
        : `\nНа бесплатном прогоне: до ${freeMaxMinutes} минут.`
    }`,
  menuAccount: "📊 Аккаунт",
  menuHelp: "❓ Помощь",
  menuSettings: "⚙️ Настройки",
  menuEarn: "💰 Заработать",
  menuPlans: "💳 Тарифы",
  earnMenuPrompt: "💰 Заработать - выбери:",
  earnReferralBtn: "🔗 Реферальная программа",
  earnAdvertisersBtn: "🎯 Найти рекламодателя",
  earnAdvertisersSoon:
    "🎯 Найти рекламодателя\n\nЕсли у тебя есть аудитория, но нет рекламы - я поищу тебе рекламодателей. Процент беру только с найденных сделок.\n\nПока не открыто: настраиваю. Считаю, сколько людей сюда нажимает, так что нажатие - это голос.",
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
    `Пришли видео - нарежу вертикальные клипы с субтитрами.\nМожно также прислать ссылку (YouTube, Twitch, TikTok, Vimeo, X и др.).\n\nЛимиты: до 3 часов исходник, до 2 ГБ размер файла.\n\nКоманды:\n• /start - главное меню\n• /link - привязать существующий аккаунт clipclap.io\n• /referral - реферальная ссылка и доход\n• /lang - сменить язык\n\nСайт: ${url}/dashboard`,
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
      return `Тариф: нет активного\n\nВыбери тариф, чтобы начать.\nВсего создано: ${clipsTotal} ${pluralizeRu(clipsTotal, "клип", "клипа", "клипов")}`;
    }
    const planLabel = `${plan}${billingCycleLabel ? ` (${billingCycleLabel})` : ""}`;
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
  settingsLinkBtn: "🔗 Связать аккаунт",
  settingsBackBtn: "⬅️ Меню",
  langMenuPrompt: "Выбери язык:",
  videoSettingsPrompt: "🎬 Настройки видео",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Субтитры: вкл ✅" : "Субтитры: выкл ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Субтитры включены."
      : "Субтитры выключены. На новых видео субтитров не будет.",
  // See the note on en.botDescription for why there is no plan, no price, no
  // limits and no "press START" line here.
  botDescription:
    "Превращу любое длинное видео в короткие вирусные клипы с субтитрами - готовые для TikTok, Reels и Shorts!\n\nРаботает с подкастами, стримами с Twitch, интервью, вебинарами и обзорами.\n\n1. Пришли видео или вставь ссылку\n2. ИИ находит лучшие моменты и нарезает клипы\n3. Получи готовые к публикации видео прямо здесь, в Telegram\n\nПервое видео - бесплатно, без карты.",
  // See the note on en.botShortDescription. 120-char ceiling.
  botShortDescription:
    "Длинные подкасты, стримы, интервью → короткие вирусные клипы с субтитрами для TikTok, Reels и Shorts.",
  commands: [
    { command: "start", description: "Главное меню" },
    { command: "account", description: "Тариф и статистика" },
    { command: "help", description: "Лимиты и как работает" },
    { command: "settings", description: "Настройки" },
    { command: "lang", description: "Сменить язык" },
    { command: "link", description: "Привязать аккаунт clipclap.io" },
    { command: "referral", description: "Реферальная ссылка и доход" },
  ],
  manageSubscriptionBtn: "🔧 Управление подпиской",
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

export default ru;
