import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import type { Plan } from "@prisma/client";

export type PaymentEvent =
  | { kind: "subscription_activated"; plan: Plan; periodEnd: Date }
  | { kind: "subscription_renewed"; plan: Plan; periodEnd: Date }
  | { kind: "payment_failed"; manageUrl: string }
  | { kind: "subscription_canceled"; graceEndsAt: Date | null };

type Locale = "en" | "ru";

function detectLocale(stored: string | null | undefined): Locale {
  if (stored?.toLowerCase().startsWith("ru")) return "ru";
  return "en";
}

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

export function renderPaymentNotification(
  locale: Locale,
  event: PaymentEvent,
  opts?: { minutes?: number }
): string {
  if (locale === "ru") {
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
  }
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
