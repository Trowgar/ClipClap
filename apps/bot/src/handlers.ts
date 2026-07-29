import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  FUNNEL_EVENTS,
  buildClipCaption,
  cancelShopOrder,
  canSubmitJob,
  createBotInitiatedLink,
  createShopOrder,
  createTelegramDelivery,
  estimatedFreeCostUsd,
  findOrCreateTelegramUser,
  FREE_TIER,
  getPlanLimits,
  getPresignedDownloadUrl,
  getTributeCatalogEntry,
  getUsageForUser,
  isPermanentTelegramError,
  jobService,
  markTelegramDeliveryAttemptFailed,
  markTelegramDeliveryFailed,
  markTelegramDeliveryFailureNotified,
  markTelegramDeliverySent,
  MAX_TELEGRAM_DELIVERY_ATTEMPTS,
  parseJobErrorCode,
  prisma,
  recordFunnelEvent,
  redeemLinkFromBot,
  telegramDeliveryService,
  uploadFile,
  uploadRejectedEvent,
} from "@clipclap/shared";
import type {
  FreeChargeInput,
  SubscriptionPhase,
  UploadRejectionCode,
} from "@clipclap/shared";
import type { User } from "@prisma/client";
import type { TelegramClient } from "./telegram-client";
import { extractVideoUrl, probeVideoUrl } from "./url-probe";
import {
  LOCALES,
  detectLocale,
  isLocale,
  langOptionsList,
  parseLangCommand,
  t,
  type Dict,
  type Locale,
} from "./i18n";
import type {
  InlineKeyboardMarkup,
  KeyboardButton,
  ReplyKeyboardMarkup,
  TelegramCallbackQuery,
  TelegramDocument,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  TelegramVideo,
} from "./types";

const ACTIVE_STATUSES = [
  "PENDING",
  "DOWNLOADING",
  "TRANSCRIBING",
  "ANALYZING",
  "CUTTING",
] as const;

export const CALLBACK_NEW_ACCOUNT = "new_acc";
export const CALLBACK_LINK_ACCOUNT = "link_acc";

/** Language callbacks are `lang_<code>`, built and parsed from LOCALES rather
 *  than declared one constant per language - the old pair of constants had to
 *  be added to a switch, a parser and a keyboard by hand, and Telegram gives
 *  no error for a button whose callback nothing handles: it just does nothing
 *  when tapped. Kept short: callback_data has a 64-byte ceiling. */
const CALLBACK_LANG_PREFIX = "lang_";

export function langCallbackData(locale: Locale): string {
  return `${CALLBACK_LANG_PREFIX}${locale}`;
}

export function isLangCallback(data: string | undefined): boolean {
  return parseLangCallback(data) !== null;
}

export const CALLBACK_SUBTITLES_TOGGLE = "subs_toggle";

export function isReferralAdmin(
  telegramId: string,
  allowlist: string | undefined
): boolean {
  if (!allowlist) return false;
  return allowlist
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(telegramId);
}

export function parseLangCallback(data: string | undefined): Locale | null {
  if (!data?.startsWith(CALLBACK_LANG_PREFIX)) return null;
  // Still an explicit membership check, so a retired code - or the `lang_auto`
  // this bot used to send, which is still sitting in old chat histories - is
  // rejected instead of being written to User.telegramLocale.
  const code = data.slice(CALLBACK_LANG_PREFIX.length);
  return isLocale(code) ? code : null;
}

export type MenuAction = "account" | "help" | "settings" | "affiliate" | "plans";

export function matchMenuAction(text: string): MenuAction | null {
  for (const loc of LOCALES) {
    const d = t(loc);
    if (text === d.menuAccount) return "account";
    if (text === d.menuHelp) return "help";
    if (text === d.menuSettings) return "settings";
    if (text === d.menuAffiliate) return "affiliate";
    if (text === d.menuPlans) return "plans";
  }
  return null;
}

export type SettingsAction = "lang" | "video" | "menu";

export function matchSettingsAction(text: string): SettingsAction | null {
  for (const loc of LOCALES) {
    const d = t(loc);
    if (text === d.settingsLangBtn) return "lang";
    if (text === d.settingsVideoBtn) return "video";
    if (text === d.settingsBackBtn) return "menu";
  }
  return null;
}

export function matchReferralAction(text: string): "withdraw" | null {
  for (const loc of LOCALES) {
    if (text === t(loc).referralWithdrawBtn) return "withdraw";
  }
  return null;
}

function referralKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.referralWithdrawBtn }],
      [{ text: dict.settingsBackBtn }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}

export function matchHelpAction(text: string): "how" | "support" | null {
  for (const loc of LOCALES) {
    const d = t(loc);
    if (text === d.helpHowBtn) return "how";
    if (text === d.helpSupportBtn) return "support";
  }
  return null;
}

function helpKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.helpHowBtn }, { text: dict.helpSupportBtn }],
      [{ text: dict.settingsBackBtn }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}

const SUPPORT_MARKER = "🆕 #uid";
const SUPPORT_UID_RE = new RegExp(`^${SUPPORT_MARKER}(\\d+)`);

export function matchSupportAction(text: string): "close" | null {
  for (const loc of LOCALES) {
    if (text === t(loc).supportCloseBtn) return "close";
  }
  return null;
}

export function getSupportChatId(): string | null {
  const explicit = process.env.SUPPORT_CHAT_ID?.trim();
  if (explicit) return explicit;
  const first = (process.env.REFERRAL_ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first ?? null;
}

function supportKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [[{ text: dict.supportCloseBtn }]],
    is_persistent: true,
    resize_keyboard: true,
  };
}

export function parseSupportReply(
  message: TelegramMessage
): { uid: string } | null {
  const r = message.reply_to_message;
  if (!r?.from?.is_bot) return null;
  const m = SUPPORT_UID_RE.exec(r.text ?? r.caption ?? "");
  return m ? { uid: m[1] } : null;
}

async function openSupport(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  dict: Dict
) {
  if (!getSupportChatId()) {
    await client
      .sendMessage(message.chat.id, dict.supportUnavailable)
      .catch(() => undefined);
    return;
  }
  const user = await resolveTelegramUser(from);
  await prisma.user.update({
    where: { id: user.id },
    data: { supportOpen: true },
  });
  await client.sendMessage(message.chat.id, dict.supportPrompt, {
    replyMarkup: supportKeyboard(dict),
  });
}

function supportSenderName(from: TelegramUser): string {
  const rawName = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const name = rawName.replace(/#uid\d+/g, "").trim() || String(from.id);
  const username = from.username ? ` (@${from.username})` : "";
  return `${name}${username}`;
}

async function notifyOperatorClosed(
  client: TelegramClient,
  chatId: number,
  from: TelegramUser
) {
  const supportChat = getSupportChatId();
  if (supportChat && String(chatId) !== supportChat) {
    await client
      .sendMessage(
        supportChat,
        `❌ Пользователь ${supportSenderName(from)} (id ${from.id}) закрыл диалог поддержки.`
      )
      .catch(() => undefined);
  }
}

export async function closeSupport(
  client: TelegramClient,
  chatId: number,
  userId: string,
  from: TelegramUser,
  dict: Dict
) {
  await prisma.user.update({
    where: { id: userId },
    data: { supportOpen: false },
  });
  await sendMainMenu(client, chatId, dict.supportClosed, dict, from);
  await notifyOperatorClosed(client, chatId, from);
}

export async function relaySupportMessage(
  client: TelegramClient,
  from: TelegramUser,
  text: string
) {
  const chat = getSupportChatId();
  if (!chat) {
    console.warn(
      "Support message received but SUPPORT_CHAT_ID is not configured"
    );
    return;
  }
  const header = `${SUPPORT_MARKER}${from.id} ${supportSenderName(from)}`;
  await client
    .sendMessage(chat, `${header}\n\n${text}`)
    .catch((e) => {
      console.error(`Failed to relay support message to ${chat}:`, e);
    });
}

export async function relaySupportMedia(
  client: TelegramClient,
  from: TelegramUser,
  message: TelegramMessage
): Promise<boolean> {
  const chat = getSupportChatId();
  if (!chat) {
    console.warn(
      "Support media received but SUPPORT_CHAT_ID is not configured"
    );
    return true;
  }
  const caption =
    `${SUPPORT_MARKER}${from.id} ${supportSenderName(from)}` +
    (message.caption ? `\n\n${message.caption}` : "");
  try {
    await client.copyMessage(chat, message.chat.id, message.message_id, {
      caption,
    });
    return true;
  } catch (e) {
    console.error(`Failed to relay support media to ${chat}:`, e);
    return false;
  }
}

export async function deliverSupportReply(
  client: TelegramClient,
  uid: string,
  text: string,
  supportChatId: string | number
) {
  const target = await prisma.user.findUnique({
    where: { telegramId: uid },
    select: { telegramLocale: true },
  });
  if (!target) {
    await client
      .sendMessage(
        supportChatId,
        `⚠️ #uid${uid}: пользователь не найден, ответ не доставлен.`
      )
      .catch(() => undefined);
    return;
  }
  const dict = t(detectLocale(target.telegramLocale ?? undefined));
  try {
    await client.sendMessage(uid, `${dict.supportReplyPrefix}\n${text}`, {
      replyMarkup: supportKeyboard(dict),
    });
  } catch {
    await client
      .sendMessage(
        supportChatId,
        `⚠️ #uid${uid}: не удалось доставить ответ (юзер мог заблокировать бота).`
      )
      .catch(() => undefined);
    return;
  }
  await prisma.user
    .update({ where: { telegramId: uid }, data: { supportOpen: true } })
    .catch(() => undefined);
}

function settingsKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.settingsLangBtn }, { text: dict.settingsVideoBtn }],
      [{ text: dict.settingsBackBtn }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}

