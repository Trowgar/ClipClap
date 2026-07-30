import type { JobErrorCode } from "@clipclap/shared";
import { plural } from "@clipclap/shared";
import type { Dict } from "./types";

/** Brazilian Portuguese. The locale code stays the primary subtag `pt`:
 *  detectLocale resolves on the primary subtag, so a client reporting `pt-BR`
 *  (which is what both existing Portuguese users report) lands here. */
function pluralPt(n: number, one: string, other: string): string {
  return plural("pt", n, { one, other });
}

const ptFailure: Record<JobErrorCode, string> = {
  UNSUPPORTED_INPUT:
    "Este arquivo não tem faixa de vídeo, só áudio. Manda um arquivo de vídeo que eu corto.",
  ANALYSIS_UNAVAILABLE:
    "Não consegui identificar quais momentos cortar deste vídeo, e seus minutos não foram usados. Ainda não dá pra saber se este vai terminar: espera alguns minutos pra ver se os clipes chegam antes de mandar de novo, assim o mesmo vídeo não gasta seus minutos duas vezes. Se não chegar nada, manda de novo ou tenta outro arquivo.",
  SOURCE_UNAVAILABLE:
    "Não consegui baixar o vídeo desse link: ele pode estar privado, bloqueado por região, removido ou indisponível no momento. Confere se o link abre no navegador, ou me manda o arquivo direto. Seus minutos não foram usados.",
  SOURCE_TOO_LARGE:
    "Esse vídeo passa do meu limite de 2 GB, então não consegui baixar. Seus minutos não foram usados. Me mandar o arquivo não resolve porque vale o mesmo limite de 2 GB: corta o vídeo até a parte que você quer e manda esse trecho.",
  FREE_ALLOWANCE_EXCEEDED:
    "Este vídeo é mais longo que os minutos grátis que sobraram, então parei antes de processar. Seus minutos grátis continuam aí: use em um vídeo mais curto, ou escolha um plano pra processar este inteiro.",
};

const ptFailureGeneric =
  "Algo deu errado ao processar este vídeo e seus minutos não foram usados. Ainda não dá pra saber se este vai terminar: espera alguns minutos pra ver se os clipes chegam antes de mandar de novo, assim o mesmo vídeo não gasta seus minutos duas vezes. Se não chegar nada, manda de novo ou tenta outro arquivo.";

