import type { JobErrorCode } from "@clipclap/shared";
import { plural } from "@clipclap/shared";
import type { Dict } from "./types";

/** Ukrainian selects the same one/few/many categories as Russian, including
 *  the 11-14 exception - verified against ICU: 1=one, 2=few, 5=many, 11=many,
 *  21=one. `other` repeats `many` because it is only selected for fractions,
 *  which no counter here produces.
 *
 *  The shared category shape is the only thing this file takes from ru.ts. The
 *  copy is written from the English source on purpose: adapting the Russian
 *  sentences is faster and produces calques that a Ukrainian reader spots
 *  immediately. */
function pluralizeUk(n: number, one: string, few: string, many: string): string {
  return plural("uk", n, { one, few, many, other: many });
}

const ukFailure: Record<JobErrorCode, string> = {
  UNSUPPORTED_INPUT:
    "У цьому файлі немає відеодоріжки, лише звук. Надішли відеофайл, і я його наріжу.",
  ANALYSIS_UNAVAILABLE:
    "Я не зміг визначити, які моменти вирізати з цього відео, і твої хвилини не витрачено. Поки не можу сказати, чи завершиться саме це: зачекай кілька хвилин - раптом кліпи прийдуть - і лише тоді надсилай знову, щоб те саме відео не з'їло твої хвилини двічі. Якщо нічого не прийде, надішли ще раз або спробуй інший файл.",
  SOURCE_UNAVAILABLE:
    "Я не зміг завантажити відео за цим посиланням: воно може бути приватним, недоступним у регіоні, видаленим або тимчасово недосяжним. Перевір, чи відкривається посилання у браузері, або надішли мені файл напряму. Твої хвилини не витрачено.",
  SOURCE_TOO_LARGE:
    "Це відео перевищує мій ліміт у 2 ГБ, тому я не зміг його завантажити. Твої хвилини не витрачено. Надіслати файл теж не допоможе - ліміт той самий, 2 ГБ. Обріж відео до потрібної частини й надішли саме її.",
};

const ukFailureGeneric =
  "Під час обробки цього відео щось пішло не так, і твої хвилини не витрачено. Поки не можу сказати, чи завершиться саме це: зачекай кілька хвилин - раптом кліпи прийдуть - і лише тоді надсилай знову, щоб те саме відео не з'їло твої хвилини двічі. Якщо нічого не прийде, надішли ще раз або спробуй інший файл.";