/**
 * The admin-only analytics entry.
 *
 * It lives on the ☰ button beside the input field, NOT on the reply keyboard.
 * Telegram hands no launch credential to a Mini App opened from a reply
 * keyboard: the fragment arrives carrying tgWebAppVersion, tgWebAppPlatform and
 * tgWebAppThemeParams and no tgWebAppData at all, because such apps are meant to
 * answer the bot through sendData() rather than authenticate to a backend. Menu
 * and inline button launches are signed; keyboard ones are not.
 *
 * It cost an afternoon of a blank admin page to learn, hence the note.
 */
const ADMIN_ANALYTICS_LABEL = "Analytics";

function buildMainMenu(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.menuPlans }, { text: dict.menuAccount }],
      [{ text: dict.menuAffiliate }, { text: dict.menuHelp }],
      [{ text: dict.menuSettings }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}

/** Where the Mini App is opened, freshly stamped on every send.
 *
 *  `v` is a cache buster and NOT a credential, deliberately: a Mini App URL ends
 *  up in our own access log and in every proxy along the way, so nothing secret
 *  may travel in it. It only stops Telegram from restoring a webview it has
 *  already opened at that address. */
function adminAnalyticsUrl(): string {
  const appUrl =
    process.env.APP_URL || process.env.NEXTAUTH_URL || "https://clipclap.io";
  return `${appUrl}/admin?v=${Date.now()}`;
}

/** The main menu's reply keyboard on its own, WITHOUT the app-open telemetry
 *  that sendMainMenu records.
 *
 *  Needed because a reply keyboard cannot be edited: Telegram binds it to a
 *  message, so changing every label on it - which is exactly what a language
 *  switch does - means sending one. That send is a side effect of the switch,
 *  not a menu the user opened, and counting it as an app-open would inflate a
 *  funnel metric with events nobody caused. */
function mainMenuKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return buildMainMenu(dict);
}

/**
 * Puts the analytics Mini App on the ☰ button in the admin's own chat.
 *
 * Private chats ONLY, and set per chat rather than globally: omitting chat_id
 * would hand the button to every private chat the bot has. chatId === from.id
 * is exactly the private-chat test - Telegram uses the user id as the chat id.
 *
 * Nothing takes the button away again if an id later leaves
 * REFERRAL_ADMIN_TELEGRAM_IDS. That leaks no data - the page re-checks the live
 * list on every request and shows a revoked admin nothing - but the entry point
 * would linger, so revoking someone means clearing their menu button by hand.
 */
async function syncAdminMenuButton(
  client: TelegramClient,
  chatId: number | string,
  from: { id: number | string }
): Promise<void> {
  const isPrivate = String(chatId) === String(from.id);
  if (
    !isPrivate ||
    !isReferralAdmin(String(from.id), process.env.REFERRAL_ADMIN_TELEGRAM_IDS)
  ) {
    return;
  }
  await client
    .setChatMenuButton(chatId, {
      type: "web_app",
      text: ADMIN_ANALYTICS_LABEL,
      web_app: { url: adminAnalyticsUrl() },
    })
    .catch(() => undefined);
}

/** Sends the main menu and records the app-open exactly once, wherever it is shown. */
async function sendMainMenu(
  client: TelegramClient,
  chatId: number | string,
  text: string,
  dict: Dict,
  from: { id: number | string; language_code?: string }
) {
  // Refreshed here rather than at the /menu command alone: the menu is reached
  // from seven places (/start, the settings back button, ...), and the ☰ button
  // should be in place no matter which one the admin came through. Before the
  // message, so it is already there when the menu appears.
  await syncAdminMenuButton(client, chatId, from);

  await client
    .sendMessage(chatId, text, { replyMarkup: mainMenuKeyboard(dict) })
    .catch(() => undefined);

  // After the reply is out, never before - this is telemetry.
  await recordFunnelEvent("bot", from.id, FUNNEL_EVENTS.APP_OPENED, from.language_code);
}

export interface BotRuntimeConfig {
  appUrl: string;
}

export async function handleUpdate(
  client: TelegramClient,
  update: TelegramUpdate,
  config: BotRuntimeConfig
) {
  if (update.callback_query) {
    await handleCallbackQuery(client, update.callback_query, config);
    return;
  }

  const message = update.message;
  if (!message?.from) return;

  const from = message.from;
  const text = message.text?.trim() ?? "";

  const existing = await prisma.user.findUnique({
    where: { telegramId: String(from.id) },
    select: { id: true, telegramLocale: true, supportOpen: true },
  });
  let supportOpen = existing?.supportOpen ?? false;

  const locale = detectLocale(existing?.telegramLocale ?? from.language_code);
  const dict = t(locale);

  // Operator answering a support ticket (a Telegram reply to the bot's #uid message).
  if (String(message.chat.id) === getSupportChatId()) {
    const parsed = parseSupportReply(message);
    if (parsed) {
      if (!text) {
        await client
          .sendMessage(
            message.chat.id,
            "⚠️ Ответ должен быть текстом. Ответь текстом на сообщение тикета."
          )
          .catch(() => undefined);
        return;
      }
      await deliverSupportReply(client, parsed.uid, text, message.chat.id);
      return;
    }
  }

  // Close the support session from its reply-keyboard button.
  if (matchSupportAction(text) === "close") {
    const user = await resolveTelegramUser(from);
    await closeSupport(client, message.chat.id, user.id, from, dict);
    return;
  }

  // Any recognized navigation exits an open support session (no stuck flag).
  if (supportOpen) {
    const navMatched =
      text.startsWith("/") ||
      (parseMenuCommand(text) ?? matchMenuAction(text)) !== null ||
      matchSettingsAction(text) !== null ||
      matchReferralAction(text) !== null ||
      matchHelpAction(text) !== null;
    if (navMatched) {
      await prisma.user
        .update({ where: { id: existing!.id }, data: { supportOpen: false } })
        .catch(() => undefined);
      supportOpen = false;
      await notifyOperatorClosed(client, message.chat.id, from);
    }
  }

  if (text.startsWith("/start")) {
    await handleStart(client, message, text, dict, config, existing);
    return;
  }

  if (text === "/link" || text.startsWith("/link ") || text.startsWith("/link@")) {
    await handleLink(client, message, dict, config);
    return;
  }

  const langChoice = parseLangCommand(text);
  if (langChoice) {
    await handleLang(client, message, from, langChoice, dict);
    return;
  }

  if (text === "/menu" || text.startsWith("/menu ") || text.startsWith("/menu@")) {
    // sendMainMenu carries the admin analytics button for every entry point.
    await sendMainMenu(client, message.chat.id, dict.welcomeBack, dict, from);
    return;
  }

  if (text === "/referral" || text.startsWith("/referral ") || text.startsWith("/referral@")) {
    await handleReferral(client, message, from, dict, config);
    return;
  }

  if (text === "/balance" || text.startsWith("/balance@")) {
    await handleBalance(client, message, from, dict);
    return;
  }

  if (text.startsWith("/payouts") || text.startsWith("/ref ") ||
      text.startsWith("/refban ") || text.startsWith("/refvoid ")) {
    if (isReferralAdmin(String(from.id), process.env.REFERRAL_ADMIN_TELEGRAM_IDS)) {
      await handleAdminCommand(client, message, text);
      return;
    }
    // non-admins fall through to the default hint
  }

  if (text.startsWith("/approve ") || text.startsWith("/paid ") || text.startsWith("/reject ")) {
    if (isReferralAdmin(String(from.id), process.env.REFERRAL_ADMIN_TELEGRAM_IDS)) {
      await handleAdminPayoutAction(client, message, text);
      return;
    }
  }

  const menuAction = parseMenuCommand(text) ?? matchMenuAction(text);
  if (menuAction) {
    await handleMenuAction(client, message, menuAction, dict, config, existing);
    return;
  }

  const settingsAction = matchSettingsAction(text);
  if (settingsAction) {
    await handleSettingsAction(client, message, settingsAction, dict);
    return;
  }

  if (matchReferralAction(text) === "withdraw") {
    await client.sendMessage(message.chat.id, dict.referralWithdrawStub);
    return;
  }

  const helpAction = matchHelpAction(text);
  if (helpAction) {
    if (helpAction === "how") {
      await client.sendMessage(message.chat.id, dict.helpText(config.appUrl));
    } else if (String(message.chat.id) === getSupportChatId()) {
      await client
        .sendMessage(
          message.chat.id,
          "Ты оператор - тикеты от пользователей приходят сюда. Отвечай reply'ем на сообщение тикета."
        )
        .catch(() => undefined);
    } else {
      await openSupport(client, message, from, dict);
    }
    return;
  }

  const source = getVideoSource(message);

  // While a support session is open, capture the conversation. A video is NOT
  // turned into a clip here - tell the user to close the chat first. Screenshots
  // and other media are relayed to the operator.
  if (supportOpen && String(message.chat.id) !== getSupportChatId()) {
    if (source) {
      await client
        .sendMessage(message.chat.id, dict.supportVideoInSession, {
          replyMarkup: supportKeyboard(dict),
        })
        .catch(() => undefined);
      return;
    }
    if (text) {
      await relaySupportMessage(client, from, text);
      return;
    }
    const ok = await relaySupportMedia(client, from, message);
    if (!ok) {
      await client
        .sendMessage(message.chat.id, dict.supportMediaUnsupported)
        .catch(() => undefined);
    }
    return;
  }

  // Session closed: normal product path.
  if (source) {
    await handleVideo(client, message, from, source, dict, config);
    return;
  }

  const url = extractVideoUrl(text);
  if (url) {
    await handleVideoUrl(client, message, from, url, dict, config);
    return;
  }

  await client.sendMessage(message.chat.id, dict.sendVideoHint);
}

