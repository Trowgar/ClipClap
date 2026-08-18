import type { JobErrorCode } from "@clipclap/shared";
import { plural } from "@clipclap/shared";
import type { Dict } from "./types";

/** Spanish distinguishes one/other only. `other` carries the plural and also
 *  covers CLDR's `many`, which Spanish selects for large round numbers. */
function pluralEs(n: number, one: string, other: string): string {
  return plural("es", n, { one, other });
}

const esFailure: Record<JobErrorCode, string> = {
  UNSUPPORTED_INPUT:
    "Este archivo no tiene pista de video, solo sonido. Envía un archivo de video y lo corto.",
  ANALYSIS_UNAVAILABLE:
    "No pude determinar qué momentos cortar de este video, y no se usaron tus minutos. Todavía no puedo saber si este va a terminar: espera unos minutos por si llegan los clips antes de enviarlo otra vez, así el mismo video no gasta tus minutos dos veces. Si no llega nada, envíalo de nuevo o prueba con otro archivo.",
  SOURCE_UNAVAILABLE:
    "No pude descargar el video de ese enlace: puede ser privado, estar bloqueado por región, eliminado o no disponible temporalmente. Comprueba que el enlace se abre en un navegador, o envíame el archivo directamente. No se usaron tus minutos.",
  SOURCE_TOO_LARGE:
    "Ese video supera mi límite de 2 GB, así que no pude descargarlo. No se usaron tus minutos. Enviarme el archivo no ayudará porque se aplica el mismo límite de 2 GB: recorta el video a la parte que quieres cortar y envía eso.",
  FREE_ALLOWANCE_EXCEEDED:
    "Este video es más largo que los minutos gratis que te quedan, así que me detuve antes de procesarlo. Tus minutos gratis siguen ahí: úsalos con un video más corto, o elige un plan para procesar este entero.",
};

const esFailureGeneric =
  "Algo salió mal al procesar este video y no se usaron tus minutos. Todavía no puedo saber si este va a terminar: espera unos minutos por si llegan los clips antes de enviarlo otra vez, así el mismo video no gasta tus minutos dos veces. Si no llega nada, envíalo de nuevo o prueba con otro archivo.";

