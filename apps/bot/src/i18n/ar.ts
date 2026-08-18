import type { JobErrorCode } from "@clipclap/shared";
import { isolate, plural } from "@clipclap/shared";
import type { Dict } from "./types";

/** Arabic selects EVERY CLDR plural category, which no other dictionary in
 *  this project does - the existing helpers take three forms because Russian
 *  and Ukrainian select three. Verified against this project's Node:
 *
 *    0                -> zero
 *    1                -> one
 *    2                -> two
 *    3-10, 203        -> few
 *    11-99            -> many
 *    100, 101, 1000   -> other
 *
 *  All six are required arguments rather than optional with a fallback: a
 *  missing form would silently render the `other` text for a count Arabic
 *  distinguishes, which is exactly the failure a reader would notice and we
 *  would not. */
function pluralizeAr(
  n: number,
  zero: string,
  one: string,
  two: string,
  few: string,
  many: string,
  other: string
): string {
  return plural("ar", n, { zero, one, two, few, many, other });
}

/* ---- Counted phrases -----------------------------------------------------
 * Three nouns are counted in more than one string - minutes, clips and days -
 * and they are counted the same way every time: as a bare phrase dropped into
 * a sentence that does not change with the number. Written once each, with
 * all six forms, rather than six times inline: a phrase repeated across five
 * keys is five chances to write "دقائق" where Arabic wants "دقيقة".
 *
 * Where the SENTENCE changes with the count - a verb or a pronoun that has to
 * agree - the six forms are written at the key instead (see linkSuccess,
 * donePartial, deliveryGivenUp, planDailyLimit, planConcurrentLimit).
 *
 * The numeral is printed only in the forms where Arabic prints one. "1 مقطع
 * واحد" and "2 مقطعين" read like typos; the singular and the dual carry the
 * count inside the word. 3-10 takes the plural, 11-99 the accusative
 * singular, and 100 and up the genitive singular. */

function minutesAr(n: number): string {
  return pluralizeAr(
    n,
    `${isolate(n)} دقيقة`,
    "دقيقة واحدة",
    "دقيقتين",
    `${isolate(n)} دقائق`,
    `${isolate(n)} دقيقة`,
    `${isolate(n)} دقيقة`
  );
}

function clipsAr(n: number): string {
  return pluralizeAr(
    n,
    `${isolate(n)} مقطع`,
    "مقطع واحد",
    "مقطعين",
    `${isolate(n)} مقاطع`,
    `${isolate(n)} مقطعًا`,
    `${isolate(n)} مقطع`
  );
}

function daysAr(n: number): string {
  return pluralizeAr(
    n,
    `${isolate(n)} يوم`,
    "يوم واحد",
    "يومين",
    `${isolate(n)} أيام`,
    `${isolate(n)} يومًا`,
    `${isolate(n)} يوم`
  );
}

/** Same contract as enFailure: keyed by the whole JobErrorCode union, so a new
 *  code is a compile error here until Arabic has words for it, and the lookup
 *  still falls back at runtime for a shared build that knows a code this
 *  dictionary predates.
 *
 *  Every promise is the English one, unchanged. In particular: SOURCE_
 *  UNAVAILABLE names no cause (private, removed, region-locked, login-walled
 *  and a stale extractor are one exit code to the downloader), and not one of
 *  these five tells the user to send the video again on the spot - a re-send
 *  is a second Job row and usage.service bills both. */