function parseMenuCommand(text: string): MenuAction | null {
  const m = /^\/(account|help|settings|plans)(@\S+)?(\s|$)/.exec(text);
  if (!m) return null;
  return m[1] as MenuAction;
}

async function handleMenuAction(
  client: TelegramClient,
  message: TelegramMessage,
  action: MenuAction,
  dict: Dict,
  config: BotRuntimeConfig,
  existing: { id: string } | null
) {
  switch (action) {
    case "account": {
      await sendAccountView(client, message, dict, config, existing);
      return;
    }
    case "help": {
      await client.sendMessage(message.chat.id, dict.helpMenuPrompt, {
        replyMarkup: helpKeyboard(dict),
      });
      return;
    }
    case "settings": {
      await client.sendMessage(message.chat.id, dict.settingsMenuPrompt, {
        replyMarkup: settingsKeyboard(dict),
      });
      return;
    }
    case "affiliate": {
      await handleReferral(client, message, message.from!, dict, config);
      return;
    }
    case "plans": {
      await sendPlansView(client, message, dict, config, existing);
      return;
    }
  }
}

async function handleSettingsAction(
  client: TelegramClient,
  message: TelegramMessage,
  action: SettingsAction,
  dict: Dict
) {
  switch (action) {
    case "lang": {
      await client.sendMessage(message.chat.id, dict.langMenuPrompt, {
        replyMarkup: languageKeyboard(),
      });
      return;
    }
    case "video": {
      const user = await resolveTelegramUser(message.from!);
      await client.sendMessage(message.chat.id, dict.videoSettingsPrompt, {
        replyMarkup: subtitlesKeyboard(dict, user.subtitlesEnabled),
      });
      return;
    }
    case "menu": {
      await sendMainMenu(client, message.chat.id, dict.welcomeBack, dict, message.from!);
      return;
    }
  }
}

// The bot's only paid channel is Tribute, so subscription management and
// cancellation always happen there - never the website.
const TRIBUTE_MANAGE_URL = "https://t.me/tribute";

async function sendAccountView(
  client: TelegramClient,
  message: TelegramMessage,
  dict: Dict,
  config: BotRuntimeConfig,
  existing: { id: string } | null
) {
  if (!existing) {
    const text = dict.accountText({
      plan: "NONE",
      phase: "NONE",
      billingCycleLabel: null,
      periodEnd: null,
      daysUntilPeriodEnd: null,
      minutesUsed: 0,
      minutesLimit: 0,
      topUpMinutes: 0,
      clipsStored: 0,
      storageClipsLimit: 0,
      retentionDays: 0,
      clipsTotal: 0,
    });
    await client.sendMessage(message.chat.id, `${text}\n\n${dict.noPlanNudge}`);
    return;
  }

  const usage = await getUsageForUser(existing.id);

  const periodEnd = usage.currentPeriodEnd
    ? usage.currentPeriodEnd.toISOString().slice(0, 10)
    : null;
  const daysUntilPeriodEnd = usage.currentPeriodEnd
    ? Math.max(
        0,
        Math.ceil(
          (usage.currentPeriodEnd.getTime() - Date.now()) / 86_400_000
        )
      )
    : null;
  // Localized here rather than inside each dictionary: the enum is the same
  // everywhere, the word for it is not.
  const billingCycleLabel = usage.billingCycle
    ? usage.billingCycle === "WEEKLY"
      ? dict.cycleWeekly
      : dict.cycleMonthly
    : null;

  const text = dict.accountText({
    plan: usage.plan,
    billingCycleLabel,
    periodEnd,
    daysUntilPeriodEnd,
    phase: usage.subscriptionState.phase,
    minutesUsed: usage.minutesUsed,
    minutesLimit: usage.minutesLimit,
    topUpMinutes: usage.topUpMinutesRemaining,
    clipsStored: usage.clipsStored,
    storageClipsLimit: usage.storageClipsLimit,
    retentionDays: usage.retentionDays,
    clipsTotal: usage.clipsTotal,
  });

  if (usage.plan === "NONE") {
    await client.sendMessage(message.chat.id, `${text}\n\n${dict.noPlanNudge}`);
    return;
  }

  const manageUrl = TRIBUTE_MANAGE_URL;

  await client.sendMessage(message.chat.id, text, {
    replyMarkup: {
      inline_keyboard: [
        [{ text: dict.manageSubscriptionBtn, url: manageUrl }],
      ],
    },
  });
}

export async function sendPlansView(
  client: TelegramClient,
  message: TelegramMessage,
  dict: Dict,
  config: BotRuntimeConfig,
  existing: { id: string } | null
) {
  // No account, or no live subscription -> show the plans + subscribe buttons.
  if (!existing) {
    await client.sendMessage(message.chat.id, dict.plansText, {
      replyMarkup: plansKeyboard(dict),
      parseMode: "HTML",
    });
    return;
  }

  const usage = await getUsageForUser(existing.id);
  if (usage.plan === "NONE" || !usage.subscriptionState.live) {
    await client.sendMessage(message.chat.id, dict.plansText, {
      replyMarkup: plansKeyboard(dict),
      parseMode: "HTML",
    });
    return;
  }

  // Live subscriber -> status + a single Manage button (-> Tribute). No buy buttons.
  const periodEnd = usage.currentPeriodEnd
    ? usage.currentPeriodEnd.toISOString().slice(0, 10)
    : null;
  const manageUrl = TRIBUTE_MANAGE_URL;

  await client.sendMessage(message.chat.id, dict.plansSubscribed(usage.plan, periodEnd), {
    replyMarkup: {
      inline_keyboard: [[{ text: dict.manageSubscriptionBtn, url: manageUrl }]],
    },
  });
}