const es: Dict = {
  welcomeFirstScreen:
    "¡Hola! Mándame un video largo - o un enlace - y lo corto en clips verticales con subtítulos, listos para TikTok, Reels y Shorts.\n\nFunciona con podcasts, streams de Twitch, entrevistas, webinars y reseñas.\n\nTu primer video es gratis: sin tarjeta y sin plan. Si vuelve sin clips, no cuenta.",
  welcomeBack: "¡Hola de nuevo! Envía un video y te genero los clips.",
  menuTitle: "Menú principal",
  welcomeNeedsPlan:
    "Envía un video y te genero los clips. Una cuenta nueva tiene una prueba gratis: sin tarjeta, hasta 60 minutos de video.",
  // Appended by the handler to the onboarding screens, and only while
  // freeBudgetStatus() reports the month's ceiling closed. See the note on
  // freeRunsPausedNote in types.ts for why the promise above is left intact
  // rather than rewritten.
  freeRunsPausedNote:
    "⏳ Antes de empezar: las pruebas gratis están en pausa hasta el día uno del mes que viene. Es un límite mío, no de tu cuenta: tus minutos gratis siguen esperándote. Si quieres clips hoy, abre 💳 Planes.",
  linkAccountInstructions: (code, url) =>
    `Tu código de conexión: ${code}\n\n1. Abre ${url}/dashboard/settings en el dispositivo donde tienes la sesión iniciada.\n2. Pega este código antes de 10 minutos.\n\nEste Telegram quedará conectado a esa cuenta.`,
  callbackAck: "Listo",
  linkCodePrompt: (code, url) =>
    `Tu código de conexión: ${code}\n\nAbre ${url}/dashboard/settings, pégalo antes de 10 minutos y tu Telegram quedará conectado a tu cuenta de ClipClap.`,
  linkSuccess: (n) =>
    n > 0
      ? `Telegram conectado. Importé ${n} ${pluralEs(n, "clip", "clips")} de tu historial del bot.`
      : "Telegram conectado a tu cuenta.",
  linkAlready: "Este Telegram ya está conectado a tu cuenta.",
  linkInvalid: "El código de conexión no es válido.",
  linkExpired:
    "El código de conexión caducó. Genera uno nuevo en clipclap.io/dashboard/settings.",
  linkConflict:
    "Tu cuenta de ClipClap ya está conectada a otro Telegram. Desconéctalo primero en el sitio web.",
  linkWrongDirection:
    "Este código no se puede usar aquí. Usa /link para generar uno nuevo para este Telegram.",
  sendVideoHint:
    "Envíame un video y lo convierto en clips verticales. Usa /start para empezar.",
  uploading: "Subiendo tu video...",
  queued: "En cola. Te envío los clips aquí cuando termine el renderizado.",
  progressTitle: "🎬 Trabajando en tu video",
  progressQueuedNote: "En la cola: empiezo en cualquier momento.",
  progressStepDownload: "Consiguiendo el video",
  progressStepTranscribe: "Escuchando el audio",
  progressStepAnalyze: "Buscando los mejores momentos",
  progressStepRender: "Cortando y poniendo subtítulos",
  fileTooLarge: (url) =>
    `Este video supera los 20 MB, el límite de la Bot API de Telegram. Por ahora, sube los videos largos en el sitio web: ${url}/dashboard. Estamos trabajando para quitar este límite pronto.`,
  processingFailed: (code) => (code && esFailure[code]) || esFailureGeneric,
  done: (n) =>
    `Listo. ${n} ${pluralEs(n, "clip", "clips")} ${n === 1 ? "está listo" : "están listos"}.`,
  donePartial: (sent, total) =>
    `Envié ${sent} de ${total} ${pluralEs(total, "clip", "clips")}: el resto no salió. Toca aquí abajo y lo intento otra vez.`,
  resendRemainingBtn: "Enviar el resto",
  deliveryGivenUp: (url, clips) => {
    if (clips === 0) {
      return `No pude entregar el resultado de este video en este chat y dejé de intentarlo. De mi lado no se perdió nada. No envíes este video otra vez hasta tener respuesta, porque procesarlo de nuevo gastaría tus minutos dos veces. Escribe a soporte desde el menú de ayuda y te cuento cómo terminó.`;
    }
    const lo = clips === 1 ? "lo" : "los";
    return `${clips === 1 ? "Tu clip está listo" : `Los ${clips} clips están listos`}, pero no pude entregar${lo} en este chat y dejé de intentarlo. No se perdió nada: escribe a soporte desde el menú de ayuda y te ${lo} hago llegar. No envíes este video otra vez, porque los clips ya existen y procesarlo de nuevo gastaría tus minutos dos veces.`;
  },
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Terminé, pero no encontré habla aprovechable en este video: esta vez no hay clips."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Terminé, pero una parte del video no se pudo procesar y en el resto no encontré momentos fuertes."
        : "Terminé. Vi el video entero, pero no encontré momentos lo bastante fuertes para hacer clips. Prueba con un video con más conversación, emoción o historia.",
  lowQualityNote:
    "Aviso: no encontré momentos fuertes, esto es lo mejor disponible.",
  blocked: (reason) => `${reason}\n\n💳 Planes: elige o gestiona tu suscripción.`,
  freeExhausted: (remainingMinutes, lifetimeMinutes, planMinutes, planPriceEur) =>
    `Tus minutos gratis no alcanzan para esto: quedan ${remainingMinutes} de ${lifetimeMinutes}. Lo que ya te corté es tuyo.\n\nPara seguir: Starter cuesta €${planPriceEur} por semana e incluye ${planMinutes} minutos de video, fuentes de hasta 3 horas y 20 clips guardados 7 días.`,
  freeNotAnchored: (planMinutes, planPriceEur) =>
    `Los minutos gratis todavía no están activos en esta cuenta. Escribe a soporte desde el menú de ayuda y lo resuelvo, o empieza ya con Starter: €${planPriceEur} por semana e incluye ${planMinutes} minutos de video.`,
  freeBudgetClosed: (planMinutes, planPriceEur) =>
    `Las pruebas gratis están en pausa hasta el día uno del mes que viene. Es un límite mío, no de tu cuenta: tus minutos gratis siguen ahí.\n\nSi quieres cortar ahora, Starter cuesta €${planPriceEur} por semana e incluye ${planMinutes} minutos de video.`,
  freeSourceTooLong: (freeMaxMinutes, planMaxMinutes) =>
    `Tu prueba gratis admite videos de hasta ${freeMaxMinutes} minutos, y este es más largo. Envía un video más corto, o un fragmento de ${freeMaxMinutes} minutos de este, para probarlo gratis. Con un plan acepto fuentes de hasta ${planMaxMinutes} minutos.`,
  planSourceTooLong: (maxMinutes) =>
    `Este video dura más de ${maxMinutes} minutos, que es la fuente más larga que puedo aceptar. Envía un corte más breve y lo proceso.`,
  planNotActive:
    "No hay ninguna suscripción activa en esta cuenta, así que todavía no puedo procesar videos. Elige un plan y empiezo enseguida.",
  planCanceled:
    "Tu suscripción está cancelada, así que el procesamiento está desactivado. Vuelve a suscribirte y todo sigue donde lo dejaste: tus clips siguen ahí.",
  planPeriodEnded:
    "Tu periodo de pago terminó, así que el procesamiento está en pausa. Renueva y me pongo con este video enseguida.",
  planQuotaExceeded: (usedMinutes, limitMinutes, topUpMinutes) =>
    `Has usado ${usedMinutes} de tus ${limitMinutes} minutos de este periodo, y este video no cabe en lo que queda.${
      topUpMinutes > 0
        ? ` Tus ${topUpMinutes} minutos adicionales tampoco alcanzan.`
        : ""
    } Espera a que se renueve el periodo, recarga minutos o pasa a un plan mayor.`,
  planDailyLimit: (limit) =>
    `Llegaste al límite diario de ${limit} ${pluralEs(limit, "video", "videos")}. Se reinicia a medianoche: envía este otra vez entonces.`,
  planConcurrentLimit: (active, limit) =>
    `Todavía estoy trabajando en ${active === 1 ? "tu video" : `${active} de tus videos`}, y tu plan procesa ${limit} a la vez. Envía este otra vez cuando termine: te aviso cuando pase.`,
  submitBusy:
    "Otro envío de tu cuenta todavía se está procesando. Espera un momento y manda este otra vez.",
  langUsage: (options) => `Uso: ${options}.`,
  langSet: "Idioma configurado: español.",
  langName: "Español",
  langBtn: "🇪🇸 Español",
  planStarterWeeklyBtn: "🌱 Starter - €3 / semana",
  planStarterBtn: "💎 Starter - €9 / mes",
  planPlusBtn: "🚀 Plus - €29 / mes",
  planMaxBtn: "👑 Max - €89 / mes",
  menuCreate: "🎬 Crear clips",
  createPrompt: ({ freeMaxMinutes, planMaxMinutes, maxFileGb }) =>
    `Mándame el video: sube el archivo o pega un enlace.\n\nHasta ${planMaxMinutes / 60} horas de video, hasta ${maxFileGb} GB por archivo.${
      freeMaxMinutes === null
        ? ""
        : `\nEn la prueba gratis: hasta ${freeMaxMinutes} minutos.`
    }`,
  menuAccount: "📊 Cuenta",
  menuHelp: "❓ Ayuda",
  menuSettings: "⚙️ Ajustes",
  menuEarn: "💰 Ganar dinero",
  menuPlans: "💳 Planes",
  earnMenuPrompt: "💰 Ganar dinero - elige:",
  earnReferralBtn: "🔗 Programa de referidos",
  earnAdvertisersBtn: "🎯 Buscar anunciantes",
  earnAdvertisersSoon:
    "🎯 Buscar anunciantes\n\nSi tienes audiencia pero no anunciantes, puedo buscarlos por ti. Solo me llevo un porcentaje de los acuerdos que consiga.\n\nTodavía no está abierto: lo estoy montando. Y cuento cuánta gente pulsa aquí, así que pulsar es un voto.",
  plansText:
    "💳 <b>Planes de ClipClap</b>\nPaga una vez y empieza a usarlo. Cancela cuando quieras en Tribute.\n\n" +
    "🌱 <b>Starter</b> - €3/sem · €9/mes\n   • 75 min/sem (270 min/mes)\n   • 20 clips guardados\n   • 7 días de retención\n\n" +
    "🚀 <b>Plus</b> - €29/mes\n   • 1000 min/mes\n   • 150 clips\n   • 30 días de retención\n\n" +
    "👑 <b>Max</b> - €89/mes\n   • 3500 min/mes\n   • 1000 clips\n   • 90 días de retención\n   • ⚡ cola prioritaria\n\n" +
    "Elige un plan abajo 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `Tienes ${plan} ✅ Activo hasta ${periodEnd}.\nGestiona o cancela tu suscripción en Tribute.`
      : `Tienes ${plan} ✅\nGestiona o cancela tu suscripción en Tribute.`,
  noPlanNudge: "👉 Pulsa 💳 Planes para suscribirte.",
  helpText: (url) =>
    `Envíame un video y lo corto en clips verticales con subtítulos.\nTambién puedes pegar un enlace (YouTube, Twitch, TikTok, Vimeo, X y más).\n\nLímites: hasta 3 horas de fuente, hasta 2 GB por archivo.\n\nComandos:\n• /start - menú principal\n• /link - conectar una cuenta de clipclap.io\n• /referral - tu enlace de referidos y ganancias\n• /lang - cambiar idioma\n\nSitio web: ${url}/dashboard`,
  helpMenuPrompt: "❓ Ayuda: elige",
  helpHowBtn: "❓ Cómo funciona",
  helpSupportBtn: "💬 Soporte",
  supportPrompt:
    "Escribe tu mensaje: se lo pasamos a soporte y te respondemos aquí mismo.",
  supportCloseBtn: "⬅️ Cerrar chat",
  supportClosed: "Chat cerrado. Envía un video cuando quieras para hacer clips.",
  supportReplyPrefix: "💬 Soporte:",
  supportUnavailable:
    "Soporte no está disponible temporalmente. Inténtalo de nuevo más tarde.",
  supportVideoInSession:
    '⚠️ Ahora mismo estás en el chat de soporte.\n\n• Para hacer un clip, pulsa "⬅️ Cerrar chat" abajo y envía el video otra vez.\n• Para describir tu problema, envía texto o una captura.',
  supportMediaUnsupported:
    "No pude enviar eso. Manda una captura de pantalla o descríbelo por texto.",
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
      return `Plan: ninguno activo\n\nElige un plan para empezar a cortar clips.\nClips creados en total: ${clipsTotal}`;
    }
    const planLabel = `${plan}${billingCycleLabel ? ` (${billingCycleLabel})` : ""}`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `Plan: ${planLabel} - terminó${periodEnd ? ` el ${periodEnd}` : ""}`;
      renewLine = "Renueva para seguir cortando clips.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `Plan: ${planLabel} - cancelado`;
      renewLine = "Vuelve a suscribirte para seguir cortando clips.";
    } else {
      planLine = `Plan: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (hoy)"
            : ` (en ${daysUntilPeriodEnd} ${pluralEs(daysUntilPeriodEnd, "día", "días")})`;
      renewLine = periodEnd ? `Se renueva: ${periodEnd}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${renewLine ? `${renewLine}\n` : ""}Problema con el pago: actualiza tu método de pago.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Minutos: ${minutesUsed} / ${minutesLimit} este periodo (quedan ${minutesLeft})`;
    const topUpLine =
      topUpMinutes > 0 ? `+ Minutos adicionales: ${topUpMinutes}\n` : "";
    const storageLine = `Almacenamiento: ${clipsStored} / ${storageClipsLimit} clips (se guardan ${retentionDays} ${pluralEs(retentionDays, "día", "días")})`;
    const totalLine = `Clips creados en total: ${clipsTotal}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(
      /\n\n\n+/g,
      "\n\n"
    );
  },
  planNone: "ningún plan activo",
  settingsMenuPrompt: "⚙️ Ajustes",
  settingsLangBtn: "🌐 Idioma",
  settingsVideoBtn: "🎬 Ajustes de video",
  settingsLinkBtn: "🔗 Vincular cuenta",
  settingsBackBtn: "⬅️ Menú",
  langMenuPrompt: "Elige tu idioma:",
  videoSettingsPrompt: "🎬 Ajustes de video",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Subtítulos: activados ✅" : "Subtítulos: desactivados ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Subtítulos activados."
      : "Subtítulos desactivados. Los videos nuevos saldrán sin subtítulos incrustados.",
  // See the note on en.botDescription for why there is no plan, no price, no
  // limits and no "press START" line here.
  botDescription:
    "Convierte cualquier video largo en clips virales cortos con subtítulos - listos para TikTok, Reels y Shorts!\n\nFunciona con podcasts, streams de Twitch, entrevistas, webinars y reseñas.\n\n1. Envía un video o pega un enlace\n2. La IA encuentra los mejores momentos y crea los clips\n3. Recibe videos listos para publicar aquí mismo, en Telegram\n\nTu primer video es gratis, sin tarjeta.",
  // See the note on en.botShortDescription. 120-char ceiling.
  botShortDescription:
    "Horas de podcast, stream o entrevista → clips cortos y virales con subtítulos para TikTok y Reels.",
  commands: [
    { command: "start", description: "Menú principal" },
    { command: "account", description: "Tu plan y estadísticas" },
    { command: "help", description: "Límites y cómo funciona" },
    { command: "settings", description: "Abrir ajustes" },
    { command: "lang", description: "Cambiar idioma" },
    { command: "link", description: "Conectar tu cuenta de clipclap.io" },
    { command: "referral", description: "Tu enlace de referidos y ganancias" },
  ],
  manageSubscriptionBtn: "🔧 Gestionar suscripción",
  checkingLink: "Comprobando el enlace…",
  urlAccessFailed:
    "No pude acceder al video de ese enlace. Prueba con otro enlace o sube el archivo directamente.",
  urlYouTubeUnavailable:
    "Los enlaces de YouTube no funcionan ahora mismo - YouTube nos está bloqueando a nosotros, no es tu enlace, así que otro enlace de YouTube tampoco servirá. El bloqueo va y viene: vuelve a mandar este mismo enlace dentro de un rato, sube el archivo de video aquí directamente, o manda un enlace de TikTok o Twitch.",
  referralInfo: (web, tg, earned, pending) =>
    `Tus enlaces de referidos:\nWeb: ${web}\nTelegram: ${tg}\n\nGanancias por referidos: $${earned}\nPendiente (retención de 14 días): $${pending}`,
  referralWithdrawBtn: "💸 Solicitar retiro",
  referralWithdrawStub: "Todavía no tienes fondos suficientes para retirar.",
  balanceInfo: (available, clearing) =>
    `Saldo de la cartera:\nDisponible: $${available}\nEn proceso: $${clearing} (comisiones aún en retención de 14 días)`,
  payBtn: "💳 Pagar",
  checkoutReady: (plan) =>
    `Pulsa "Pagar" para suscribirte a ${plan}. Volverás al bot después del pago.`,
  checkoutError: "No pude iniciar el pago. Inténtalo de nuevo en un momento.",
  cycleWeekly: "semanal",
  cycleMonthly: "mensual",
};

export default es;