const uk: Dict = {
  welcomeNew:
    "Вітаю у ClipClap! Надішли відео, і я зроблю з нього вертикальні кліпи з субтитрами.\n\nМова: надішли /lang, щоб змінити.",
  welcomeFirstChoice:
    "Привіт! Я перетворюю довгі відео на вертикальні кліпи з субтитрами - готові для TikTok, Reels і Shorts.\n\nПерше відео безкоштовне: без картки й без тарифу. Якщо кліпів не вийде, спроба не зарахується.\n\nЯк це працює:\n1. Надішли відео (до 30 хвилин на безкоштовному запуску)\n2. Я знайду найсильніші моменти й виріжу їх\n3. Кліпи прийдуть сюди - до 12, залежно від відео\n\nСпершу - як тобі зручніше почати?\n\n• Новий акаунт - цей Telegram стане твоїм акаунтом ClipClap.\n• Уже маю акаунт - під'єднаємо цей Telegram до наявного акаунта на clipclap.io.",
  welcomeBack: "Радий бачити знову! Надішли відео, і я зроблю кліпи.",
  welcomeNeedsPlan:
    "Надішли відео, і я зроблю кліпи. Новий акаунт отримує один безкоштовний запуск: без картки, до 30 хвилин відео.",
  newAccountBtn: "✨ Створити новий акаунт",
  linkAccountBtn: "🔗 Уже маю акаунт",
  newAccountCreated:
    "Акаунт створено. Надсилай відео просто зараз: перше безкоштовне й без картки.\n\nДо 30 хвилин. Якщо кліпів не вийде, це не зарахується як безкоштовний запуск.",
  linkAccountInstructions: (code, url) =>
    `Твій код під'єднання: ${code}\n\n1. Відкрий ${url}/dashboard/settings на пристрої, де ти вже увійшов.\n2. Встав цей код протягом 10 хвилин.\n\nЦей Telegram буде під'єднано до того акаунта.`,
  callbackAck: "Готово",
  linkCodePrompt: (code, url) =>
    `Твій код під'єднання: ${code}\n\nВідкрий ${url}/dashboard/settings, встав його протягом 10 хвилин - і твій Telegram буде під'єднано до акаунта ClipClap.`,
  linkSuccess: (n) =>
    n > 0
      ? `Telegram під'єднано. Перенесено ${n} ${pluralizeUk(n, "кліп", "кліпи", "кліпів")} з історії бота.`
      : "Telegram під'єднано до твого акаунта.",
  linkAlready: "Цей Telegram уже під'єднано до твого акаунта.",
  linkInvalid: "Код під'єднання недійсний.",
  linkExpired:
    "Термін дії коду минув. Створи новий на clipclap.io/dashboard/settings.",
  linkConflict:
    "Твій акаунт ClipClap уже під'єднано до іншого Telegram. Спершу від'єднай його на сайті.",
  linkWrongDirection:
    "Цей код тут не спрацює. Скористайся /link, щоб отримати новий саме для цього Telegram.",
  sendVideoHint:
    "Надішли мені відео, і я зроблю з нього вертикальні кліпи. Почни з /start.",
  uploading: "Завантажую твоє відео...",
  queued: "У черзі. Надішлю кліпи сюди, щойно рендер завершиться.",
  fileTooLarge: (url) =>
    `Це відео більше за 20 МБ - це ліміт Bot API Telegram. Поки що завантажуй довгі відео на сайті: ${url}/dashboard. Ми працюємо над тим, щоб зняти це обмеження.`,
  processingFailed: (code) => (code && ukFailure[code]) || ukFailureGeneric,
  done: (n) =>
    `Готово. ${n} ${pluralizeUk(n, "кліп", "кліпи", "кліпів")} ${pluralizeUk(n, "готовий", "готові", "готові")}.`,
  donePartial: (sent, total) =>
    `Надіслав ${sent} з ${total} ${pluralizeUk(total, "кліпа", "кліпів", "кліпів")} - решту доставити не вдалося. Усі ${total} готові в особистому кабінеті.`,
  deliveryGivenUp: (url, clips) => {
    if (clips === 0) {
      return `Я не зміг доставити результат цього відео в цей чат і припинив спроби. Відкрий ${url}/dashboard, щоб побачити, чим усе скінчилося - нічого не втрачено. Не надсилай це відео знову, доки не заглянеш туди: повторна обробка витратить твої хвилини вдруге.`;
    }
    const ready =
      clips === 1
        ? "Твій кліп готовий"
        : `Усі ${clips} ${pluralizeUk(clips, "кліп", "кліпи", "кліпів")} готові`;
    return `${ready}, але я не зміг надіслати їх у цей чат і припинив спроби. Нічого не втрачено: відкрий ${url}/dashboard, щоб переглянути або завантажити. Не надсилай це відео знову - кліпи вже існують, а повторна обробка витратить твої хвилини вдруге.`;
  },
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Готово, але придатної мови в цьому відео я не знайшов - цього разу без кліпів."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Готово, але частину відео не вдалося обробити, а в решті сильних моментів не знайшлося."
        : "Готово. Я переглянув усе відео, але не знайшов моментів, достатньо сильних для кліпів. Спробуй відео, де більше розмови, емоцій або історії.",
  lowQualityNote:
    "Увага: сильних моментів не знайшлося - це найкраще з доступного.",
  blocked: (reason) => `${reason}\n\n💳 Тарифи - обрати підписку або керувати нею.`,
  freeExhausted: (remainingMinutes, lifetimeMinutes, planMinutes, planPriceEur) =>
    `Безкоштовні хвилини вичерпано - лишилося ${remainingMinutes} із ${lifetimeMinutes}. Усе, що я вже встиг нарізати, залишається твоїм.\n\nЩоб продовжити: Starter коштує €${planPriceEur} на тиждень і дає ${planMinutes} хвилин відео, джерела до 3 годин та 20 кліпів, які зберігаються 7 днів.`,
  freeNotAnchored: (planMinutes, planPriceEur) =>
    `Безкоштовні хвилини на цьому акаунті ще не відкриті. Напиши в підтримку з меню допомоги - я розберуся. Або почни одразу з тарифу Starter: €${planPriceEur} на тиждень за ${planMinutes} хвилин відео.`,
  freeBudgetClosed: (planMinutes, planPriceEur) =>
    `Безкоштовні запуски на паузі до першого числа наступного місяця. Це обмеження з мого боку, а не на твоєму акаунті - безкоштовні хвилини нікуди не подінуться.\n\nЯкщо хочеш різати вже зараз: Starter - €${planPriceEur} на тиждень за ${planMinutes} хвилин відео.`,
  freeSourceTooLong: (freeMaxMinutes, planMaxMinutes) =>
    `Безкоштовний запуск приймає відео до ${freeMaxMinutes} хвилин, а це довше. Надішли коротше відео - або ${freeMaxMinutes}-хвилинний фрагмент цього, - щоб спробувати безкоштовно. З тарифом я беру джерела до ${planMaxMinutes} хвилин.`,
  planSourceTooLong: (maxMinutes) =>
    `Це відео довше за ${maxMinutes} хвилин, а це найдовше джерело, яке я можу взяти. Надішли коротший фрагмент, і я його оброблю.`,
  planNotActive:
    "На цьому акаунті немає активної підписки, тож обробляти відео я поки не можу. Обери тариф - і я почну одразу.",
  planCanceled:
    "Твою підписку скасовано, тож обробку вимкнено. Оформи заново - і все продовжиться з того місця, де ти зупинився: кліпи на місці.",
  planPeriodEnded:
    "Оплачений період завершився, тож обробку призупинено. Продовж підписку - і я одразу візьмуся за це відео.",
  planQuotaExceeded: (usedMinutes, limitMinutes, topUpMinutes) =>
    `За цей період витрачено ${usedMinutes} ${pluralizeUk(usedMinutes, "хвилину", "хвилини", "хвилин")} з ${limitMinutes}, і це відео в залишок не вміщується.${
      topUpMinutes > 0
        ? ` Твоїх ${topUpMinutes} додаткових хвилин на нього теж не вистачить.`
        : ""
    } Зачекай на оновлення періоду, доклади хвилин або перейди на більший тариф.`,
  planDailyLimit: (limit) =>
    `Досягнуто денного ліміту - ${limit} відео на добу. Ліміт обнулиться опівночі, тоді надішли це відео знову.`,
  planConcurrentLimit: (active, limit) =>
    `Я ще працюю над ${active === 1 ? "твоїм відео" : `${active} твоїми відео`}, а твій тариф обробляє ${limit} одночасно. Надішли це знову, коли закінчу - я повідомлю.`,
  langUsage: (options) => `Використання: ${options}.`,
  langSet: "Мову встановлено: українська.",
  langName: "Українська",
  langBtn: "🇺🇦 Українська",
  planStarterWeeklyBtn: "🌱 Starter - €3 / тиждень",
  planStarterBtn: "💎 Starter - €9 / місяць",
  planPlusBtn: "🚀 Plus - €29 / місяць",
  planMaxBtn: "👑 Max - €89 / місяць",
  menuAccount: "📊 Акаунт",
  menuHelp: "❓ Довідка",
  menuSettings: "⚙️ Налаштування",
  menuAffiliate: "🤝 Партнерам",
  menuPlans: "💳 Тарифи",
  plansText:
    "💳 <b>Тарифи ClipClap</b>\nОплати один раз - і користуйся. Скасувати можна будь-коли в Tribute.\n\n" +
    "🌱 <b>Starter</b> - €3/тиж · €9/міс\n   • 75 хв/тиж (270 хв/міс)\n   • 20 кліпів у сховищі\n   • зберігання 7 днів\n\n" +
    "🚀 <b>Plus</b> - €29/міс\n   • 1000 хв/міс\n   • 150 кліпів\n   • зберігання 30 днів\n\n" +
    "👑 <b>Max</b> - €89/міс\n   • 3500 хв/міс\n   • 1000 кліпів\n   • зберігання 90 днів\n   • ⚡ пріоритетна черга\n\n" +
    "Обери тариф нижче 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `У тебе ${plan} ✅ Активний до ${periodEnd}.\nКерувати підпискою або скасувати її можна в Tribute.`
      : `У тебе ${plan} ✅\nКерувати підпискою або скасувати її можна в Tribute.`,
  noPlanNudge: "👉 Натисни 💳 Тарифи, щоб оформити підписку.",
  helpText: (url) =>
    `Надішли відео - я наріжу вертикальні кліпи з субтитрами.\nМожна також надіслати посилання (YouTube, Twitch, TikTok, Vimeo, X та інші).\n\nЛіміти: джерело до 3 годин, файл до 2 ГБ.\n\nКоманди:\n• /start - головне меню\n• /link - під'єднати наявний акаунт clipclap.io\n• /referral - реферальне посилання та дохід\n• /lang - змінити мову\n\nСайт: ${url}/dashboard`,
  helpMenuPrompt: "❓ Довідка - обери:",
  helpHowBtn: "❓ Як це працює",
  helpSupportBtn: "💬 Підтримка",
  supportPrompt:
    "Напиши своє повідомлення - ми передамо його в підтримку й відповімо просто тут.",
  supportCloseBtn: "⬅️ Закрити чат",
  supportClosed: "Чат закрито. Надсилай відео будь-коли, щоб зробити кліпи.",
  supportReplyPrefix: "💬 Підтримка:",
  supportUnavailable:
    "Підтримка тимчасово недоступна. Спробуй, будь ласка, пізніше.",
  supportVideoInSession:
    '⚠️ Зараз ти в чаті підтримки.\n\n• Щоб зробити кліп - натисни "⬅️ Закрити чат" нижче й надішли відео ще раз.\n• Щоб описати проблему - надішли текст або скріншот.',
  supportMediaUnsupported:
    "Не вдалося це надіслати. Надішли скріншот або опиши текстом.",
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
      return `Тариф: немає активного\n\nОбери тариф, щоб почати.\nУсього створено: ${clipsTotal} ${pluralizeUk(clipsTotal, "кліп", "кліпи", "кліпів")}`;
    }
    const planLabel = `${plan}${billingCycleLabel ? ` (${billingCycleLabel})` : ""}`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `Тариф: ${planLabel} - завершився${periodEnd ? ` ${periodEnd}` : ""}`;
      renewLine = "Продовж, щоб різати кліпи далі.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `Тариф: ${planLabel} - скасовано`;
      renewLine = "Оформи заново, щоб різати кліпи далі.";
    } else {
      planLine = `Тариф: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (сьогодні)"
            : ` (через ${daysUntilPeriodEnd} ${pluralizeUk(daysUntilPeriodEnd, "день", "дні", "днів")})`;
      renewLine = periodEnd ? `Продовження: ${periodEnd}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${renewLine ? `${renewLine}\n` : ""}Проблема з оплатою - онови спосіб оплати.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Хвилини: ${minutesUsed} / ${minutesLimit} за цей період (лишилося ${minutesLeft})`;
    const topUpLine =
      topUpMinutes > 0 ? `+ Додатково: ${topUpMinutes} хвилин\n` : "";
    const storageLine = `Сховище: ${clipsStored} / ${storageClipsLimit} ${pluralizeUk(clipsStored, "кліп", "кліпи", "кліпів")} (зберігаються ${retentionDays} ${pluralizeUk(retentionDays, "день", "дні", "днів")})`;
    const totalLine = `Усього створено: ${clipsTotal} ${pluralizeUk(clipsTotal, "кліп", "кліпи", "кліпів")}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(
      /\n\n\n+/g,
      "\n\n"
    );
  },
  planNone: "немає активного тарифу",
  settingsMenuPrompt: "⚙️ Налаштування",
  settingsLangBtn: "🌐 Мова",
  settingsVideoBtn: "🎬 Налаштування відео",
  settingsBackBtn: "⬅️ Меню",
  langMenuPrompt: "Обери мову:",
  videoSettingsPrompt: "🎬 Налаштування відео",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Субтитри: увімкнено ✅" : "Субтитри: вимкнено ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Субтитри увімкнено."
      : "Субтитри вимкнено. Нові відео будуть без вшитих субтитрів.",
  menuHint: "Кнопки меню нижче - для швидких дій.",
  botDescription:
    "ClipClap перетворює довгі відео на короткі вертикальні кліпи з субтитрами - готові для TikTok, Reels і Shorts.\n\nНадішли відео (до 3 годин), і я знайду найкращі моменти, виріжу їх та автоматично вшию субтитри.\n\nЯк це працює:\n1. Обери тариф\n2. Надішли відео\n3. Отримай свої кліпи\n\nНатисни START, щоб почати.",
  botShortDescription:
    "Довге відео → вертикальні кліпи з субтитрами. Надішли відео, щоб почати.",
  commands: [
    { command: "start", description: "Головне меню" },
    { command: "account", description: "Тариф і статистика" },
    { command: "help", description: "Ліміти та як це працює" },
    { command: "settings", description: "Налаштування" },
    { command: "lang", description: "Змінити мову" },
    { command: "link", description: "Під'єднати акаунт clipclap.io" },
    { command: "referral", description: "Реферальне посилання та дохід" },
  ],
  manageSubscriptionBtn: "🔧 Керувати підпискою",
  editInBrowserBtn: "✂️ Редагувати у браузері",
  checkingLink: "Перевіряю посилання…",
  urlAccessFailed:
    "Не вдалося отримати відео за цим посиланням. Спробуй інше посилання або надішли файл напряму.",
  referralInfo: (web, tg, earned, pending) =>
    `Твої реферальні посилання:\nВеб: ${web}\nTelegram: ${tg}\n\nРеферальний дохід: $${earned}\nВ очікуванні (утримання 14 днів): $${pending}`,
  referralWithdrawBtn: "💸 Запросити виплату",
  referralWithdrawStub: "Поки що недостатньо коштів для виплати.",
  balanceInfo: (available, clearing) =>
    `Баланс гаманця:\nДоступно: $${available}\nВ обробці: $${clearing} (комісії ще на утриманні 14 днів)`,
  payBtn: "💳 Оплатити",
  checkoutReady: (plan) =>
    `Натисни "Оплатити", щоб оформити ${plan}. Після оплати повернешся до бота.`,
  checkoutError: "Не вдалося почати оплату. Спробуй, будь ласка, за мить.",
  cycleWeekly: "тижневий",
  cycleMonthly: "місячний",
};

export default uk;