/**
 * What the chat has ALREADY been told, for a row whose status write then threw.
 *
 * The two halves of a delivery pass are not equally repeatable: a Telegram send
 * cannot be taken back, a prisma update can be retried for ever. So when the
 * send succeeds and the write fails we are left owing only the write - and the
 * guard that stops the next poll re-sending the identical message cannot live
 * in the database, because the database is the thing that is broken. It lives
 * here, in the poller process, and the next poll flushes the owed write in
 * silence.
 *
 * Bounded by the rows currently in flight: every entry is deleted the moment
 * its write lands, and only a row whose write keeps failing keeps one.
 *
 * A process restart loses the memo, so a crash in exactly that window can still
 * repeat one message once. That is the residue, not the bug: the bug was
 * repeating it every 10 seconds for ever.
 */
type OwedWrite =
  | { kind: "FAILURE_NOTIFIED"; error: string }
  | { kind: "DELIVERED" }
  | { kind: "FAILED"; error: string };

const owedWrites = new Map<string, OwedWrite>();

function flushOwedWrite(deliveryId: string, owed: OwedWrite): Promise<unknown> {
  if (owed.kind === "DELIVERED") return markTelegramDeliverySent(deliveryId);
  if (owed.kind === "FAILURE_NOTIFIED") {
    return markTelegramDeliveryFailureNotified(deliveryId, owed.error);
  }
  return markTelegramDeliveryFailed(deliveryId, owed.error);
}

/**
 * Record the outcome, then write it. Never throws: a status write that escaped
 * the batch loop used to abort every row queued behind it AND leave this one
 * PENDING with a video already in the chat - a second copy on every poll.
 */
async function settleDelivery(deliveryId: string, owed: OwedWrite) {
  owedWrites.set(deliveryId, owed);
  try {
    await flushOwedWrite(deliveryId, owed);
    owedWrites.delete(deliveryId);
  } catch (error) {
    console.error(
      `Telegram delivery ${deliveryId} is ${owed.kind} in the chat but the status write failed; will retry the write only:`,
      error instanceof Error ? error.message : error
    );
  }
}