const pt: Dict = {
  welcomeFirstScreen:
    "Oi! Me manda um vídeo longo - ou um link - e eu corto em clipes verticais com legendas, prontos pra TikTok, Reels e Shorts.\n\nFunciona com podcasts, lives da Twitch, entrevistas, webinars e reviews.\n\nSeu primeiro vídeo é grátis: sem cartão e sem plano. Se voltar sem clipes, não conta.",
  welcomeBack: "Bom te ver de novo! Manda um vídeo que eu gero os clipes.",
  welcomeNeedsPlan:
    "Manda um vídeo que eu gero os clipes. Conta nova ganha um teste grátis: sem cartão, até 60 minutos de vídeo.",
  // Appended by the handler to the onboarding screens, and only while
  // freeBudgetStatus() reports the month's ceiling closed. See the note on
  // freeRunsPausedNote in types.ts for why the promise above is left intact
  // rather than rewritten.
  freeRunsPausedNote:
    "⏳ Antes de começar: as execuções grátis estão pausadas até o dia primeiro do mês que vem. É um limite meu, não da sua conta: seus minutos grátis continuam esperando por você. Se quiser clipes hoje, abra 💳 Planos.",
  linkAccountInstructions: (code, url) =>
    `Seu código de conexão: ${code}\n\n1. Abra ${url}/dashboard/settings no aparelho onde você está logado.\n2. Cole este código em até 10 minutos.\n\nEste Telegram vai ficar conectado a essa conta.`,
  callbackAck: "Beleza",
  linkCodePrompt: (code, url) =>
    `Seu código de conexão: ${code}\n\nAbra ${url}/dashboard/settings, cole em até 10 minutos e seu Telegram fica conectado à sua conta ClipClap.`,
  linkSuccess: (n) =>
    n > 0
      ? `Telegram conectado. Importei ${n} ${pluralPt(n, "clipe", "clipes")} do seu histórico no bot.`
      : "Telegram conectado à sua conta.",
  linkAlready: "Este Telegram já está conectado à sua conta.",
  linkInvalid: "O código de conexão não é válido.",
  linkExpired:
    "O código de conexão expirou. Gere um novo em clipclap.io/dashboard/settings.",
  linkConflict:
    "Sua conta ClipClap já está conectada a outro Telegram. Desconecte pelo site primeiro.",
  linkWrongDirection:
    "Este código não pode ser usado aqui. Use /link para gerar um novo para este Telegram.",
  sendVideoHint:
    "Me manda um vídeo e eu transformo em clipes verticais. Use /start para começar.",
  uploading: "Enviando seu vídeo...",
  queued: "Na fila. Mando os clipes aqui quando a renderização terminar.",
  progressTitle: "🎬 Trabalhando no seu vídeo",
  progressQueuedNote: "Na fila: começo a qualquer momento.",
  progressStepDownload: "Baixando o vídeo",
  progressStepTranscribe: "Ouvindo a fala",
  progressStepAnalyze: "Procurando os melhores momentos",
  progressStepRender: "Cortando e colocando legendas",
  fileTooLarge: (url) =>
    `Este vídeo passa de 20 MB, o limite da Bot API do Telegram. Por enquanto, envie vídeos longos pelo site: ${url}/dashboard. Estamos trabalhando para remover esse limite em breve.`,
  processingFailed: (code) => (code && ptFailure[code]) || ptFailureGeneric,
  done: (n) =>
    `Pronto. ${n} ${pluralPt(n, "clipe", "clipes")} ${n === 1 ? "está pronto" : "estão prontos"}.`,
  donePartial: (sent, total) =>
    `Enviei ${sent} de ${total} clipes: algo falhou antes de entregar o resto. Todos os ${total} estão prontos no seu painel.`,
  deliveryGivenUp: (url, clips) => {
    if (clips === 0) {
      return `Não consegui entregar o resultado deste vídeo neste chat e parei de tentar. Abra ${url}/dashboard para ver como terminou: nada foi perdido. Não mande este vídeo de novo antes de olhar lá, porque processar outra vez gastaria seus minutos em dobro.`;
    }
    return `${clips === 1 ? "Seu clipe está pronto" : `Os ${clips} clipes estão prontos`}, mas não consegui entregar neste chat e parei de tentar. Nada foi perdido: abra ${url}/dashboard para assistir ou baixar. Não mande este vídeo de novo, porque os clipes já existem e processar outra vez gastaria seus minutos em dobro.`;
  },
  doneNoClips: (reason) =>
    reason === "NO_USABLE_SPEECH"
      ? "Terminei, mas não achei fala aproveitável neste vídeo: sem clipes desta vez."
      : reason === "PARTIAL_TRANSCRIPT"
        ? "Terminei, mas parte do vídeo não pôde ser processada e no resto não achei momentos fortes."
        : "Terminei. Assisti ao vídeo inteiro, mas não achei momentos fortes o bastante para virar clipe. Tenta um vídeo com mais conversa, emoção ou história.",
  lowQualityNote: "Aviso: não achei momentos fortes, este é o melhor disponível.",
  blocked: (reason) => `${reason}\n\n💳 Planos: escolha ou gerencie sua assinatura.`,
  freeExhausted: (remainingMinutes, lifetimeMinutes, planMinutes, planPriceEur) =>
    `Seus minutos grátis não dão para isso: restam ${remainingMinutes} de ${lifetimeMinutes}. O que eu já cortei continua seu.\n\nPara continuar: o Starter custa €${planPriceEur} por semana e inclui ${planMinutes} minutos de vídeo, fontes de até 3 horas e 20 clipes guardados por 7 dias.`,
  freeNotAnchored: (planMinutes, planPriceEur) =>
    `Os minutos grátis ainda não estão liberados nesta conta. Fale com o suporte pelo menu de ajuda que eu resolvo, ou comece agora com o Starter: €${planPriceEur} por semana e ${planMinutes} minutos de vídeo.`,
  freeBudgetClosed: (planMinutes, planPriceEur) =>
    `As execuções grátis estão pausadas até o dia primeiro do mês que vem. É um limite meu, não da sua conta: seus minutos grátis continuam lá.\n\nSe quiser cortar agora, o Starter custa €${planPriceEur} por semana e inclui ${planMinutes} minutos de vídeo.`,
  freeSourceTooLong: (freeMaxMinutes, planMaxMinutes) =>
    `Seu teste grátis aceita vídeos de até ${freeMaxMinutes} minutos, e este é mais longo. Manda um vídeo mais curto, ou um trecho de ${freeMaxMinutes} minutos deste, para testar de graça. Com um plano eu aceito fontes de até ${planMaxMinutes} minutos.`,
  planSourceTooLong: (maxMinutes) =>
    `Este vídeo passa de ${maxMinutes} minutos, que é a fonte mais longa que eu aceito. Manda um corte menor que eu processo.`,
  planNotActive:
    "Não há assinatura ativa nesta conta, então ainda não posso processar vídeos. Escolha um plano que eu começo na hora.",
  planCanceled:
    "Sua assinatura está cancelada, então o processamento está desligado. Assine de novo e tudo continua de onde parou: seus clipes ainda estão lá.",
  planPeriodEnded:
    "Seu período pago terminou, então o processamento está pausado. Renove que eu pego este vídeo na sequência.",
  planQuotaExceeded: (usedMinutes, limitMinutes, topUpMinutes) =>
    `Você usou ${usedMinutes} dos seus ${limitMinutes} minutos deste período, e este vídeo não cabe no que sobrou.${
      topUpMinutes > 0
        ? ` Seus ${topUpMinutes} minutos avulsos também não dão conta.`
        : ""
    } Espere o período renovar, compre minutos avulsos ou mude para um plano maior.`,
  planDailyLimit: (limit) =>
    `Você bateu o limite diário de ${limit} ${pluralPt(limit, "vídeo", "vídeos")}. Ele zera à meia-noite: manda este de novo depois disso.`,
  planConcurrentLimit: (active, limit) =>
    `Ainda estou trabalhando em ${active === 1 ? "seu vídeo" : `${active} dos seus vídeos`}, e seu plano processa ${limit} por vez. Manda este de novo quando terminar: eu te aviso quando acontecer.`,
  langUsage: (options) => `Uso: ${options}.`,
  langSet: "Idioma definido: português.",
  langName: "Português",
  langBtn: "🇧🇷 Português",
  planStarterWeeklyBtn: "🌱 Starter - €3 / semana",
  planStarterBtn: "💎 Starter - €9 / mês",
  planPlusBtn: "🚀 Plus - €29 / mês",
  planMaxBtn: "👑 Max - €89 / mês",
  menuCreate: "🎬 Criar clipes",
  createPrompt: ({ freeMaxMinutes, planMaxMinutes, maxFileGb }) =>
    `Me manda o vídeo: envie o arquivo ou cole um link.\n\nAté ${planMaxMinutes / 60} horas de vídeo, até ${maxFileGb} GB por arquivo.\nNo teste grátis: até ${freeMaxMinutes} minutos.`,
  menuAccount: "📊 Conta",
  menuHelp: "❓ Ajuda",
  menuSettings: "⚙️ Configurações",
  menuEarn: "💰 Ganhar dinheiro",
  menuPlans: "💳 Planos",
  earnMenuPrompt: "💰 Ganhar dinheiro - escolha:",
  earnReferralBtn: "🔗 Programa de indicações",
  earnAdvertisersBtn: "🎯 Encontrar anunciantes",
  earnAdvertisersSoon:
    "🎯 Encontrar anunciantes\n\nSe você tem audiência mas não tem anunciantes, eu procuro por você. Só fico com uma porcentagem dos acordos que eu fechar.\n\nAinda não está aberto: estou montando. E eu conto quantas pessoas tocam aqui, então tocar é um voto.",
  plansText:
    "💳 <b>Planos do ClipClap</b>\nPague uma vez e comece a usar. Cancele quando quiser no Tribute.\n\n" +
    "🌱 <b>Starter</b> - €3/sem · €9/mês\n   • 75 min/sem (270 min/mês)\n   • 20 clipes guardados\n   • 7 dias de retenção\n\n" +
    "🚀 <b>Plus</b> - €29/mês\n   • 1000 min/mês\n   • 150 clipes\n   • 30 dias de retenção\n\n" +
    "👑 <b>Max</b> - €89/mês\n   • 3500 min/mês\n   • 1000 clipes\n   • 90 dias de retenção\n   • ⚡ fila prioritária\n\n" +
    "Escolha um plano abaixo 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `Você está no ${plan} ✅ Ativo até ${periodEnd}.\nGerencie ou cancele sua assinatura no Tribute.`
      : `Você está no ${plan} ✅\nGerencie ou cancele sua assinatura no Tribute.`,
  noPlanNudge: "👉 Toque em 💳 Planos para assinar.",
  helpText: (url) =>
    `Me manda um vídeo e eu corto em clipes verticais com legendas.\nVocê também pode colar um link (YouTube, Twitch, TikTok, Vimeo, X e outros).\n\nLimites: até 3 horas de fonte, até 2 GB por arquivo.\n\nComandos:\n• /start - menu principal\n• /link - conectar uma conta do clipclap.io\n• /referral - seu link de indicação e ganhos\n• /lang - trocar idioma\n\nSite: ${url}/dashboard`,
  helpMenuPrompt: "❓ Ajuda: escolha",
  helpHowBtn: "❓ Como funciona",
  helpSupportBtn: "💬 Suporte",
  supportPrompt:
    "Escreva sua mensagem: a gente passa para o suporte e responde aqui mesmo.",
  supportCloseBtn: "⬅️ Fechar chat",
  supportClosed: "Chat fechado. Manda um vídeo quando quiser para fazer clipes.",
  supportReplyPrefix: "💬 Suporte:",
  supportUnavailable:
    "O suporte está temporariamente indisponível. Tente de novo mais tarde.",
  supportVideoInSession:
    '⚠️ Você está no chat de suporte agora.\n\n• Para fazer um clipe, toque em "⬅️ Fechar chat" abaixo e mande o vídeo de novo.\n• Para descrever seu problema, mande texto ou um print.',
  supportMediaUnsupported:
    "Não consegui enviar isso. Manda um print ou descreve por texto.",
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
      return `Plano: nenhum ativo\n\nEscolha um plano para começar a cortar clipes.\nClipes criados no total: ${clipsTotal}`;
    }
    const planLabel = `${plan}${billingCycleLabel ? ` (${billingCycleLabel})` : ""}`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `Plano: ${planLabel} - terminou${periodEnd ? ` em ${periodEnd}` : ""}`;
      renewLine = "Renove para continuar cortando clipes.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `Plano: ${planLabel} - cancelado`;
      renewLine = "Assine de novo para continuar cortando clipes.";
    } else {
      planLine = `Plano: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (hoje)"
            : ` (em ${daysUntilPeriodEnd} ${pluralPt(daysUntilPeriodEnd, "dia", "dias")})`;
      renewLine = periodEnd ? `Renova em: ${periodEnd}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${renewLine ? `${renewLine}\n` : ""}Problema no pagamento: atualize sua forma de pagamento.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Minutos: ${minutesUsed} / ${minutesLimit} neste período (restam ${minutesLeft})`;
    const topUpLine =
      topUpMinutes > 0 ? `+ Minutos avulsos: ${topUpMinutes}\n` : "";
    const storageLine = `Armazenamento: ${clipsStored} / ${storageClipsLimit} clipes (guardados por ${retentionDays} ${pluralPt(retentionDays, "dia", "dias")})`;
    const totalLine = `Clipes criados no total: ${clipsTotal}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(
      /\n\n\n+/g,
      "\n\n"
    );
  },
  planNone: "nenhum plano ativo",
  settingsMenuPrompt: "⚙️ Configurações",
  settingsLangBtn: "🌐 Idioma",
  settingsVideoBtn: "🎬 Configurações de vídeo",
  settingsLinkBtn: "🔗 Vincular conta",
  settingsBackBtn: "⬅️ Menu principal",
  langMenuPrompt: "Escolha seu idioma:",
  videoSettingsPrompt: "🎬 Configurações de vídeo",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Legendas: ligadas ✅" : "Legendas: desligadas ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Legendas ligadas."
      : "Legendas desligadas. Os vídeos novos vão sair sem legenda embutida.",
  // See the note on en.botDescription for why there is no plan, no price, no
  // limits and no "press START" line here.
  botDescription:
    "Transforme qualquer vídeo longo em clipes virais curtos com legendas - prontos pra TikTok, Reels e Shorts!\n\nFunciona com podcasts, lives da Twitch, entrevistas, webinars e reviews.\n\n1. Manda um vídeo ou cola um link\n2. A IA encontra os melhores momentos e cria os clipes\n3. Receba vídeos prontos pra postar aqui mesmo, no Telegram\n\nSeu primeiro vídeo é grátis, sem cartão.",
  // See the note on en.botShortDescription. 120-char ceiling.
  botShortDescription:
    "Horas de podcast, live ou entrevista → clipes curtos e virais com legendas para TikTok e Reels.",
  commands: [
    { command: "start", description: "Menu principal" },
    { command: "account", description: "Seu plano e estatísticas" },
    { command: "help", description: "Limites e como funciona" },
    { command: "settings", description: "Abrir configurações" },
    { command: "lang", description: "Trocar idioma" },
    { command: "link", description: "Conectar sua conta do clipclap.io" },
    { command: "referral", description: "Seu link de indicação e ganhos" },
  ],
  manageSubscriptionBtn: "🔧 Gerenciar assinatura",
  checkingLink: "Verificando o link…",
  urlAccessFailed:
    "Não consegui acessar o vídeo desse link. Tente outro link ou envie o arquivo direto.",
  referralInfo: (web, tg, earned, pending) =>
    `Seus links de indicação:\nWeb: ${web}\nTelegram: ${tg}\n\nGanhos por indicação: $${earned}\nPendente (retenção de 14 dias): $${pending}`,
  referralWithdrawBtn: "💸 Solicitar saque",
  referralWithdrawStub: "Você ainda não tem saldo suficiente para sacar.",
  balanceInfo: (available, clearing) =>
    `Saldo da carteira:\nDisponível: $${available}\nEm processamento: $${clearing} (comissões ainda na retenção de 14 dias)`,
  payBtn: "💳 Pagar",
  checkoutReady: (plan) =>
    `Toque em "Pagar" para assinar o ${plan}. Você volta pro bot depois do pagamento.`,
  checkoutError: "Não consegui iniciar o pagamento. Tente de novo daqui a pouco.",
  cycleWeekly: "semanal",
  cycleMonthly: "mensal",
};

export default pt;
