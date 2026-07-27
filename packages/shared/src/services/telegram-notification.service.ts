import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import { detectLocale, type Locale } from "../i18n";
import type { Plan } from "@prisma/client";

export type PaymentEvent =
  | { kind: "subscription_activated"; plan: Plan; periodEnd: Date }
  | { kind: "subscription_renewed"; plan: Plan; periodEnd: Date }
  | { kind: "payment_failed"; manageUrl: string }
  | { kind: "subscription_canceled"; graceEndsAt: Date | null };

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const PLAN_TITLES: Record<string, string> = {
  STARTER: "Starter",
  PLUS: "Plus",
  MAX: "Max",
};

function planTitle(plan: Plan): string {
  return PLAN_TITLES[plan] ?? String(plan);
}

type PaymentCopy = (
  event: PaymentEvent,
  opts?: { minutes?: number }
) => string;

/** Keyed by the full Locale union, so adding an interface language is a
 *  compile error here until this file has copy for it. It used to be
 *  `if (locale === "ru") { ... }` with English falling out of the bottom,
 *  which silently sent English to every language that was not Russian - on
 *  billing messages, the ones a paying user is guaranteed to read.
 *
 *  These stay here rather than moving into the bot's Dict because they are
 *  rendered by the web app's payment webhooks, which never load apps/bot. */