export async function deliverReadyTelegramJobs(
  client: TelegramClient,
  appUrl: string
) {
  const deliveries = await telegramDeliveryService.getPendingTelegramDeliveries();

  for (const delivery of deliveries) {
    // This row already said its piece; only the bookkeeping is outstanding.
    // Retry that and nothing else - re-sending is the one thing that cannot be
    // undone.
    const owed = owedWrites.get(delivery.id);
    if (owed) {
      try {
        await flushOwedWrite(delivery.id, owed);
        owedWrites.delete(delivery.id);
      } catch (error) {
        console.error(
          `Telegram delivery ${delivery.id}: owed ${owed.kind} write still failing:`,
          error instanceof Error ? error.message : error
        );
      }
      continue;
    }

    // The only irreversible act in this loop is putting a video in the chat:
    // it cannot be taken back, and re-running the row would give the user a
    // second copy. Everything before it - the locale read, signing the URLs,
    // any message send - leaves the chat exactly as it was, so a throw there
    // means "we never got as far as delivering", and the row must stay
    // re-pickable. Closing it there is what billed a healed job and delivered
    // nothing.
    //
    // Re-pickable, but not for ever: the pickup window is 20 rows wide and has
    // no other drain, so each such throw spends one of
    // MAX_TELEGRAM_DELIVERY_ATTEMPTS and the last one retires the row.
    let dict: Dict | null = null;
    let clipsInChat = 0;
    try {
      const locale = await getUserLocale(delivery.userId);
      dict = t(locale);

      if (delivery.job.status === "FAILED") {
        // The user gets localized copy for the parsed code; the raw engine
        // message stays in the DB (Job.error and the delivery row) for support.
        //
        // FAILURE_NOTIFIED, not FAILED: Job.status FAILED is written on every
        // BullMQ attempt, so this may be attempt 1 of 3. If a retry heals the
        // job, getPendingTelegramDeliveries hands this row back once - with the
        // job DONE - and the clips are sent below. That is what makes the
        // failure copy's "wait a few minutes to see if the clips arrive" true.
        await client.sendMessage(
          delivery.chatId,
          dict.processingFailed(parseJobErrorCode(delivery.job.error))
        );
        await settleDelivery(delivery.id, {
          kind: "FAILURE_NOTIFIED",
          error: delivery.job.error || "Job failed",
        });
        continue;
      }

      if (delivery.job.clips.length === 0) {
        await client.sendMessage(
          delivery.chatId,
          dict.doneNoClips(delivery.job.noClipsReason ?? "NO_VIABLE_MOMENTS")
        );
        await settleDelivery(delivery.id, { kind: "DELIVERED" });
        continue;
      }

      // Sign everything BEFORE the chat sees a word. An R2 outage in the
      // middle of the loop used to leave "Done. 3 clips are ready." standing
      // in the chat with no clips behind it - and re-picking the row would
      // repeat that line on every poll. Prepared first, the same outage costs
      // nothing: nothing has been said, and the row is still deliverable.
      const videos = [];
      for (const clip of delivery.job.clips) {
        videos.push({
          url: await getPresignedDownloadUrl(clip.storageKey),
          caption: buildClipCaption({
            title: clip.title,
            description: clip.description,
            lowQuality: clip.lowQuality,
            lowQualityNote: dict.lowQualityNote,
          }),
          editUrl: `${appUrl}/dashboard/editor?clip=${clip.id}`,
        });
      }

      for (const video of videos) {
        await client.sendVideo(delivery.chatId, video.url, video.caption, {
          inline_keyboard: [
            [{ text: dict.editInBrowserBtn, url: video.editUrl }],
          ],
        });
        clipsInChat++;
      }

      // After the clips, not before: it is a summary of what has arrived, and
      // sending it first made it a promise this code could fail to keep - a
      // standing "Done. 3 clips are ready." above an empty chat.
      await client.sendMessage(
        delivery.chatId,
        dict.done(delivery.job.clips.length)
      );

      await settleDelivery(delivery.id, { kind: "DELIVERED" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Delivery failed";

      if (clipsInChat > 0) {
        // Videos are in the chat, so this row is terminal either way. But
        // moving the summary after the clips left a failure mid-batch saying
        // NOTHING at all: one bare video, a job the user was billed for in
        // full, and no way to learn that two more clips existed. The summary
        // does not go back before the clips - that is the promise-we-cannot-
        // keep bug - it becomes an honest report of what actually landed.
        const total = delivery.job.clips.length;
        try {
          await client.sendMessage(
            delivery.chatId,
            clipsInChat < total
              ? dict!.donePartial(clipsInChat, total)
              : // every clip arrived and only the summary itself failed; the
                // user is owed the plain confirmation, not a "3 of 3"
                dict!.done(total)
          );
        } catch (reportError) {
          console.error(
            `Telegram delivery ${delivery.id}: could not report the partial result:`,
            reportError instanceof Error ? reportError.message : reportError
          );
        }
        await settleDelivery(delivery.id, { kind: "FAILED", error: message });
        continue;
      }

      // Nothing reached the chat, so nothing is owed and nothing can be
      // duplicated.
      if (isPermanentTelegramError(message)) {
        // A blocked bot, a deleted chat: no amount of waiting fixes this, and
        // every retry is a doomed API call charged against the bot's global
        // rate limit. Retire it now rather than let it hold a slot in the
        // 20-row window for the whole attempt budget.
        console.error(
          `Telegram delivery ${delivery.id} can never be delivered:`,
          message
        );
        await settleDelivery(delivery.id, { kind: "FAILED", error: message });
        continue;
      }

      try {
        const { terminal } = await markTelegramDeliveryAttemptFailed(
          delivery.id,
          message,
          delivery.attempts
        );
        console.error(
          terminal
            ? `Telegram delivery ${delivery.id} gave up after ${MAX_TELEGRAM_DELIVERY_ATTEMPTS} attempts:`
            : `Telegram delivery ${delivery.id} could not start; will retry:`,
          message
        );

        if (terminal) {
          // Retiring the row used to be a console.error and nothing else: the
          // job is DONE, usage.service bills it (it sums every job that is not
          // FAILED), the clips sit in the database and on R2 - and the chat was
          // never told, ever, because a FAILED row never comes back out of
          // getPendingTelegramDeliveries. This is the last chance to say
          // anything, so it is taken.
          //
          // AFTER the write, never before. The write is what makes the row
          // terminal, and that transition can happen exactly once - so hanging
          // the send off it is what bounds the message at one. Sent first, a
          // write that then threw would leave the row PENDING and re-pickable,
          // and the next poll would send the identical message, six times a
          // minute, for as long as the pool stayed down. A write that throws
          // here simply means nothing is said yet: the attempt is not counted
          // either, and the retry that lands the write also says the line.
          //
          // clips.length, not a promise: on the failure-notice branch it is 0
          // and the copy claims nothing exists.
          try {
            await client.sendMessage(
              delivery.chatId,
              (dict ?? t("en")).deliveryGivenUp(
                appUrl,
                delivery.job.clips.length
              )
            );
          } catch (noticeError) {
            // The chat may be exactly what is broken. The row stays terminal:
            // reopening it would spend a second budget on the same dead send,
            // and the rows behind this one are not to blame for it.
            console.error(
              `Telegram delivery ${delivery.id}: could not tell the user it was given up on:`,
              noticeError instanceof Error ? noticeError.message : noticeError
            );
          }
        }
      } catch (countError) {
        // Even the attempt counter can fail. Log and move on - the rows behind
        // this one are not to blame.
        console.error(
          `Telegram delivery ${delivery.id}: could not record the failed attempt:`,
          countError instanceof Error ? countError.message : countError
        );
      }
    }
  }
}

async function handleStart(
  client: TelegramClient,
  message: TelegramMessage,
  text: string,
  dict: Dict,
  config: BotRuntimeConfig,
  existing: { id: string } | null
) {
  const payload = parseStartPayload(text);

  if (payload?.kind === "link") {
    await handleStartLink(client, message, payload.code, dict, config);
    return;
  }

  if (payload?.kind === "ref") {
    const isNew = !existing;
    const from = message.from!;
    const user = await resolveTelegramUser(from);
    if (isNew) {
      const { referralService } = await import("@clipclap/shared");
      await referralService.attachReferral(user.id, payload.code);
      // The persistent menu (below) carries the 💳 Plans button; no inline
      // plan buttons needed here.
      await client.sendMessage(message.chat.id, dict.newAccountCreated);
      await sendMainMenu(client, message.chat.id, dict.menuHint, dict, from);
      return; // bypass the two-button onboarding screen (deep-link)
    }
    // existing user: fall through to the normal welcome flow below
  }

  if (!existing) {
    await client.sendMessage(message.chat.id, dict.welcomeFirstChoice, {
      replyMarkup: firstChoiceKeyboard(dict),
    });
    // This screen creates no User row - a stranger who reads it and leaves
    // used to be recorded nowhere at all, which is why the size of the
    // population behind our 95 accounts is unknown. Recorded AFTER the reply
    // is out, and recordFunnelEvent never throws, so the first thing this
    // person sees cannot be broken by a telemetry write.
    await recordFunnelEvent(
      "bot",
      message.from!.id,
      FUNNEL_EVENTS.FIRST_SCREEN,
      message.from!.language_code
    );
    return;
  }

  const from = message.from!;
  const user = await resolveTelegramUser(from);
  const usage = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  if (usage.plan === "NONE") {
    // The persistent menu (below) carries the 💳 Plans button; welcomeNeedsPlan
    // nudges the user to it, so no inline plan buttons here.
    await sendMainMenu(client, message.chat.id, dict.welcomeNeedsPlan, dict, from);
    return;
  }

  await sendMainMenu(client, message.chat.id, dict.welcomeBack, dict, from);
}

async function handleCallbackQuery(
  client: TelegramClient,
  query: TelegramCallbackQuery,
  config: BotRuntimeConfig
) {
  if (!query.message || !query.from || !query.data) {
    await client.answerCallbackQuery(query.id).catch(() => undefined);
    return;
  }

  const existing = await prisma.user.findUnique({
    where: { telegramId: String(query.from.id) },
    select: { telegramLocale: true },
  });
  const locale = detectLocale(
    existing?.telegramLocale ?? query.from.language_code
  );
  const dict = t(locale);

  await client.answerCallbackQuery(query.id, dict.callbackAck).catch(() => undefined);

  if (query.data.startsWith("sub:")) {
    const user = await resolveTelegramUser(query.from);
    await handleSubscribeCallback(client, query, dict, user);
    return;
  }

  // Ahead of the switch below, because the callback data carries the language
  // code and there is no longer a finite set of literals to enumerate as cases.
  const langChoice = parseLangCallback(query.data);
  if (langChoice) {
    const ack = await applyLangChoice(query.from, langChoice);
    await client
      .editMessageText(query.message.chat.id, query.message.message_id, ack)
      .catch(() => undefined);
    // The edit above changes the message the picker was in - it cannot touch
    // the reply keyboard, which Telegram binds to a message at send time. The
    // picker is only ever reached from the settings screen, so that keyboard
    // is sitting there in the language the user just left, and every one of
    // its labels is now stale. It used to stay stale until the user pressed
    // "Menu" and something happened to re-send it.
    //
    // Re-sent as the settings screen rather than the main menu: it is where
    // the user actually is, and unlike sendMainMenu it records no app-open for
    // a menu nobody opened.
    const chosen = t(langChoice);
    await client
      .sendMessage(query.message.chat.id, chosen.settingsMenuPrompt, {
        replyMarkup: settingsKeyboard(chosen),
      })
      .catch(() => undefined);
    return;
  }

  switch (query.data) {
    case CALLBACK_NEW_ACCOUNT: {
      await resolveTelegramUser(query.from);
      await client
        .editMessageText(
          query.message.chat.id,
          query.message.message_id,
          dict.newAccountCreated
        )
        .catch(() => undefined);
      // The other half of the funnel: this person went PAST the first screen.
      // Counted here rather than inferred from users.createdAt so both halves
      // are one query against one table, and so the two doors stay apart.
      await recordFunnelEvent(
        "bot",
        query.from.id,
        FUNNEL_EVENTS.NEW_ACCOUNT,
        query.from.language_code
      );
      await sendMainMenu(client, query.message.chat.id, dict.menuHint, dict, query.from);
      return;
    }
    case CALLBACK_LINK_ACCOUNT: {
      const { code } = await createBotInitiatedLink({
        telegramId: String(query.from.id),
      });
      await client
        .editMessageText(
          query.message.chat.id,
          query.message.message_id,
          dict.linkAccountInstructions(code, config.appUrl)
        )
        .catch(() => undefined);
      await recordFunnelEvent(
        "bot",
        query.from.id,
        FUNNEL_EVENTS.LINK_ACCOUNT,
        query.from.language_code
      );
      return;
    }
    case CALLBACK_SUBTITLES_TOGGLE: {
      await handleSubtitlesToggle(client, query, dict);
      return;
    }
    default:
      return;
  }
}

function firstChoiceKeyboard(dict: Dict): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.newAccountBtn, callback_data: CALLBACK_NEW_ACCOUNT }],
      [{ text: dict.linkAccountBtn, callback_data: CALLBACK_LINK_ACCOUNT }],
    ],
  };
}

/** One row per supported language, each labelled in itself - so it takes no
 *  Dict argument: the picker deliberately does not follow the locale the user
 *  is currently stuck in. */
export function languageKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: LOCALES.map((loc) => [
      { text: t(loc).langBtn, callback_data: langCallbackData(loc) },
    ]),
  };
}

export function subtitlesKeyboard(dict: Dict, enabled: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.subtitlesToggleBtn(enabled), callback_data: CALLBACK_SUBTITLES_TOGGLE }],
    ],
  };
}

export async function handleSubtitlesToggle(
  client: TelegramClient,
  query: TelegramCallbackQuery,
  dict: Dict
): Promise<void> {
  if (!query.message || !query.from) return;
  const user = await resolveTelegramUser(query.from);
  const enabled = !user.subtitlesEnabled;
  await prisma.user.update({
    where: { id: user.id },
    data: { subtitlesEnabled: enabled },
  });
  await client
    .editMessageText(query.message.chat.id, query.message.message_id, dict.subtitlesAck(enabled), {
      replyMarkup: subtitlesKeyboard(dict, enabled),
    })
    .catch(() => undefined);
}

export function plansKeyboard(dict: Dict): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.planStarterWeeklyBtn, callback_data: "sub:STARTER:WEEKLY" }],
      [{ text: dict.planStarterBtn, callback_data: "sub:STARTER:MONTHLY" }],
      [{ text: dict.planPlusBtn, callback_data: "sub:PLUS:MONTHLY" }],
      [{ text: dict.planMaxBtn, callback_data: "sub:MAX:MONTHLY" }],
    ],
  };
}