const arFailure: Record<JobErrorCode, string> = {
  UNSUPPORTED_INPUT:
    "لا يحتوي هذا الملف على مسار فيديو - صوت فقط. أرسل ملف فيديو وسأقطّعه إلى مقاطع.",
  // See the note on ANALYSIS_UNAVAILABLE in enFailure: all this code knows is
  // that analysis failed. It is written on attempt 1 of 3 and on the last
  // burned one alike, so neither "أعيد المحاولة الآن" nor "أرسله من جديد" may
  // be stated - the first is false once the attempts are spent, and the second
  // charges the minutes twice for a video whose first attempt may still heal.
  ANALYSIS_UNAVAILABLE:
    "لم أتمكّن من تحديد اللحظات التي تُقتطع من هذا الفيديو، ولم تُخصم دقائقك. لا أستطيع أن أعرف بعد هل سيكتمل هذا الفيديو أم لا - انتظر بضع دقائق لترى إن كانت المقاطع ستصل قبل أن ترسله من جديد، حتى لا يستهلك الفيديو نفسه دقائقك مرتين. وإن لم يصل شيء بعدها، أرسله مرة أخرى أو أرسل ملفًا آخر.",
  // Hedged on purpose, exactly as the English is: a non-zero yt-dlp exit does
  // not say why, so no cause is stated as fact - "قد يكون" - and the sentence
  // leads with the remedy that works whatever went wrong.
  SOURCE_UNAVAILABLE:
    "لم أتمكّن من تنزيل الفيديو من هذا الرابط - قد يكون خاصًا أو محذوفًا أو محجوبًا في منطقتك أو غير متاح مؤقتًا. تأكّد من أن الرابط يفتح في المتصفح، أو أرسل لي الملف مباشرة. لم تُخصم دقائقك.",
  // Not hedged, unlike its sibling: yt-dlp measured the file and said it was
  // over the cap, so the cause is named and the number quoted. It also has to
  // take back the sibling's remedy - the same 2 GB is the bot's own Telegram
  // ceiling and the plan upload cap, so "أرسل لي الملف مباشرة" would send the
  // user off to fail a second time.
  SOURCE_TOO_LARGE:
    "حجم هذا الفيديو يتجاوز حدّي البالغ 2 غيغابايت، لذلك لم أتمكّن من تنزيله. لم تُخصم دقائقك. إرسال الملف مباشرة لن يفيد - الحدّ نفسه ينطبق عليه - لذا اقتطع من الفيديو الجزء الذي تريد تقطيعه وأرسل ذلك الجزء.",
  // The one line here that can say the allowance is intact and mean it: the
  // download stage returns the reservation before the job is marked failed. No
  // number - /account shows the real balance - and both ways out are named.
  FREE_ALLOWANCE_EXCEEDED:
    "هذا الفيديو أطول من الدقائق المجانية المتبقية لديك، لذلك توقّفت قبل معالجته. دقائقك المجانية ما زالت موجودة - اقتطع بها فيديو أقصر، أو اختر باقة لمعالجة هذا الفيديو كاملًا.",
};

// The "unknown failure" line, so it may assert neither transience nor
// permanence - both are live when it is sent. See the long note on
// enFailureGeneric: it covers a permanently undecodable source AND attempt 1
// of 3, and the only honest imperative is the one that stops the user paying
// for the same video twice. "انتظر بضع دقائق لترى إن كانت المقاطع ستصل" is
// true only because a delivery notified of a failure is parked in
// FAILURE_NOTIFIED and re-picked when the job reaches DONE; if that pickup
// ever goes, this sentence goes with it.
const arFailureGeneric =
  "حدث خطأ ما أثناء معالجة هذا الفيديو، ولم تُخصم دقائقك. لا أستطيع أن أعرف بعد هل سيكتمل هذا الفيديو أم لا - انتظر بضع دقائق لترى إن كانت المقاطع ستصل قبل أن ترسله من جديد، حتى لا يستهلك الفيديو نفسه دقائقك مرتين. وإن لم يصل شيء بعدها، أرسله مرة أخرى أو أرسل ملفًا آخر.";