const PAYMENT_COPY: Record<Locale, PaymentCopy> = {
  en: (event, opts) => {
    switch (event.kind) {
      case "subscription_activated": {
        const avail = opts?.minutes
          ? `\nAvailable: ${opts.minutes} processing minutes this period.`
          : "";
        return `🎉 ${planTitle(event.plan)} subscription activated!\nActive until ${formatDate(event.periodEnd)}.${avail}\n\nTo start: send a video file or paste a link (YouTube, Twitch, TikTok, etc.) - I'll cut vertical clips with subtitles.`;
      }
      case "subscription_renewed":
        return `🔄 Subscription renewed until ${formatDate(event.periodEnd)}.`;
      case "payment_failed":
        return `⚠️ Payment failed. Update your payment method or the subscription will expire.\n\n${event.manageUrl}`;
      case "subscription_canceled":
        return event.graceEndsAt
          ? `⚠️ Subscription canceled. Access remains until ${formatDate(event.graceEndsAt)}.`
          : `⚠️ Subscription canceled. Processing access is now disabled.`;
    }
  },
  ru: (event, opts) => {
    switch (event.kind) {
      case "subscription_activated": {
        const avail = opts?.minutes
          ? `\nДоступно: ${opts.minutes} минут обработки в этом периоде.`
          : "";
        return `🎉 Подписка ${planTitle(event.plan)} подключена!\nАктивна до ${formatDate(event.periodEnd)}.${avail}\n\nКак начать: пришли видео файлом или вставь ссылку (YouTube, Twitch, TikTok и др.) - нарежу вертикальные клипы с субтитрами.`;
      }
      case "subscription_renewed":
        return `🔄 Подписка продлена до ${formatDate(event.periodEnd)}.`;
      case "payment_failed":
        return `⚠️ Оплата не прошла. Обнови способ оплаты, иначе подписка истечёт.\n\n${event.manageUrl}`;
      case "subscription_canceled":
        return event.graceEndsAt
          ? `⚠️ Подписка отменена. Доступ сохраняется до ${formatDate(event.graceEndsAt)}.`
          : `⚠️ Подписка отменена. Доступ к обработке прекращён.`;
    }
  },
  uk: (event, opts) => {
    switch (event.kind) {
      case "subscription_activated": {
        const avail = opts?.minutes
          ? `\nДоступно: ${opts.minutes} хвилин обробки в цьому періоді.`
          : "";
        return `🎉 Підписку ${planTitle(event.plan)} активовано!\nДіє до ${formatDate(event.periodEnd)}.${avail}\n\nЯк почати: надішли відео файлом або встав посилання (YouTube, Twitch, TikTok та інші) - наріжу вертикальні кліпи з субтитрами.`;
      }
      case "subscription_renewed":
        return `🔄 Підписку продовжено до ${formatDate(event.periodEnd)}.`;
      case "payment_failed":
        return `⚠️ Оплата не пройшла. Онови спосіб оплати, інакше підписка завершиться.\n\n${event.manageUrl}`;
      case "subscription_canceled":
        return event.graceEndsAt
          ? `⚠️ Підписку скасовано. Доступ зберігається до ${formatDate(event.graceEndsAt)}.`
          : `⚠️ Підписку скасовано. Доступ до обробки припинено.`;
    }
  },
  es: (event, opts) => {
    switch (event.kind) {
      case "subscription_activated": {
        const avail = opts?.minutes
          ? `\nDisponible: ${opts.minutes} minutos de procesamiento este periodo.`
          : "";
        return `🎉 ¡Suscripción ${planTitle(event.plan)} activada!\nActiva hasta ${formatDate(event.periodEnd)}.${avail}\n\nPara empezar: envía un archivo de video o pega un enlace (YouTube, Twitch, TikTok, etc.) y corto clips verticales con subtítulos.`;
      }
      case "subscription_renewed":
        return `🔄 Suscripción renovada hasta ${formatDate(event.periodEnd)}.`;
      case "payment_failed":
        return `⚠️ El pago falló. Actualiza tu método de pago o la suscripción caducará.\n\n${event.manageUrl}`;
      case "subscription_canceled":
        return event.graceEndsAt
          ? `⚠️ Suscripción cancelada. Mantienes el acceso hasta ${formatDate(event.graceEndsAt)}.`
          : `⚠️ Suscripción cancelada. El procesamiento queda desactivado.`;
    }
  },
  pt: (event, opts) => {
    switch (event.kind) {
      case "subscription_activated": {
        const avail = opts?.minutes
          ? `\nDisponível: ${opts.minutes} minutos de processamento neste período.`
          : "";
        return `🎉 Assinatura ${planTitle(event.plan)} ativada!\nAtiva até ${formatDate(event.periodEnd)}.${avail}\n\nPara começar: mande um arquivo de vídeo ou cole um link (YouTube, Twitch, TikTok etc.) e eu corto clipes verticais com legendas.`;
      }
      case "subscription_renewed":
        return `🔄 Assinatura renovada até ${formatDate(event.periodEnd)}.`;
      case "payment_failed":
        return `⚠️ O pagamento falhou. Atualize sua forma de pagamento ou a assinatura vai expirar.\n\n${event.manageUrl}`;
      case "subscription_canceled":
        return event.graceEndsAt
          ? `⚠️ Assinatura cancelada. O acesso continua até ${formatDate(event.graceEndsAt)}.`
          : `⚠️ Assinatura cancelada. O processamento está desativado.`;
    }
  },
  id: (event, opts) => {
    switch (event.kind) {
      case "subscription_activated": {
        const avail = opts?.minutes
          ? `\nTersedia: ${opts.minutes} menit pemrosesan di periode ini.`
          : "";
        return `🎉 Langganan ${planTitle(event.plan)} aktif!\nAktif sampai ${formatDate(event.periodEnd)}.${avail}\n\nUntuk mulai: kirim file video atau tempel tautan (YouTube, Twitch, TikTok, dll.) dan aku potong jadi klip vertikal bersubtitle.`;
      }
      case "subscription_renewed":
        return `🔄 Langganan diperpanjang sampai ${formatDate(event.periodEnd)}.`;
      case "payment_failed":
        return `⚠️ Pembayaran gagal. Perbarui metode pembayaranmu atau langganannya akan berakhir.\n\n${event.manageUrl}`;
      case "subscription_canceled":
        return event.graceEndsAt
          ? `⚠️ Langganan dibatalkan. Aksesmu tetap ada sampai ${formatDate(event.graceEndsAt)}.`
          : `⚠️ Langganan dibatalkan. Akses pemrosesan dimatikan.`;
    }
  },
};

export function renderPaymentNotification(
  locale: Locale,
  event: PaymentEvent,
  opts?: { minutes?: number }
): string {
  return PAYMENT_COPY[locale](event, opts);
}

export async function sendTelegramMessage(
  chatId: string,
  text: string
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN missing - skipping notification");
    return false;
  }

  const root = (
    process.env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org"
  ).replace(/\/+$/, "");

  try {
    const response = await fetch(`${root}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        `Telegram notification HTTP ${response.status}: ${body.slice(0, 200)}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      "Telegram notification failed:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

export async function notifyPaymentEvent(
  userId: string,
  event: PaymentEvent
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true, telegramLocale: true, billingCycle: true },
  });
  if (!user?.telegramId) return;

  let opts: { minutes?: number } | undefined;
  if (event.kind === "subscription_activated") {
    try {
      opts = {
        minutes: getPlanLimits(event.plan, user.billingCycle ?? undefined)
          .minutesPerPeriod,
      };
    } catch {
      opts = undefined; // unknown plan/cycle combo -> render without the quota line
    }
  }

  const locale = detectLocale(user.telegramLocale);
  const text = renderPaymentNotification(locale, event, opts);
  await sendTelegramMessage(user.telegramId, text);
}