export type SubPlan = "STARTER" | "PLUS" | "MAX";
export type SubCycle = "WEEKLY" | "MONTHLY";

const PLAN_TITLES: Record<SubPlan, string> = { STARTER: "Starter", PLUS: "Plus", MAX: "Max" };

export function parseSubCallback(
  data: string | undefined
): { plan: SubPlan; cycle: SubCycle } | null {
  if (!data || !data.startsWith("sub:")) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [, plan, cycle] = parts;
  const isPlan = plan === "STARTER" || plan === "PLUS" || plan === "MAX";
  const isCycle = cycle === "WEEKLY" || cycle === "MONTHLY";
  if (!isPlan || !isCycle) return null;
  // Only STARTER offers weekly; PLUS/MAX are monthly-only.
  if (cycle === "WEEKLY" && plan !== "STARTER") return null;
  return { plan: plan as SubPlan, cycle: cycle as SubCycle };
}

// In-memory per-user lock: prevents a double-tap from minting two orders.
const subscribeLocks = new Set<string>();

export async function handleSubscribeCallback(
  client: TelegramClient,
  query: TelegramCallbackQuery,
  dict: Dict,
  user: { id: string }
): Promise<void> {
  const parsed = parseSubCallback(query.data);
  if (!parsed || !query.message || !query.from) return;

  const telegramId = String(query.from.id);
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (subscribeLocks.has(telegramId)) return;
  subscribeLocks.add(telegramId);
  try {
    const entry = getTributeCatalogEntry(parsed.plan, parsed.cycle);

    // Reuse a fresh PENDING order for the same user+plan+cycle (avoids a second order).
    const fresh = await prisma.tributeOrder.findFirst({
      where: {
        userId: user.id,
        plan: parsed.plan,
        billingCycle: parsed.cycle,
        status: "PENDING",
        createdAt: { gt: new Date(Date.now() - 15 * 60_000) },
      },
      orderBy: { createdAt: "desc" },
    });

    let payUrl: string;
    if (fresh) {
      payUrl = fresh.payUrl;
    } else {
      const checkoutIntentId = randomUUID();
      let result: { uuid: string; webappPaymentUrl: string };
      try {
        result = await createShopOrder({
          plan: parsed.plan,
          billingCycle: parsed.cycle,
          telegramId,
          checkoutIntentId,
        });
      } catch (err) {
        console.error("[tribute] createShopOrder failed", { telegramId, checkoutIntentId, err });
        await client.sendMessage(chatId, dict.checkoutError).catch(() => undefined);
        return;
      }

      try {
        await prisma.tributeOrder.create({
          data: {
            orderUuid: result.uuid,
            userId: user.id,
            telegramId,
            plan: parsed.plan,
            billingCycle: parsed.cycle,
            amount: entry.amount,
            currency: entry.currency,
            payUrl: result.webappPaymentUrl,
            status: "PENDING",
          },
        });
      } catch (err) {
        // Remote order exists but we could not record it: cancel it so the user
        // is never handed an order we cannot track, then ask them to retry.
        console.error("[tribute] order insert failed; cancelling remote order", {
          checkoutIntentId,
          uuid: result.uuid,
          err,
        });
        await cancelShopOrder(result.uuid).catch(() => undefined);
        await client.sendMessage(chatId, dict.checkoutError).catch(() => undefined);
        return;
      }
      payUrl = result.webappPaymentUrl;
    }

    const planLabel = `${PLAN_TITLES[parsed.plan]} (${
      parsed.cycle === "WEEKLY" ? dict.cycleWeekly : dict.cycleMonthly
    })`;
    await client
      .editMessageText(chatId, messageId, dict.checkoutReady(planLabel), {
        replyMarkup: { inline_keyboard: [[{ text: dict.payBtn, url: payUrl }]] },
      })
      .catch(() => undefined);
  } finally {
    subscribeLocks.delete(telegramId);
  }
}

async function applyLangChoice(
  from: TelegramUser,
  choice: Locale
): Promise<string> {
  const user = await resolveTelegramUser(from);
  await prisma.user.update({
    where: { id: user.id },
    data: { telegramLocale: choice },
  });
  return t(choice).langSet;
}

async function handleLang(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  choice: ReturnType<typeof parseLangCommand>,
  currentDict: Dict
) {
  if (choice === "usage" || choice === null) {
    await client.sendMessage(
      message.chat.id,
      currentDict.langUsage(langOptionsList())
    );
    return;
  }

  const ack = await applyLangChoice(from, choice);
  // The ack carries the refreshed keyboard rather than being followed by a
  // second message: /lang is a top-level command that can be typed from any
  // screen, so the main menu is the only keyboard that is right from all of
  // them - and attaching it here costs no extra message at all. Without this
  // the labels stayed in the old language until something else re-sent them.
  await client.sendMessage(message.chat.id, ack, {
    replyMarkup: mainMenuKeyboard(t(choice)),
  });
}

async function handleStartLink(
  client: TelegramClient,
  message: TelegramMessage,
  code: string,
  dict: Dict,
  config: BotRuntimeConfig
) {
  const from = message.from!;
  await resolveTelegramUser(from);

  const result = await redeemLinkFromBot({
    code,
    telegramId: String(from.id),
  });

  await client.sendMessage(
    message.chat.id,
    renderLinkResult(result, dict, config)
  );
}

async function handleLink(
  client: TelegramClient,
  message: TelegramMessage,
  dict: Dict,
  config: BotRuntimeConfig
) {
  const from = message.from!;
  const { code } = await createBotInitiatedLink({ telegramId: String(from.id) });
  await client.sendMessage(
    message.chat.id,
    dict.linkCodePrompt(code, config.appUrl)
  );
}

function renderLinkResult(
  result: Awaited<ReturnType<typeof redeemLinkFromBot>>,
  dict: Dict,
  _config: BotRuntimeConfig
): string {
  switch (result.status) {
    case "linked":
      return dict.linkSuccess(result.mergedClips);
    case "already_linked":
      return dict.linkAlready;
    case "invalid_code":
      return dict.linkInvalid;
    case "expired":
      return dict.linkExpired;
    case "consumed":
      return dict.linkInvalid;
    case "wrong_direction":
      return dict.linkWrongDirection;
    case "target_already_linked":
      return dict.linkConflict;
  }
}

type StartPayload =
  | { kind: "link"; code: string }
  | { kind: "ref"; code: string }
  | null;

export function parseStartPayload(text: string): StartPayload {
  const trimmed = text.replace(/^\/start(@\S+)?\s*/, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("link_")) {
    const code = trimmed.slice("link_".length).trim();
    if (code) return { kind: "link", code };
  }
  if (trimmed.startsWith("ref_")) {
    const code = trimmed.slice("ref_".length).trim();
    if (code) return { kind: "ref", code };
  }
  return null;
}

async function getUserLocale(userId: string): Promise<Locale> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramLocale: true },
  });
  return detectLocale(user?.telegramLocale ?? undefined);
}

/**
 * The free-tier reservation to write with the Job row, or undefined if this
 * account is paying.
 *
 * The plan/status pair mirrors canSubmitJob's routing into checkFreeTrial
 * exactly, and the web route's freeChargeFor makes the same test. All three have
 * to agree or an account gets gated on one basis and charged on another.
 * `plan === "NONE"` alone would not do: a canceled ex-subscriber can hold plan
 * NONE with a non-NONE subscriptionStatus, and putting their job in the free
 * ledger would count a paid run against the free monthly budget.
 */
function freeChargeFor(
  user: Pick<User, "plan" | "subscriptionStatus">,
  durationSec: number | undefined
): FreeChargeInput | undefined {
  if (user.plan !== "NONE" || user.subscriptionStatus !== "NONE") {
    return undefined;
  }
  const seconds = durationSec && durationSec > 0 ? Math.round(durationSec) : 0;
  return { seconds, estimatedCostUsd: estimatedFreeCostUsd(seconds) };
}