const ar: Dict = {
  welcomeFirstScreen:
    "أهلًا! أرسل لي فيديو طويلًا - أو رابطًا له - وسأقطّعه إلى مقاطع عمودية مع ترجمة نصية، جاهزة لتيك توك وريلز وشورتس.\n\nيعمل مع البودكاست وبثوث تويتش والمقابلات والندوات والمراجعات.\n\nأول فيديو مجاني - بلا بطاقة وبلا اشتراك. وإن لم تخرج منه أي مقاطع، فلن تُحتسب المحاولة.",
  welcomeBack: "أهلًا بعودتك! أرسل فيديو وسأصنع منه مقاطع.",
  menuTitle: "القائمة الرئيسية",
  welcomeNeedsPlan:
    "أرسل فيديو وسأصنع منه مقاطع. كل حساب جديد يحصل على تشغيل مجاني واحد - بلا بطاقة، وحتى 60 دقيقة من الفيديو.",
  // Appended by the handler to the onboarding screens, and only while
  // freeBudgetStatus() reports the month's ceiling closed. See the note on
  // freeRunsPausedNote in types.ts for why the promise above is left intact
  // rather than rewritten.
  freeRunsPausedNote:
    "⏳ قبل أن تبدأ: التشغيل المجاني متوقف مؤقتًا حتى أول الشهر القادم. هذا حدّ من جهتي، لا على حسابك - دقائقك المجانية تبقى بانتظارك. وإن أردت مقاطع اليوم، افتح 💳 الباقات.",
  linkAccountInstructions: (code, url) =>
    `رمز الربط: ${isolate(code)}\n\n1. افتح ${isolate(
      `${url}/dashboard/settings`
    )} على الجهاز الذي سجّلت الدخول منه.\n2. الصق هذا الرمز خلال 10 دقائق.\n\nسيُربط حساب تيليغرام هذا بذلك الحساب.`,
  callbackAck: "تم",
  linkCodePrompt: (code, url) =>
    `رمز الربط: ${isolate(code)}\n\nافتح ${isolate(
      `${url}/dashboard/settings`
    )} والصق الرمز خلال 10 دقائق، وسيُربط حساب تيليغرام بحسابك في ClipClap.`,
  linkSuccess: (n) =>
    n > 0
      ? `تم ربط تيليغرام. استوردت ${pluralizeAr(
          n,
          `${isolate(n)} مقطع`,
          "مقطعًا واحدًا",
          "مقطعين",
          `${isolate(n)} مقاطع`,
          `${isolate(n)} مقطعًا`,
          `${isolate(n)} مقطع`
        )} من سجل البوت.`
      : "تم ربط تيليغرام بحسابك.",
  linkAlready: "حساب تيليغرام هذا مرتبط بحسابك بالفعل.",
  linkInvalid: "رمز الربط غير صالح.",
  linkExpired:
    "انتهت صلاحية رمز الربط. أنشئ رمزًا جديدًا من الصفحة clipclap.io/dashboard/settings",
  linkConflict:
    "حسابك في ClipClap مرتبط بحساب تيليغرام آخر. ألغِ الربط من الموقع أولًا.",
  linkWrongDirection:
    "لا يصلح هذا الرمز هنا. استخدم الأمر /link للحصول على رمز جديد لحساب تيليغرام هذا.",
  sendVideoHint:
    "أرسل لي فيديو وسأحوّله إلى مقاطع عمودية. استخدم الأمر /start للبدء.",
  uploading: "جارٍ رفع الفيديو...",
  queued: "في قائمة الانتظار. سأرسل المقاطع هنا فور انتهاء المعالجة.",
  progressTitle: "🎬 أعمل على الفيديو الخاص بك",
  progressQueuedNote: "في قائمة الانتظار - سأبدأ بعد لحظات.",
  progressStepDownload: "أُحضِر الفيديو",
  progressStepTranscribe: "أستمع إلى الكلام",
  progressStepAnalyze: "أبحث عن أفضل اللحظات",
  progressStepRender: "أقطّع وأضيف الترجمة",
  fileTooLarge: (url) =>
    `حجم هذا الفيديو يتجاوز 20 ميغابايت - وهو حدّ واجهة بوتات تيليغرام. في الوقت الحالي، ارفع الفيديوهات الأطول عبر الموقع: ${isolate(
      `${url}/dashboard`
    )}\nنعمل على رفع هذا الحدّ قريبًا.`,
  processingFailed: (code) => (code && arFailure[code]) || arFailureGeneric,
  done: (n) =>
    pluralizeAr(
      n,
      "تم. لا توجد مقاطع جاهزة.",
      "تم. مقطع واحد جاهز.",
      "تم. مقطعان جاهزان.",
      `تم. ${isolate(n)} مقاطع جاهزة.`,
      `تم. ${isolate(n)} مقطعًا جاهزة.`,
      `تم. ${isolate(n)} مقطع جاهزة.`
    ),
  donePartial: (sent, total) =>
    `${pluralizeAr(
      total,
      "لم يُرسل أي مقطع",
      `أرسلت ${isolate(sent)} من مقطع واحد`,
      `أرسلت ${isolate(sent)} من مقطعين`,
      `أرسلت ${isolate(sent)} من ${isolate(total)} مقاطع`,
      `أرسلت ${isolate(sent)} من ${isolate(total)} مقطعًا`,
      `أرسلت ${isolate(sent)} من ${isolate(total)} مقطع`
    )} - ولم تصل البقية. اضغط بالأسفل وسأحاول مرة أخرى.`,
  resendRemainingBtn: "أرسل البقية",
  deliveryGivenUp: (url, clips) => {
    if (clips === 0) {
      return `لم أتمكّن من إيصال نتيجة هذا الفيديو إلى هذه المحادثة، وتوقّفت عن المحاولة. لم يُفقد شيء لديّ. لا ترسل هذا الفيديو من جديد قبل أن يصلك ردّ: معالجته مرة ثانية ستخصم دقائقك مرتين. راسل الدعم من قائمة المساعدة وسأخبرك كيف انتهى الأمر.`;
    }
    const ready = pluralizeAr(
      clips,
      "لا توجد مقاطع جاهزة، ولم أتمكّن من إرسال شيء",
      "مقطعك جاهز، لكنني لم أتمكّن من إرساله",
      "مقطعاك جاهزان، لكنني لم أتمكّن من إرسالهما",
      `مقاطعك الـ${isolate(clips)} جاهزة كلها، لكنني لم أتمكّن من إرسالها`,
      `مقاطعك الـ${isolate(clips)} جاهزة كلها، لكنني لم أتمكّن من إرسالها`,
      `مقاطعك الـ${isolate(clips)} جاهزة كلها، لكنني لم أتمكّن من إرسالها`
    );
    return `${ready} إلى هذه المحادثة، وتوقّفت عن المحاولة. لم يُفقد شيء - راسل الدعم من قائمة المساعدة وسأوصل النتيجة إليك. لا ترسل هذا الفيديو من جديد: المقاطع موجودة بالفعل، ومعالجته مرة ثانية ستخصم دقائقك مرتين.`;
  },
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "انتهيت، لكنني لم أجد في هذا الفيديو كلامًا صالحًا للاستخدام - لا مقاطع هذه المرة."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "انتهيت، لكن جزءًا من الفيديو تعذّرت معالجته، ولم أجد لحظات قوية في بقيته."
        : "انتهيت. شاهدت الفيديو كاملًا لكنني لم أجد لحظات قوية بما يكفي لصنع مقاطع - لا مقاطع هذه المرة. جرّب فيديو فيه كلام أكثر أو انفعال أو قصة.",
  lowQualityNote: "للعلم: لم أجد لحظات قوية - هذا أفضل المتاح.",
  blocked: (reason) => `${reason}\n\n💳 الباقات - اختر اشتراكًا أو أدِر اشتراكك.`,
  freeExhausted: (remainingMinutes, lifetimeMinutes, planMinutes, planPriceEur) =>
    `دقائقك المجانية لا تكفي لهذا الفيديو - بقي ${isolate(
      remainingMinutes
    )} من ${minutesAr(lifetimeMinutes)}. وكل ما صنعته لك حتى الآن يبقى لك.\n\nللمتابعة: باقة Starter بـ${isolate(
      planPriceEur
    )} يورو أسبوعيًا مقابل ${minutesAr(
      planMinutes
    )} من الفيديو، ومصادر حتى 3 ساعات، و20 مقطعًا تُحفظ 7 أيام.`,
  freeNotAnchored: (planMinutes, planPriceEur) =>
    `دقائقك المجانية لم تُفتح على هذا الحساب بعد. راسل الدعم من قائمة المساعدة وسأتولّى الأمر - أو ابدأ فورًا بباقة Starter: ${isolate(
      planPriceEur
    )} يورو أسبوعيًا مقابل ${minutesAr(planMinutes)} من الفيديو.`,
  freeBudgetClosed: (planMinutes, planPriceEur) =>
    `التشغيل المجاني متوقف مؤقتًا حتى أول الشهر القادم. هذا حدّ من جهتي، لا على حسابك - دقائقك المجانية ما زالت بانتظارك.\n\nوإن أردت التقطيع الآن: باقة Starter بـ${isolate(
      planPriceEur
    )} يورو أسبوعيًا مقابل ${minutesAr(planMinutes)} من الفيديو.`,
  freeSourceTooLong: (freeMaxMinutes, planMaxMinutes) =>
    `التشغيل المجاني يشمل الفيديوهات حتى ${minutesAr(
      freeMaxMinutes
    )}، وهذا الفيديو أطول. أرسل فيديو أقصر - أو جزءًا من هذا الفيديو مدته ${minutesAr(
      freeMaxMinutes
    )} - لتجربته مجانًا. والباقات تقبل مصادر حتى ${minutesAr(planMaxMinutes)}.`,
  planSourceTooLong: (maxMinutes) =>
    `هذا الفيديو أطول من ${minutesAr(
      maxMinutes
    )}، وهي أقصى مدة مصدر أقبلها. أرسل نسخة أقصر وسأقطّعها.`,
  planNotActive:
    "لا يوجد اشتراك فعّال على هذا الحساب، لذلك لا أستطيع معالجة الفيديوهات بعد. اختر باقة وسأبدأ فورًا.",
  planCanceled:
    "اشتراكك ملغى، لذلك المعالجة متوقفة. أعد الاشتراك ويكمل كل شيء من حيث توقّفت - مقاطعك ما زالت موجودة.",
  planPeriodEnded:
    "انتهت فترتك المدفوعة، لذلك المعالجة متوقفة مؤقتًا. جدّد الاشتراك وسآخذ هذا الفيديو إلى العمل فورًا.",
  planQuotaExceeded: (usedMinutes, limitMinutes, topUpMinutes) =>
    `استهلكت ${isolate(usedMinutes)} من ${minutesAr(
      limitMinutes
    )} في هذه الفترة، وهذا الفيديو لا يتّسع فيما تبقّى.${
      topUpMinutes > 0
        ? ` ودقائقك الإضافية (${minutesAr(topUpMinutes)}) لا تكفيه أيضًا.`
        : ""
    } انتظر تجديد الفترة، أو أضف دقائق، أو انتقل إلى باقة أكبر.`,
  planDailyLimit: (limit) =>
    `بلغت الحد اليومي وهو ${pluralizeAr(
      limit,
      `${isolate(limit)} فيديو`,
      "فيديو واحد",
      "فيديوهان",
      `${isolate(limit)} فيديوهات`,
      `${isolate(limit)} فيديو`,
      `${isolate(limit)} فيديو`
    )}. يُصفَّر الحد عند منتصف الليل - أرسل هذا الفيديو حينها.`,
  planConcurrentLimit: (active, limit) =>
    `ما زلت أعمل على ${pluralizeAr(
      active,
      "فيديوهاتك",
      "فيديوك",
      "فيديوهين من فيديوهاتك",
      `${isolate(active)} من فيديوهاتك`,
      `${isolate(active)} من فيديوهاتك`,
      `${isolate(active)} من فيديوهاتك`
    )}، وباقتك تعالج ${pluralizeAr(
      limit,
      `${isolate(limit)} فيديو`,
      "فيديو واحد",
      "فيديوهين",
      `${isolate(limit)} فيديوهات`,
      `${isolate(limit)} فيديو`,
      `${isolate(limit)} فيديو`
    )} في الوقت نفسه. أرسل هذا الفيديو مرة أخرى بعد أن أنتهي - سأخبرك حين ينتهي.`,
  submitBusy:
    "هناك طلب آخر من حسابك ما زال قيد التنفيذ. أمهلني لحظة ثم أرسل هذا من جديد.",
  langUsage: (options) => `طريقة الاستخدام: ${isolate(options)}.`,
  langSet: "تم ضبط اللغة: العربية.",
  langName: "العربية",
  langBtn: "🇸🇦 العربية",
  planStarterWeeklyBtn: "🌱 Starter - €3 / أسبوع",
  planStarterBtn: "💎 Starter - €9 / شهر",
  planPlusBtn: "🚀 Plus - €29 / شهر",
  planMaxBtn: "👑 Max - €89 / شهر",
  menuCreate: "🎬 إنشاء مقاطع",
  createPrompt: ({ freeMaxMinutes, planMaxMinutes, maxFileGb }) => {
    const hours = planMaxMinutes / 60;
    return `أرسل لي الفيديو - ارفع الملف أو الصق رابطًا.\n\nحتى ${pluralizeAr(
      hours,
      `${isolate(hours)} ساعة`,
      "ساعة واحدة",
      "ساعتين",
      `${isolate(hours)} ساعات`,
      `${isolate(hours)} ساعة`,
      `${isolate(hours)} ساعة`
    )} من الفيديو، وحتى ${isolate(maxFileGb)} غيغابايت لكل ملف.${
      freeMaxMinutes === null
        ? ""
        : `\nفي التشغيل المجاني: حتى ${minutesAr(freeMaxMinutes)}.`
    }`;
  },
  menuAccount: "📊 الحساب",
  menuHelp: "❓ المساعدة",
  menuSettings: "⚙️ الإعدادات",
  menuEarn: "💰 الربح",
  menuPlans: "💳 الباقات",
  earnMenuPrompt: "💰 الربح - اختر:",
  earnReferralBtn: "🔗 برنامج الإحالة",
  earnAdvertisersBtn: "🎯 البحث عن معلنين",
  earnAdvertisersSoon:
    "🎯 البحث عن معلنين\n\nإن كان لديك جمهور بلا معلنين، أستطيع أن أبحث عنهم لك - ولا آخذ نسبة إلا من الصفقات التي أجدها.\n\nهذه الخدمة لم تُفتح بعد. ما زلت أجهّزها، وأحصي كم شخصًا يضغط هنا - فالضغطة صوت.",
  plansText:
    "💳 <b>باقات ClipClap</b>\nادفع مرة واحدة وابدأ الاستخدام. ويمكنك الإلغاء في أي وقت عبر Tribute.\n\n" +
    "🌱 <b>Starter</b> - €3/أسبوع · €9/شهر\n   • 75 دقيقة/أسبوع (270 دقيقة/شهر)\n   • 20 مقطعًا في التخزين\n   • حفظ 7 أيام\n\n" +
    "🚀 <b>Plus</b> - €29/شهر\n   • 1000 دقيقة/شهر\n   • 150 مقطعًا\n   • حفظ 30 يومًا\n\n" +
    "👑 <b>Max</b> - €89/شهر\n   • 3500 دقيقة/شهر\n   • 1000 مقطع\n   • حفظ 90 يومًا\n   • ⚡ طابور أولوية\n\n" +
    "اختر باقة بالأسفل 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `أنت على باقة ${isolate(plan)} ✅ فعّالة حتى ${isolate(
          periodEnd
        )}.\nأدِر اشتراكك أو ألغِه عبر Tribute.`
      : `أنت على باقة ${isolate(plan)} ✅\nأدِر اشتراكك أو ألغِه عبر Tribute.`,
  noPlanNudge: "👉 اضغط 💳 الباقات للاشتراك.",
  helpText: (url) =>
    `أرسل لي فيديو - وسأقطّعه إلى مقاطع عمودية مع ترجمة نصية.\nويمكنك أيضًا لصق رابط (يوتيوب، تويتش، تيك توك، فيميو، إكس وغيرها).\n\nالحدود: مصدر حتى 3 ساعات، وحجم ملف حتى 2 غيغابايت.\n\nالأوامر:\n• /start - القائمة الرئيسية\n• /link - ربط حساب clipclap.io قائم\n• /referral - رابط الإحالة وأرباحك\n• /lang - تغيير اللغة\n\nالموقع: ${isolate(
      `${url}/dashboard`
    )}`,
  helpMenuPrompt: "❓ المساعدة - اختر:",
  helpHowBtn: "❓ كيف يعمل",
  helpSupportBtn: "💬 الدعم",
  supportPrompt: "اكتب رسالتك - سنوصلها إلى الدعم ونرد عليك هنا.",
  supportCloseBtn: "➡️ إغلاق المحادثة",
  supportClosed: "أُغلقت المحادثة. أرسل فيديو في أي وقت لصنع مقاطع.",
  supportReplyPrefix: "💬 الدعم:",
  supportUnavailable: "الدعم غير متاح مؤقتًا. حاول مرة أخرى لاحقًا.",
  supportVideoInSession:
    "⚠️ أنت الآن في محادثة الدعم.\n\n• لصنع مقطع - اضغط «➡️ إغلاق المحادثة» بالأسفل ثم أرسل الفيديو من جديد.\n• لوصف مشكلتك - أرسل نصًا أو لقطة شاشة.",
  supportMediaUnsupported:
    "تعذّر إرسال ذلك. أرسل لقطة شاشة أو صف المشكلة نصًا.",
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
      return `الباقة: لا توجد باقة فعّالة\n\nاختر باقة لتبدأ التقطيع.\nإجمالي المقاطع المُنشأة: ${clipsAr(
        clipsTotal
      )}`;
    }
    // The cycle label is NOT isolated: it is our own Arabic word, and an
    // invisible mark between the bracket and the label would break the
    // per-locale assertion that the text contains "(<label>)".
    const planLabel = `${isolate(plan)}${
      billingCycleLabel ? ` (${billingCycleLabel})` : ""
    }`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `الباقة: ${planLabel} - انتهت${
        periodEnd ? ` ${isolate(periodEnd)}` : ""
      }`;
      renewLine = "جدّد الاشتراك لتتابع التقطيع.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `الباقة: ${planLabel} - ملغاة`;
      renewLine = "أعد الاشتراك لتتابع التقطيع.";
    } else {
      planLine = `الباقة: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (اليوم)"
            : ` (بعد ${daysAr(daysUntilPeriodEnd)})`;
      renewLine = periodEnd ? `التجديد: ${isolate(periodEnd)}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${
          renewLine ? `${renewLine}\n` : ""
        }هناك مشكلة في الدفع - يرجى تحديث وسيلة الدفع.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    // "45 / 270" is isolated as one run: two numbers around a slash are all
    // weak or neutral characters, so in an RTL paragraph they would be laid
    // out right to left and the ratio would read backwards.
    const minutesLine = `الدقائق: ${isolate(
      `${minutesUsed} / ${minutesLimit}`
    )} في هذه الفترة (بقي ${minutesAr(minutesLeft)})`;
    const topUpLine =
      topUpMinutes > 0 ? `+ دقائق إضافية: ${minutesAr(topUpMinutes)}\n` : "";
    const storageLine = `التخزين: ${isolate(
      `${clipsStored} / ${storageClipsLimit}`
    )} من المقاطع (تُحفظ ${daysAr(retentionDays)})`;
    const totalLine = `إجمالي المقاطع المُنشأة: ${clipsAr(clipsTotal)}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(
      /\n\n\n+/g,
      "\n\n"
    );
  },
  planNone: "لا توجد باقة فعّالة",
  settingsMenuPrompt: "⚙️ الإعدادات",
  settingsLangBtn: "🌐 اللغة",
  settingsVideoBtn: "🎬 إعدادات الفيديو",
  settingsLinkBtn: "🔗 ربط الحساب",
  // ⬅️ points away from "back" in a right-to-left layout, so the Arabic back
  // button is the one label whose emoji differs from its English counterpart.
  settingsBackBtn: "➡️ رجوع",
  langMenuPrompt: "اختر لغتك:",
  videoSettingsPrompt: "🎬 إعدادات الفيديو",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "الترجمة: مفعّلة ✅" : "الترجمة: معطّلة ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "تم تفعيل الترجمة."
      : "تم تعطيل الترجمة. الفيديوهات الجديدة لن تحمل ترجمة محروقة.",
  // See the note on en.botDescription for why there is no plan, no price, no
  // limits and no "press START" line here. Hard cap 512 characters, asserted
  // per locale.
  botDescription:
    "حوّل أي فيديو طويل إلى مقاطع قصيرة رائجة مع ترجمة نصية - جاهزة لتيك توك وريلز وشورتس!\n\nيعمل مع البودكاست وبثوث تويتش والمقابلات والندوات والمراجعات.\n\n1. أرسل فيديو أو الصق رابطًا\n2. الذكاء الاصطناعي يجد أفضل اللحظات ويصنع المقاطع\n3. استلم فيديوهات جاهزة للنشر هنا في تيليغرام\n\nأول فيديو مجاني - بلا بطاقة.",
  // See the note on en.botShortDescription. The arrow is ← rather than →: it
  // means "leads to", and in a right-to-left line that direction is leftwards.
  // 120-character ceiling.
  botShortDescription:
    "بودكاست وبثوث ومقابلات طويلة ← مقاطع قصيرة رائجة مع ترجمة لتيك توك وريلز وشورتس.",
  commands: [
    { command: "start", description: "القائمة الرئيسية" },
    { command: "account", description: "باقتك وإحصاءاتك" },
    { command: "help", description: "الحدود وكيف يعمل" },
    { command: "settings", description: "فتح الإعدادات" },
    { command: "lang", description: "تغيير اللغة" },
    { command: "link", description: "ربط حساب clipclap.io" },
    { command: "referral", description: "رابط الإحالة وأرباحك" },
  ],
  manageSubscriptionBtn: "🔧 إدارة الاشتراك",
  checkingLink: "جارٍ فحص الرابط…",
  urlAccessFailed:
    "تعذّر الوصول إلى الفيديو عبر هذا الرابط. جرّب رابطًا آخر أو ارفع الملف مباشرة.",
  urlYouTubeUnavailable:
    "روابط يوتيوب لا تعمل حاليًا - يوتيوب يحجبنا نحن، لا أنت، لذلك لن يفيد رابط يوتيوب آخر. الحجب يأتي ويذهب: أعد إرسال هذا الرابط نفسه بعد قليل، أو ارفع ملف الفيديو هنا بدلًا من ذلك، أو أرسل رابطًا من تيك توك أو تويتش.",
  referralInfo: (web, tg, earned, pending) =>
    `روابط الإحالة الخاصة بك:\nالموقع: ${isolate(web)}\nتيليغرام: ${isolate(
      tg
    )}\n\nأرباح الإحالة: ${isolate(`$${earned}`)}\nقيد الانتظار (حجز 14 يومًا): ${isolate(
      `$${pending}`
    )}`,
  referralWithdrawBtn: "💸 طلب سحب",
  referralWithdrawStub: "لا يوجد لديك رصيد كافٍ للسحب بعد.",
  balanceInfo: (available, clearing) =>
    `رصيد المحفظة:\nالمتاح: ${isolate(`$${available}`)}\nقيد التسوية: ${isolate(
      `$${clearing}`
    )} (العمولات ما زالت في حجز 14 يومًا)`,
  payBtn: "💳 ادفع",
  checkoutReady: (plan) =>
    `اضغط «ادفع» للاشتراك في باقة ${isolate(plan)}. ستعود إلى البوت بعد الدفع.`,
  checkoutError: "تعذّر بدء عملية الدفع. حاول مرة أخرى بعد قليل.",
  cycleWeekly: "أسبوعي",
  cycleMonthly: "شهري",
};

export default ar;