async function handleVideo(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  source: VideoSource,
  dict: Dict,
  config: BotRuntimeConfig
) {
  const user = await resolveTelegramUser(from);
  await recordFunnelEvent(
    "bot",
    from.id,
    FUNNEL_EVENTS.VIDEO_SUBMITTED,
    from.language_code
  );
  const subject = { telegramId: from.id, locale: from.language_code };
  const blockedReason = await getSubmissionBlocker(user.id, dict, source.duration, subject);
  if (blockedReason) {
    await client.sendMessage(
      message.chat.id,
      dict.blocked(blockedReason)
    );
    return;
  }

  // The ack goes out only after the blocker check: no neutral ("received,
  // checking...") copy exists for this path, and telling someone we are
  // "Uploading your video..." right before refusing them is worse than the
  // telemetry write landing a beat before the first reply.
  await client.sendMessage(message.chat.id, dict.uploading);

  if (
    typeof source.fileSize === "number" &&
    source.fileSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES
  ) {
    await client.sendMessage(message.chat.id, dict.fileTooLarge(config.appUrl));
    return;
  }

  const tempDir = join(tmpdir(), "clipclap-telegram");
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${source.fileUniqueId}.mp4`);

  try {
    try {
      await client.downloadFile(source.fileId, tempPath);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      console.error("[handleVideo] downloadFile failed:", rawMessage);
      const messageText = rawMessage.toLowerCase();
      if (messageText.includes("file is too big")) {
        await client.sendMessage(
          message.chat.id,
          dict.fileTooLarge(config.appUrl)
        );
        return;
      }
      throw error;
    }

    const sourceKey = `uploads/${user.id}/telegram/${Date.now()}-${source.fileUniqueId}.mp4`;
    await uploadFile(sourceKey, tempPath, source.mimeType || "video/mp4");

    const job = await jobService.createJob({
      userId: user.id,
      sourceKey,
      originalFilename: source.fileName || "telegram-video.mp4",
      subtitles: user.subtitlesEnabled,
      sourceDurationSec: source.duration,
      // Telegram's own video metadata, which is as good as it gets before the
      // download stage measures the file. Reserved anyway rather than left to
      // that stage: an unreserved free upload spends nothing from the ledger
      // until DOWNLOAD, and until then the account looks untouched to every
      // other submission it makes in the meantime.
      freeCharge: freeChargeFor(user, source.duration),
    });

    await createTelegramDelivery({
      jobId: job.id,
      userId: user.id,
      chatId: String(message.chat.id),
    });

    await client.sendMessage(message.chat.id, dict.queued);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function handleVideoUrl(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  url: string,
  dict: Dict,
  config: BotRuntimeConfig
) {
  await client.sendMessage(message.chat.id, dict.checkingLink);
  // Recorded here - not after the probe - so a dead or unsupported link still
  // counts as an attempt. That is the distinction this event exists to keep.
  await recordFunnelEvent(
    "bot",
    from.id,
    FUNNEL_EVENTS.VIDEO_SUBMITTED,
    from.language_code
  );

  const probe = await probeVideoUrl(url);
  if (!probe.ok) {
    await client.sendMessage(message.chat.id, dict.urlAccessFailed);
    return;
  }

  const user = await resolveTelegramUser(from);
  const subject = { telegramId: from.id, locale: from.language_code };
  const blockedReason = await getSubmissionBlocker(user.id, dict, probe.durationSec, subject);
  if (blockedReason) {
    await client.sendMessage(
      message.chat.id,
      dict.blocked(blockedReason)
    );
    return;
  }

  // Int column, float probe. YouTube happens to answer whole seconds, which is
  // why this never bit in prod, but archive.org and friends answer 596.46 and
  // prisma.job.create rejects a Float for an Int - the link would die with an
  // unhandled error after the user had already been told we were checking it.
  const probedSec = Math.round(probe.durationSec);

  const job = await jobService.createJob({
    userId: user.id,
    sourceUrl: url,
    originalFilename: probe.title,
    subtitles: user.subtitlesEnabled,
    sourceDurationSec: probedSec,
    freeCharge: freeChargeFor(user, probedSec),
  });

  await createTelegramDelivery({
    jobId: job.id,
    userId: user.id,
    chatId: String(message.chat.id),
  });

  await client.sendMessage(message.chat.id, dict.queued);
}

async function resolveTelegramUser(from: TelegramUser): Promise<User> {
  return findOrCreateTelegramUser({
    id: from.id,
    firstName: from.first_name,
    lastName: from.last_name,
    username: from.username,
    languageCode: from.language_code,
  });
}

/** Paid-plan Starter numbers quoted in the free-tier block copy, so the
 *  "what a plan gives you" half of those messages cannot drift from the real
 *  prices. Weekly is quoted because it is the cheapest way in. */
const STARTER_WEEKLY = getPlanLimits("STARTER", "WEEKLY");

/**
 * Returns the text to show the user, or null to let the submission through.
 *
 * The decision itself belongs to canSubmitJob in the shared service - this
 * function only chooses the WORDS. That split matters: this used to return the
 * bare English sentence "Active subscription required to process videos."
 * straight to the chat, past the EN/RU dictionary, to an audience whose
 * largest single locale is Russian. Blocks now arrive as a code and are
 * rendered from `dict`, so a Russian user reads Russian.
 */
export async function getSubmissionBlocker(
  userId: string,
  dict: Dict,
  durationSec?: number,
  subject?: { telegramId: string | number; locale?: string }
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const durationMinutes =
    typeof durationSec === "number" && durationSec > 0
      ? Math.ceil(durationSec / 60)
      : 0;

  // NOTE: this still records before the reply this text goes into is sent -
  // it can't be deferred to the call site without widening this function's
  // return type from string|null to something structured, which would also
  // touch every other test that calls getSubmissionBlocker directly. Recorded
  // here, ahead of the reply, as the accepted compromise.
  const recordRejection = (code: UploadRejectionCode) =>
    subject
      ? recordFunnelEvent("bot", subject.telegramId, uploadRejectedEvent(code), subject.locale)
      : Promise.resolve();

  if (
    durationMinutes > 0 &&
    durationMinutes > limits.maxSourceDurationMinutes
  ) {
    if (user.plan === "NONE") {
      await recordRejection("FREE_SOURCE_TOO_LONG");
      return dict.freeSourceTooLong(
        limits.maxSourceDurationMinutes,
        STARTER_WEEKLY.maxSourceDurationMinutes
      );
    }
    await recordRejection("TOO_LONG");
    return dict.planSourceTooLong(limits.maxSourceDurationMinutes);
  }

  const submission = await canSubmitJob(userId, durationMinutes);
  if (!submission.allowed) {
    await recordRejection(submission.code);
    switch (submission.code) {
      // Unreachable in practice: every account that reaches this function came
      // in through Telegram, so it carries a phone-backed telegramId and
      // isTrialAnchored returns true on that alone. Rendered anyway, because
      // the code is part of the shared union and the alternative is an English
      // log sentence in a Russian chat.
      case "FREE_NOT_ANCHORED":
        return dict.freeNotAnchored(
          STARTER_WEEKLY.minutesPerPeriod,
          STARTER_WEEKLY.priceUsd
        );
      case "FREE_EXHAUSTED":
        // Floored to whole minutes, and floored rather than rounded: telling
        // someone they have 1 minute left when they have 30 seconds would be
        // a promise the next submission breaks. The fallbacks only fire if a
        // future code path forgets to attach `trial` - 0 remaining is the safe
        // thing to claim, never a balance the user might not have.
        return dict.freeExhausted(
          Math.floor((submission.trial?.remainingSeconds ?? 0) / 60),
          Math.floor(
            (submission.trial?.lifetimeSeconds ?? FREE_TIER.lifetimeSeconds) / 60
          ),
          STARTER_WEEKLY.minutesPerPeriod,
          STARTER_WEEKLY.priceUsd
        );
      case "FREE_BUDGET_CLOSED":
        return dict.freeBudgetClosed(
          STARTER_WEEKLY.minutesPerPeriod,
          STARTER_WEEKLY.priceUsd
        );
      case "FREE_SOURCE_TOO_LONG":
        return dict.freeSourceTooLong(
          getPlanLimits("NONE").maxSourceDurationMinutes,
          STARTER_WEEKLY.maxSourceDurationMinutes
        );
      case "LIFECYCLE":
        return renderLifecycleBlock(submission.phase, dict);
      case "QUOTA":
        // The numbers come off the structured `quota` detail, never off
        // `reason` - that string is written for a log line. If a future code
        // path omits it, fall back to the plan's own limits rather than to
        // English prose.
        return dict.planQuotaExceeded(
          submission.quota?.usedMinutes ?? limits.minutesPerPeriod,
          submission.quota?.limitMinutes ?? limits.minutesPerPeriod,
          submission.quota?.topUpMinutes ?? 0
        );
      default:
        // Unreachable while SubmissionBlockCode is fully covered above; the
        // exhaustiveness assignment below makes a new code a compile error
        // rather than a new English sentence in a Russian chat.
        return assertBlockCodeHandled(submission.code, dict);
    }
  }

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const jobsToday = await prisma.job.count({
    where: { userId, createdAt: { gte: dayStart } },
  });
  if (jobsToday >= limits.maxJobsPerDay) {
    return dict.planDailyLimit(limits.maxJobsPerDay);
  }

  const inFlight = await prisma.job.count({
    where: { userId, status: { in: [...ACTIVE_STATUSES] } },
  });
  if (inFlight >= limits.concurrentJobsLimit) {
    return dict.planConcurrentLimit(inFlight, limits.concurrentJobsLimit);
  }

  return null;
}

/**
 * The lifecycle phase decides the sentence: "canceled" and "the period ran
 * out" ask the user for different things, and a user who never had a plan is
 * a third case again. ACTIVE and DUNNING never reach here (canSubmitJob only
 * emits LIFECYCLE when the state is not live) but the map is total so a
 * future phase cannot silently fall through to English.
 */
function renderLifecycleBlock(
  phase: SubscriptionPhase | undefined,
  dict: Dict
): string {
  switch (phase) {
    case "CANCELED":
    case "CANCELED_GRACE":
      return dict.planCanceled;
    case "PERIOD_ENDED":
      return dict.planPeriodEnded;
    // NONE, ACTIVE, DUNNING and an absent phase all land on the same honest
    // statement: there is nothing active on this account right now.
    default:
      return dict.planNotActive;
  }
}

/**
 * Compile-time guard: adding a SubmissionBlockCode without giving it words
 * fails typecheck here instead of shipping an English log string to a chat.
 * At runtime it degrades to the generic "no active plan" line, which is the
 * safest thing to say when we do not know why we refused.
 */
function assertBlockCodeHandled(code: never, dict: Dict): string {
  console.error(`getSubmissionBlocker: no copy for block code ${code}`);
  return dict.planNotActive;
}

interface VideoSource {
  fileId: string;
  fileUniqueId: string;
  duration?: number;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

const TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES = process.env.TELEGRAM_API_BASE_URL
  ? 2 * 1024 * 1024 * 1024 // self-hosted Bot API server: 2 GB
  : 20 * 1024 * 1024; // cloud Bot API: 20 MB

function getVideoSource(message: TelegramMessage): VideoSource | null {
  if (message.video) return fromTelegramVideo(message.video);
  if (message.document?.mime_type?.startsWith("video/")) {
    return fromTelegramDocument(message.document);
  }
  return null;
}

function fromTelegramVideo(video: TelegramVideo): VideoSource {
  return {
    fileId: video.file_id,
    fileUniqueId: video.file_unique_id,
    duration: video.duration,
    fileName: video.file_name,
    mimeType: video.mime_type,
    fileSize: video.file_size,
  };
}

function fromTelegramDocument(document: TelegramDocument): VideoSource {
  return {
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id,
    fileName: document.file_name,
    mimeType: document.mime_type,
    fileSize: document.file_size,
  };
}

async function handleReferral(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  dict: Dict,
  config: BotRuntimeConfig
) {
  const user = await resolveTelegramUser(from);
  const { referralService } = await import("@clipclap/shared");
  const code = await referralService.ensureReferralCode(user.id);
  const stats = await referralService.getReferralStats(user.id);
  const botName = process.env.TELEGRAM_BOT_USERNAME ?? "ClipClapBot";
  const web = `${config.appUrl}/?ref=${code}`;
  const tg = `https://t.me/${botName}?start=ref_${code}`;
  await client.sendMessage(
    message.chat.id,
    dict.referralInfo(
      web,
      tg,
      stats.earnedUsd.toFixed(2),
      stats.pendingUsd.toFixed(2)
    ),
    { replyMarkup: referralKeyboard(dict) }
  );
}

async function handleBalance(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  dict: Dict
) {
  const user = await resolveTelegramUser(from);
  const { walletService, referralService } = await import("@clipclap/shared");
  const bal = await walletService.getWalletBalance(user.id);
  const stats = await referralService.getReferralStats(user.id);
  await client.sendMessage(
    message.chat.id,
    dict.balanceInfo(bal.availableUsd.toFixed(2), stats.pendingUsd.toFixed(2))
  );
}

async function handleAdminCommand(
  client: TelegramClient,
  message: TelegramMessage,
  text: string
) {
  const { withdrawalService, referralService } = await import("@clipclap/shared");
  const chatId = message.chat.id;

  if (text.startsWith("/payouts")) {
    const withdrawals = await withdrawalService.listPendingWithdrawals();
    if (withdrawals.length === 0) {
      await client.sendMessage(chatId, "No pending withdrawals.");
      return;
    }
    const lines = withdrawals.map(
      (w) =>
        `${w.id}\n  ${w.status} $${w.amountUsd.toFixed(2)} ${w.method} -> ${w.destination}`
    );
    await client.sendMessage(
      chatId,
      `Pending withdrawals:\n${lines.join("\n")}\n\n` +
        `Approve: /approve <id> <networkFee>\nPaid: /paid <id> <txRef>\nReject: /reject <id> <reason>`
    );
    return;
  }

  if (text.startsWith("/ref ")) {
    const key = text.slice("/ref ".length).trim();
    const card = await referralService.getReferrerCard(key);
    if (!card) {
      await client.sendMessage(chatId, "Referrer not found.");
      return;
    }
    await client.sendMessage(
      chatId,
      `Referrer ${card.user.id} (${card.user.referralCode ?? "no code"})\n` +
        `Referred: ${card.user._count.referrals}\n` +
        `Ledger $${card.balance.ledgerBalanceUsd.toFixed(2)} - ` +
        `Locked $${card.balance.lockedUsd.toFixed(2)} - ` +
        `Available $${card.balance.availableUsd.toFixed(2)}\n` +
        `Paid out $${card.balance.paidOutUsd.toFixed(2)}\n` +
        `Referral earned $${(card.bySource["REFERRAL"] ?? 0).toFixed(2)}\n` +
        `Voided: ${card.refundCount}  Status: ${card.user.referralBannedAt ? "BANNED" : "active"}`
    );
    return;
  }

  if (text.startsWith("/refban ")) {
    const userId = text.slice("/refban ".length).trim();
    await referralService.banReferrer(userId);
    await client.sendMessage(chatId, `Banned ${userId} from future accrual.`);
    return;
  }

  if (text.startsWith("/refvoid ")) {
    const rest = text.slice("/refvoid ".length).trim();
    const [userId, ...reasonParts] = rest.split(/\s+/);
    const reason = reasonParts.join(" ");
    if (!userId || !reason) {
      await client.sendMessage(chatId, "Usage: /refvoid <userId> <reason>");
      return;
    }
    const { voided } = await referralService.voidReferrerCommissions(userId, reason);
    await client.sendMessage(chatId, `Voided ${voided} commissions for ${userId}.`);
    return;
  }
}

async function handleAdminPayoutAction(
  client: TelegramClient,
  message: TelegramMessage,
  text: string
) {
  const { withdrawalService } = await import("@clipclap/shared");
  const chatId = message.chat.id;
  const adminId = String(message.from!.id);
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];
  const id = parts[1];

  if (!id) {
    await client.sendMessage(chatId, `Usage: ${cmd} <id>`);
    return;
  }

  if (cmd === "/approve") {
    const fee = Number(parts[2] ?? "0");
    const r = await withdrawalService.approveWithdrawal(id, adminId, Number.isFinite(fee) ? fee : 0);
    await client.sendMessage(chatId, r.ok ? `Approved ${id} (fee $${fee}).` : (r.error ?? "Failed"));
    return;
  }
  if (cmd === "/paid") {
    const txRef = parts.slice(2).join(" ");
    const r = await withdrawalService.markWithdrawalPaid(id, adminId, txRef);
    await client.sendMessage(chatId, r.ok ? `Marked ${id} paid (tx ${txRef}).` : (r.error ?? "Failed"));
    return;
  }
  if (cmd === "/reject") {
    const reason = parts.slice(2).join(" ");
    const r = await withdrawalService.rejectWithdrawal(id, adminId, reason || "rejected");
    await client.sendMessage(chatId, r.ok ? `Rejected ${id}.` : (r.error ?? "Failed"));
    return;
  }
}
