import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  ACTIVE_JOB_STATUSES,
  FUNNEL_EVENTS,
  buildClipCaption,
  campaignStartEvent,
  cancelShopOrder,
  canSubmitJob,
  createBotInitiatedLink,
  createShopOrder,
  createTelegramDelivery,
  deleteFile,
  estimatedFreeCostUsd,
  FREE_TIER,
  freeBalanceSeconds,
  freeBudgetStatus,
  getOrCreateTelegramUser,
  getPlanLimits,
  getTributeCatalogEntry,
  isBelowSourceFloor,
  isShortSource,
  SOURCE_FLOOR,
  telegramSourceFingerprint,
  urlSourceFingerprint,
  getUsageForUser,
  isPermanentTelegramError,
  jobService,
  markTelegramDeliveryAttemptFailed,
  markTelegramDeliveryFailed,
  markTelegramDeliveryFailureNotified,
  markTelegramDeliverySent,
  MAX_TELEGRAM_DELIVERY_ATTEMPTS,
  isClipFeedbackEnabled,
  parseJobErrorCode,
  prisma,
  recordClipFeedback,
  recordFunnelEvent,
  recordSupportMessage,
  sanitiseCampaignSlug,
  type SupportKind,
  recordUploadRefusal,
  redeemLinkFromBot,
  refusalHost,
  submissionQueueEnabled,
  telegramDeliveryService,
  uploadFile,
} from "@clipclap/shared";
import type {
  DuplicateJob,
  FreeChargeInput,
  RefusalDetail,
  SubscriptionPhase,
  UploadRejectionCode,
} from "@clipclap/shared";
import type { JobStatus, User } from "@prisma/client";
import type { TelegramClient } from "./telegram-client";
import { deliverClips, rearmDeliveryForResend } from "./clip-delivery";
import {
  parseFeedbackCallback,
  reasonKeyboard,
  reasonLabel,
  verdictKeyboard,
} from "./clip-feedback-keyboard";
import { extractVideoUrl, isYouTubeUrl, probeVideoUrl } from "./url-probe";
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
/** Under every refusal. The refusal copy has always ENDED with "💳 Plans -
 *  choose or manage your subscription", as a sentence; 31 free_exhausted
 *  refusals to one user produced zero checkouts, and the Plans entry was a
 *  reply-keyboard button somewhere below the conversation. Now the sentence
 *  has a button. */
export const CALLBACK_PLANS_OPEN = "plans:open";

/** The one-button keyboard under a refusal: opens the plans view. */
export function blockedKeyboard(dict: Dict): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: dict.menuPlans, callback_data: CALLBACK_PLANS_OPEN }]],
  };
}

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

export type MenuAction =
  | "create"
  | "account"
  | "help"
  | "settings"
  | "earn"
  | "plans";

export function matchMenuAction(text: string): MenuAction | null {
  for (const loc of LOCALES) {
    const d = t(loc);
    if (text === d.menuCreate) return "create";
    if (text === d.menuAccount) return "account";
    if (text === d.menuHelp) return "help";
    if (text === d.menuSettings) return "settings";
    if (text === d.menuEarn) return "earn";
    if (text === d.menuPlans) return "plans";
  }
  return null;
}

export type SettingsAction = "lang" | "video" | "link" | "menu";

export function matchSettingsAction(text: string): SettingsAction | null {
  for (const loc of LOCALES) {
    const d = t(loc);
    if (text === d.settingsLangBtn) return "lang";
    if (text === d.settingsVideoBtn) return "video";
    if (text === d.settingsLinkBtn) return "link";
    if (text === d.settingsBackBtn) return "menu";
  }
  return null;
}

export type EarnAction = "referral" | "advertisers";

export function matchEarnAction(text: string): EarnAction | null {
  for (const loc of LOCALES) {
    const d = t(loc);
    if (text === d.earnReferralBtn) return "referral";
    if (text === d.earnAdvertisersBtn) return "advertisers";
  }
  return null;
}

/** 💰 Earn, which now covers two unrelated offers: the referral programme that
 *  pays for invites, and the advertiser brokerage that is not built yet.
 *
 *  Shown to everyone, unconditionally. A version gated on `clipsTotal >= 1` was
 *  considered and dropped: the brokerage is a revenue line rather than growth
 *  mechanics, and progressive disclosure buys less than it costs in complexity. */
function earnKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.earnReferralBtn }],
      [{ text: dict.earnAdvertisersBtn }],
      [{ text: dict.settingsBackBtn }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
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
  // Recorded after the relay, never before: the operator's own visibility must
  // not come at the cost of the owner seeing the ticket. Stored even when the
  // relay above failed, because a message we could not forward is exactly the
  // one nobody would otherwise ever see.
  await recordSupportMessage({
    telegramId: from.id,
    direction: "in",
    text,
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
    await recordSupportMessage({
      telegramId: from.id,
      direction: "in",
      text: message.caption ?? "",
      kind: supportMediaKind(message),
    });
    return true;
  } catch (e) {
    console.error(`Failed to relay support media to ${chat}:`, e);
    return false;
  }
}

/** What arrived, for the support log. The relay itself copies whatever it is. */
export function supportMediaKind(message: TelegramMessage): SupportKind {
  if (message.photo) return "photo";
  if (message.video) return "video";
  if (message.voice) return "voice";
  if (message.document) return "document";
  return "other";
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
  // Only after a delivery that did not throw - the early return above covers
  // the blocked-bot case, so this table never claims we said something the
  // person did not receive.
  await recordSupportMessage({ telegramId: uid, direction: "out", text });
}

function settingsKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.settingsLangBtn }, { text: dict.settingsVideoBtn }],
      // Where account linking lives now that the first screen no longer asks
      // about it. Someone who paid on the website and then opened the bot looks
      // here; /link and the website's deep link both still work.
      [{ text: dict.settingsLinkBtn }],
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

/** The main menu, with the product's own action on it at last.
 *
 *  It used to be five buttons - Plans, Account, Affiliate, Help, Settings - and
 *  not one of them was "make a clip": a new arrival was shown the till, the
 *  referral scheme and the help desk, and nothing about what the bot does.
 *  🎬 now sits alone on the first row, full width, which is the only position
 *  that reads as primary. The rest keeps its old shape so returning users are
 *  not made to relearn anything. */
function buildMainMenu(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.menuCreate }],
      [{ text: dict.menuPlans }, { text: dict.menuAccount }],
      [{ text: dict.menuEarn }, { text: dict.menuHelp }],
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
      matchEarnAction(text) !== null ||
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
    // menuTitle, not welcomeBack: this is navigation, and greeting somebody who
    // never left reads as the bot having lost track of the conversation.
    await sendMainMenu(client, message.chat.id, dict.menuTitle, dict, from);
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
    await handleSettingsAction(client, message, settingsAction, dict, config);
    return;
  }

  const earnAction = matchEarnAction(text);
  if (earnAction) {
    await handleEarnAction(client, message, from, earnAction, dict, config);
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

  // A reply to one of our own clip videos is feedback, not a submission.
  //
  // Below the support capture on purpose: an open ticket is a deliberate act by
  // the user and the operator is waiting for that text. Above the URL branch on
  // purpose: see tryRecordClipReply for why a miss is swallowed rather than
  // passed on.
  const repliedTo = message.reply_to_message;
  if (repliedTo?.from?.is_bot && repliedTo.video && text && existing?.id) {
    const outcome = await tryRecordClipReply(existing.id, repliedTo.message_id, text);
    if (outcome !== "empty") {
      // "recorded" is the only outcome that may claim success. The other two
      // still return here rather than falling through: a reply that happens to
      // contain a link must never reach the URL branch and start a job the user
      // did not ask for, and that risk is identical whether the anchor was
      // missing or the database refused.
      await client
        .sendMessage(
          message.chat.id,
          outcome === "recorded" ? dict.feedbackNoteSaved : dict.feedbackNoteUnmatched
        )
        .catch(() => undefined);
      return;
    }
  }

  const url = extractVideoUrl(text);
  if (url) {
    await handleVideoUrl(client, message, from, url, dict, config);
    return;
  }

  // Somebody wrote a sentence to the bot with no support session open. Until
  // 2026-08-23 this line was the end of it: they got the hint below and their
  // words were gone. That is precisely where a reply to one of our own outbound
  // messages lands - 34 people were written to on 2026-08-20, each invited to
  // answer, and an answer sent this way would have been discarded unread.
  //
  // Recorded, not relayed: the owner's ticket inbox stays as quiet as it was,
  // and the text becomes readable instead of lost. Sent after the reply, and
  // recordSupportMessage cannot throw, so the person still gets their hint.
  await client.sendMessage(message.chat.id, dict.sendVideoHint);
  if (text?.trim()) {
    await recordSupportMessage({
      telegramId: from.id,
      direction: "in",
      text,
      kind: "loose_text",
      userId: existing?.id ?? null,
    });
  }
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
    // The limits live here rather than on the pre-START description, because
    // this is the moment a user is choosing a file. Read off the plan config so
    // six locales cannot drift from ABUSE_CAPS between them.
    case "create": {
      // The free cap is quoted only to somebody it applies to. A subscriber
      // reading "on the free run: up to 60 minutes" is being told about an
      // allowance that is not theirs, on the one screen whose whole job is to
      // answer "what may I send?".
      //
      // Absent account counts as free with the whole allowance: there is nothing
      // to look up, and a stranger who has sent nothing is exactly who the free
      // run is for.
      let freeMaxMinutes: number | null = await freeRunCapMinutes(existing);

      await client.sendMessage(
        message.chat.id,
        dict.createPrompt({
          freeMaxMinutes,
          planMaxMinutes: STARTER_WEEKLY.maxSourceDurationMinutes,
          maxFileGb: Math.round(
            STARTER_WEEKLY.maxFileSizeBytes / (1024 * 1024 * 1024)
          ),
        })
      );
      return;
    }
    case "earn": {
      await client.sendMessage(message.chat.id, dict.earnMenuPrompt, {
        replyMarkup: earnKeyboard(dict),
      });
      return;
    }
    case "plans": {
      await sendPlansView(client, message, dict, config, existing);
      // After the screen is out, and recordFunnelEvent cannot throw - the same
      // ordering every other funnel write in this file uses.
      await recordFunnelEvent(
        "bot",
        message.from!.id,
        FUNNEL_EVENTS.PLANS_OPENED,
        message.from!.language_code
      );
      return;
    }
  }
}

/**
 * The longest video this person can actually send on the free run right now, or
 * null when the free run is not a thing they can use.
 *
 * TWO DIFFERENT NUMBERS live behind "60 minutes" and the 🎬 screen used to quote
 * the wrong one. `maxSourceDurationMinutes` caps a single source;
 * `FREE_TIER.lifetimeSeconds` is the whole allowance, ever. Someone who has
 * already spent 35 of their 60 minutes cannot send an hour-long video - they can
 * send 25 minutes - and a screen that answers "what may I send?" with the static
 * cap is telling them to try something that will be refused on submit.
 *
 * So: the smaller of what is left and what one source may be. Floored, matching
 * freeExhausted, so anyone with under a minute reads 0 rather than a rounded-up
 * promise - and 0 returns null, because a line saying "up to 0 minutes" is worse
 * than no line.
 *
 * Null for three cases, all of them "the free run is not available to you":
 *   - a live paid subscription (the free allowance is not theirs)
 *   - the allowance is spent
 *   - the month's global free budget is closed (freeBudgetStatus)
 *
 * Any read that throws falls back to the full cap. Over-quoting costs one
 * sentence; a screen that fails costs everyone the only place the limits are
 * written down.
 */
export async function freeRunCapMinutes(
  existing: { id: string } | null
): Promise<number | null> {
  const sourceCap = getPlanLimits("NONE").maxSourceDurationMinutes;
  if (!existing) return sourceCap;

  try {
    // Same live-subscription test sendPlansView uses, so the two screens cannot
    // disagree about who is on a plan.
    const usage = await getUsageForUser(existing.id);
    if (usage.plan !== "NONE" && usage.subscriptionState.live) return null;

    const budget = await freeBudgetStatus();
    if (!budget.open) return null;

    // From the ledger, never from Job rows: deleting a project hard-deletes
    // those, so a jobs-based balance is reset by pressing Delete.
    const leftMinutes = Math.floor(
      (await freeBalanceSeconds(existing.id)) / 60
    );
    const usable = Math.min(leftMinutes, sourceCap);
    return usable > 0 ? usable : null;
  } catch (error) {
    console.error(
      "[create] could not read the free balance; quoting the full cap:",
      error instanceof Error ? error.message : error
    );
    return sourceCap;
  }
}

async function handleEarnAction(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  action: EarnAction,
  dict: Dict,
  config: BotRuntimeConfig
) {
  switch (action) {
    case "referral": {
      await handleReferral(client, message, from, dict, config);
      return;
    }
    // Not built, and deliberately so. The tap is recorded before the reply so
    // the decision to build it rests on how many people press the button rather
    // than on a guess - the same reason FIRST_SCREEN exists.
    case "advertisers": {
      await client.sendMessage(message.chat.id, dict.earnAdvertisersSoon, {
        replyMarkup: earnKeyboard(dict),
      });
      await recordFunnelEvent(
        "bot",
        from.id,
        FUNNEL_EVENTS.EARN_ADVERTISERS,
        from.language_code
      );
      return;
    }
  }
}

async function handleSettingsAction(
  client: TelegramClient,
  message: TelegramMessage,
  action: SettingsAction,
  dict: Dict,
  config: BotRuntimeConfig
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
    case "link": {
      await handleLink(client, message, dict, config);
      return;
    }
    case "menu": {
      // Back out of Settings. See the note on /menu above: a greeting here told
      // somebody who had tapped ⬅️ Menu that they were welcome back, and told
      // them to send a video while the keyboard's own first button says so.
      await sendMainMenu(client, message.chat.id, dict.menuTitle, dict, message.from!);
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

/** The pipeline in the order the user experiences it, which is the order the
 *  board draws. Each entry names the status that is RUNNING that line. */
const PROGRESS_STEPS: ReadonlyArray<{
  running: JobStatus;
  label: (dict: Dict) => string;
}> = [
  { running: "DOWNLOADING", label: (d) => d.progressStepDownload },
  { running: "TRANSCRIBING", label: (d) => d.progressStepTranscribe },
  { running: "ANALYZING", label: (d) => d.progressStepAnalyze },
  { running: "CUTTING", label: (d) => d.progressStepRender },
];

/**
 * The live progress board, as one message the poller edits in place.
 *
 * The layout lives here rather than in the dictionaries so the six locales carry
 * words and nothing else - a marker set or a step order duplicated six times is
 * six chances to disagree, and the disagreement would be invisible until someone
 * read the bot in Indonesian.
 *
 * There is no finished state, and the type says so. The board's whole value is
 * temporal: it answers "is this thing alive?" while the answer is not yet in the
 * chat. Once the clips are there it is scaffolding nobody took down, and ten runs
 * leave ten dead boards in the history - so a terminal job DELETES its board
 * rather than ticking it (see removeProgressBoard).
 */
export function renderProgressBoard(
  dict: Dict,
  status: Exclude<JobStatus, "DONE" | "FAILED">
): string {
  const activeIndex = PROGRESS_STEPS.findIndex((s) => s.running === status);

  const lines = PROGRESS_STEPS.map((step, i) => {
    // activeIndex === -1 is PENDING: queued, nothing started.
    if (activeIndex === -1) return `◽ ${step.label(dict)}`;
    if (i < activeIndex) return `✅ ${step.label(dict)}`;
    if (i === activeIndex) return `⏳ ${step.label(dict)}`;
    return `◽ ${step.label(dict)}`;
  });

  const note = activeIndex === -1 ? `\n\n${dict.progressQueuedNote}` : "";
  return `${dict.progressTitle}\n\n${lines.join("\n")}${note}`;
}

/** Telegram answers an edit whose text is byte-identical with this instead of
 *  succeeding. It means the board already says the right thing, so it is a
 *  success for our purposes - the only reason it can happen is a progressStatus
 *  write that failed after its edit landed. */
function isUnmodifiedEdit(message: string): boolean {
  return message.toLowerCase().includes("message is not modified");
}

/**
 * Moves every in-flight board to the stage its job is actually on.
 *
 * Runs on the same ten-second tick as the delivery poll, because the wait it
 * covers is long: measured across production jobs, 2.5 to 13 minutes pass
 * between "queued" and the first word of output, median 6.5 - and until now the
 * chat said nothing for the whole of it while Job.status walked four stages.
 *
 * Nothing here is allowed to break a delivery. Every failure is swallowed and
 * logged: a board is a courtesy, and a user who loses it still gets their clips,
 * whereas a throw escaping into pollDeliveries would stall the queue behind it.
 */
export async function updateTelegramProgressBoards(client: TelegramClient) {
  let rows: Awaited<
    ReturnType<typeof telegramDeliveryService.getInFlightTelegramDeliveries>
  >;
  try {
    rows = await telegramDeliveryService.getInFlightTelegramDeliveries();
  } catch (error) {
    console.error(
      "[progress] could not read in-flight deliveries:",
      error instanceof Error ? error.message : error
    );
    return;
  }

  for (const row of rows) {
    // The comparison the SQL cannot do - see getInFlightTelegramDeliveries.
    if (row.progressStatus === row.job.status) continue;
    if (typeof row.progressMessageId !== "number") continue;
    // getInFlightTelegramDeliveries already excludes these in SQL, so this is
    // unreachable - and it stays because renderProgressBoard's signature refuses
    // them, which makes the exclusion a fact the compiler checks rather than a
    // where clause someone can widen without noticing. Terminal boards are the
    // delivery pass's business: it deletes them, once the clips are in the chat.
    if (row.job.status === "DONE" || row.job.status === "FAILED") continue;

    try {
      const dict = t(await getUserLocale(row.userId));
      await client.editMessageText(
        row.chatId,
        row.progressMessageId,
        renderProgressBoard(dict, row.job.status)
      );
      await telegramDeliveryService.markTelegramProgressShown(
        row.id,
        row.job.status
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isUnmodifiedEdit(message)) {
        // The edit already landed; only its bookkeeping is outstanding.
        await telegramDeliveryService
          .markTelegramProgressShown(row.id, row.job.status)
          .catch(() => undefined);
        continue;
      }
      console.error(
        `[progress] could not update the board for delivery ${row.id}:`,
        message
      );
    }
  }
}

/**
 * Takes the board down once this job has said its final word in the chat.
 *
 * Deleted rather than ticked, and that is the point. The board exists to answer
 * "is this alive?" during a wait that measures 2.5 to 13 minutes; the moment the
 * answer is in the chat it is scaffolding nobody removed, and it accumulates -
 * ten runs, ten dead boards in the history. An earlier version drew a final
 * all-ticked frame instead, which is exactly the clutter it now avoids.
 *
 * MUST be called after the outcome is in the chat, never before - on the happy
 * path that means after the clips. Deleting first would leave a user whose R2
 * signing then failed with nothing at all: no clips and no board either.
 *
 * Best effort by construction. A board that will not delete is cosmetic litter;
 * a throw here would escape into the shared ten-second poll and stall the
 * deliveries queued behind it.
 */
async function removeProgressBoard(
  client: TelegramClient,
  delivery: { id: string; chatId: string; progressMessageId: number | null }
) {
  // typeof, not `=== null`: rows written before this column existed read back as
  // null, and any caller reaching us with the field simply absent would
  // otherwise have `deleteMessage(chatId, undefined)` sent to Telegram.
  if (typeof delivery.progressMessageId !== "number") return;
  try {
    await client.deleteMessage(delivery.chatId, delivery.progressMessageId);
  } catch (error) {
    console.error(
      `[progress] could not remove the board for delivery ${delivery.id}:`,
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
        // The failure copy explains everything the board could, and a board
        // frozen on "Listening to the speech" beside it only raises the question
        // of whether it is still running. Note the job may yet heal to DONE and
        // be re-picked - it will simply have no board by then, which the clips
        // path treats as "nothing to remove".
        await removeProgressBoard(client, delivery);
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
        await removeProgressBoard(client, delivery);
        await settleDelivery(delivery.id, { kind: "DELIVERED" });
        continue;
      }

      // One clip's failure costs only itself. The old loop signed every URL up
      // front and then sent them with no per-clip catch, so a single refusal -
      // a clip 557,490 bytes over Telegram's 20MB URL-fetch ceiling - threw and
      // the ten deliverable clips behind it were never attempted.
      // A const copy because the caption is built inside a closure now, and
      // TypeScript will not carry the narrowing of the mutable `dict` (which
      // the catch block needs to read as possibly null) across one.
      const strings = dict;
      const feedbackOn = isClipFeedbackEnabled("bot");
      const outcome = await deliverClips(
        client,
        delivery.chatId,
        delivery.job.clips,
        (clip) =>
          buildClipCaption({
            title: clip.title,
            description: clip.description,
            lowQuality: clip.lowQuality,
            lowQualityNote: strings.lowQualityNote,
            feedbackPrompt: feedbackOn ? strings.feedbackPrompt : undefined,
          }),
        {
          markSent: async (clipId, fileId, messageId) => {
            await prisma.clip.update({
              where: { id: clipId },
              // `?? "sent"` is deliberate: Telegram has confirmed the clip is in
              // the chat even when it returns no id, and this column's job is
              // "do not send this again". A null here would resend a clip the
              // user already has.
              //
              // telegramMessageId gets no such fallback: it is an anchor for a
              // reply, and a wrong anchor is worse than none.
              data: {
                telegramFileId: fileId ?? "sent",
                telegramMessageId: messageId ?? null,
              },
            });
          },
          markUnsendable: async (clipId, reason) => {
            await prisma.clip.update({
              where: { id: clipId },
              data: { telegramSendError: reason },
            });
          },
        },
        // Undefined, not an empty keyboard: Telegram renders an empty
        // inline_keyboard as a stray blank row under the video.
        feedbackOn ? (clip) => verdictKeyboard(clip.id, strings) : undefined
      );

      // Still owed, so the row is NOT settled: the next poll re-picks it and
      // sends only what is missing. This is what the telegramFileId column
      // bought - a re-pickup can no longer repeat a clip already in the chat.
      // `continue` also skips the summary and the board: while clips are still
      // owed the user must not be told "Done", and the board must stay up.
      if (outcome.pending > 0) {
        const { terminal } = await markTelegramDeliveryAttemptFailed(
          delivery.id,
          `${outcome.pending} clip(s) not delivered yet`,
          delivery.attempts
        );
        // Only the poll that spends the last attempt falls through, to say the
        // honest partial below. Every earlier one leaves the row re-pickable.
        if (!terminal) continue;
      }

      // What is actually in the chat, across every pass: a clip delivered on an
      // earlier poll came back from the query carrying a telegramFileId, and
      // `delivered` is what this pass added. Neither alone is the answer - the
      // first misses this pass, the second misses every earlier one.
      const total = delivery.job.clips.length;
      const inChat =
        delivery.job.clips.filter((c) => c.telegramFileId).length +
        outcome.delivered;

      // After the clips, not before: it is a summary of what has arrived, and
      // sending it first made it a promise this code could fail to keep - a
      // standing "Done. 3 clips are ready." above an empty chat. The same
      // reason it counts rather than assumes: we reach here with clips missing
      // when the attempt budget ran out, or when storage refused a clip for
      // good, and `done(total)` would be that broken promise all over again.
      //
      // Nothing at all in the chat is the case deliveryGivenUp was written for,
      // and it is the copy that also warns the user not to pay for the video a
      // second time - so it is used here rather than a "0 of 12".
      //
      // The partial - and only the partial - carries a button. Its copy ends by
      // pointing at one, and these users are never told the web dashboard
      // exists, so the button is the whole of their way back. "Done" has
      // nothing to retry, and deliveryGivenUp already sends the user elsewhere.
      if (inChat === total) {
        await client.sendMessage(delivery.chatId, strings.done(total));
      } else if (inChat > 0) {
        await client.sendMessage(
          delivery.chatId,
          strings.donePartial(inChat, total),
          {
            replyMarkup: {
              inline_keyboard: [
                [
                  {
                    text: strings.resendRemainingBtn,
                    callback_data: `resend:${delivery.jobId}`,
                  },
                ],
              ],
            },
          }
        );
      } else {
        await client.sendMessage(
          delivery.chatId,
          strings.deliveryGivenUp(appUrl, total)
        );
      }

      // Now, and not a line earlier: the board is the user's only sign of life
      // until the clips land, so it comes down only once they have.
      await removeProgressBoard(client, delivery);

      await settleDelivery(
        delivery.id,
        inChat < total
          ? {
              kind: "FAILED",
              error: `${total - inChat} of ${total} clip(s) never reached the chat`,
            }
          : { kind: "DELIVERED" }
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Delivery failed";

      // No "clips are already in the chat, so give up on the rest" branch any
      // more. It used to declare the row terminal the moment one clip had
      // landed, because re-picking the row would have repeated that clip -
      // which is exactly how a user got 1 of 12. telegramFileId now carries
      // that guard per clip, so a re-pickup sends only what is still owed and
      // the row can fall through to the ordinary attempt budget below.
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

/**
 * The onboarding copy, with the paused note appended when free runs really are
 * paused.
 *
 * Every onboarding screen promises "your first video is free". Today that
 * promise is followed, one message later, by freeBudgetClosed - because
 * FREE_TIER_MONTHLY_BUDGET_USD is deliberately unset and the gate refuses every
 * free submission. Promising and then refusing inside two messages is the
 * cheapest way to lose someone who arrived willing.
 *
 * Conditional rather than a rewrite, on purpose. The promise is not false - the
 * minutes ARE on the account, freeBudgetClosed says so itself - it is only
 * unspendable this month, and deleting it would leave the bot understating the
 * product on the day a ceiling goes into .env. Reading freeBudgetStatus() here
 * means the copy tracks the gate automatically in both directions: set a
 * budget and the note disappears with no further edit.
 *
 * Failure is swallowed. This runs on /start, the first thing a stranger ever
 * sees; a database hiccup in an advisory sentence must not cost them the whole
 * welcome. The note is dropped in that case, which is the same thing the user
 * saw yesterday.
 */
export async function withFreeRunsNote(
  text: string,
  dict: Dict
): Promise<string> {
  try {
    const budget = await freeBudgetStatus();
    if (budget.open) return text;
  } catch (err) {
    console.error("[start] could not read the free budget:", err);
    return text;
  }
  return `${text}\n\n${dict.freeRunsPausedNote}`;
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
    // Still eager here, unlike the plain /start below: attachReferral needs a
    // row to attach to, and a referral link is a commitment the referrer has
    // already been credited for.
    const user = await resolveTelegramUser(from);
    if (isNew) {
      const { referralService } = await import("@clipclap/shared");
      await referralService.attachReferral(user.id, payload.code);
      await sendMainMenu(
        client,
        message.chat.id,
        await withFreeRunsNote(dict.welcomeFirstScreen, dict),
        dict,
        from
      );
      return;
    }
    // existing user: fall through to the normal welcome flow below
  }

  if (!existing) {
    // One screen, and it invites rather than interrogates. It replaced a
    // two-button "New account / I already have one" prompt - a question about
    // our account topology, put to everybody to serve the few who own a
    // clipclap.io account AND found the bot themselves, when the website's deep
    // link already carries that case straight past here.
    //
    // NO User row is created, which is the same property the old screen had and
    // is worth keeping: resolveTelegramUser stays the only door to a row and is
    // still reached lazily - on the first video, or on a settings change - so a
    // stranger who reads this and leaves leaves nothing behind, and `signed_up`
    // keeps meaning "somebody who did something" rather than "somebody who
    // pressed START".
    // Sent with mainMenuKeyboard rather than through sendMainMenu, and that is
    // about telemetry, not about the buttons - they are identical.
    //
    // sendMainMenu records APP_OPENED, and this person has not opened anything:
    // they typed /start and are looking at a pitch. Counting it here would make
    // app_opened ~= first_screen for the bot and quietly turn "people using the
    // product" into "people who saw the door". The same distinction is already
    // drawn for the language switch, which re-sends this keyboard without
    // claiming an app-open - see the note on mainMenuKeyboard.
    await client
      .sendMessage(
        message.chat.id,
        await withFreeRunsNote(dict.welcomeFirstScreen, dict),
        { replyMarkup: mainMenuKeyboard(dict) }
      )
      .catch(() => undefined);
    // Recorded AFTER the reply is out, and recordFunnelEvent never throws, so
    // the first thing this person sees cannot be broken by a telemetry write.
    await recordFunnelEvent(
      "bot",
      message.from!.id,
      FUNNEL_EVENTS.FIRST_SCREEN,
      message.from!.language_code
    );
    // Recorded only for strangers, and deliberately: the question a campaign tag answers is
    // "how many people did this placement bring", and an existing user clicking the same link
    // is not one of them. Same ordering rule as above - the person has already been answered.
    if (payload?.kind === "src") {
      await recordFunnelEvent(
        "bot",
        message.from!.id,
        campaignStartEvent(payload.code),
        message.from!.language_code
      );
    }
    return;
  }

  const from = message.from!;
  const user = await resolveTelegramUser(from);
  const usage = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  if (usage.plan === "NONE") {
    // The persistent menu (below) carries the 💳 Plans button; welcomeNeedsPlan
    // nudges the user to it, so no inline plan buttons here.
    await sendMainMenu(
      client,
      message.chat.id,
      await withFreeRunsNote(dict.welcomeNeedsPlan, dict),
      dict,
      from
    );
    return;
  }

  await sendMainMenu(client, message.chat.id, dict.welcomeBack, dict, from);
}

/** One tap on a feedback keyboard.
 *
 *  Exported for tests, and shaped around three constraints. The callback has
 *  already been acknowledged by handleCallbackQuery, so nothing here may throw.
 *  clipId comes off a button and is forgeable, so ownership is checked at the
 *  row inside recordClipFeedback - a refusal changes nothing in the chat and is
 *  logged rather than answered, because there is nothing honest to say to
 *  someone pressing another user's button.
 *
 *  Deliberately NOT behind isClipFeedbackEnabled: keyboards already sitting in
 *  people's chats cannot be recalled, and refusing them would turn those chats
 *  into a graveyard of buttons that answer with an error. The flag gates
 *  drawing new ones. */
export async function handleFeedbackCallback(
  client: TelegramClient,
  press: { chatId: number | string; messageId: number; userId: string; data: string },
  dict: Dict
): Promise<void> {
  const parsed = parseFeedbackCallback(press.data);
  if (!parsed) return;

  try {
    const result =
      parsed.kind === "verdict"
        ? await recordClipFeedback({
            clipId: parsed.clipId,
            userId: press.userId,
            surface: "bot",
            verdict: parsed.verdict,
          })
        : await recordClipFeedback({
            clipId: parsed.clipId,
            userId: press.userId,
            surface: "bot",
            reason: parsed.reason,
          });

    if (!result.ok) {
      console.warn(
        `[feedback] refused ${press.data} for user ${press.userId}: ${result.code}`
      );
      return;
    }

    if (parsed.kind === "reason") {
      await client
        .editMessageReplyMarkup(press.chatId, press.messageId, undefined)
        .catch(() => undefined);
      await client
        .sendMessage(press.chatId, dict.feedbackNoted(reasonLabel(parsed.reason, dict)))
        .catch(() => undefined);
      return;
    }

    // Praise costs one tap; a complaint costs two. The reason row only appears
    // for the two verdicts that have something to explain.
    if (parsed.verdict === "AS_IS") {
      await client
        .editMessageReplyMarkup(press.chatId, press.messageId, undefined)
        .catch(() => undefined);
      await client.sendMessage(press.chatId, dict.feedbackThanks).catch(() => undefined);
      return;
    }

    await client
      .editMessageReplyMarkup(
        press.chatId,
        press.messageId,
        reasonKeyboard(parsed.clipId, dict)
      )
      .catch(() => undefined);
  } catch (error) {
    console.error(
      `[feedback] callback ${press.data} failed:`,
      error instanceof Error ? error.message : error
    );
  }
}

/** The result of trying to attach a Telegram reply to a clip as feedback.
 *
 *  Deliberately not a boolean: "should this text be kept away from the URL
 *  branch" and "should the user be told it saved" are different questions,
 *  and a miss answers yes to the first and no to the second. Collapsing them
 *  produced a false "saved" confirmation on every miss. */
export type ClipReplyOutcome =
  /** A note was written against a clip. */
  | "recorded"
  /** No clip of this user is anchored to that message - the project was
   *  deleted, the send never returned a message id, or the clip predates the
   *  anchor column entirely, which is true of every clip delivered before this
   *  feature shipped (telegramMessageId is NULL on all of them). */
  | "no-anchor"
  /** The lookup or the write failed. Nothing was stored. */
  | "failed"
  /** Nothing worth recording; the caller should handle the message normally. */
  | "empty";

/** A reply to one of the bot's clip videos, recorded as free text on that clip.
 *
 *  This is the entire free-text channel from Telegram, and it costs one column
 *  and one branch: no force_reply, no pending-state machine, no Redis key.
 *
 *  The lookup here keys on the PAIR (userId, telegramMessageId): message_id is
 *  unique per chat and is a small integer, so ids collide across chats freely.
 *  recordClipFeedback then does its OWN ownership check by (clipId, userId) -
 *  that is not redundant, it is the same guard the web surface relies on, and
 *  clipId is caller-suppliable there. Two round trips on what should be a rare
 *  path (most replies hit an anchored, owned clip on the first try) is the
 *  right trade for not weakening either surface's guard. */
export async function tryRecordClipReply(
  userId: string,
  repliedToMessageId: number,
  text: string
): Promise<ClipReplyOutcome> {
  const note = text.trim();
  if (!note) return "empty";

  try {
    const clip = await prisma.clip.findFirst({
      where: { userId, telegramMessageId: repliedToMessageId },
      select: { id: true },
    });
    if (!clip) {
      console.warn(
        `[feedback] reply from ${userId} to message ${repliedToMessageId} matched no clip`
      );
      return "no-anchor";
    }

    const result = await recordClipFeedback({
      clipId: clip.id,
      userId,
      surface: "bot",
      note,
    });
    // The clip can vanish between the lookup above and this write (deleted in
    // the gap, or a race with the retention sweep). Same as handleFeedbackCallback,
    // a refusal here is treated as no match rather than a stored note.
    if (!result.ok) {
      console.warn(
        `[feedback] reply from ${userId} to message ${repliedToMessageId} refused: ${result.code}`
      );
      return "no-anchor";
    }
    return "recorded";
  } catch (error) {
    // The note is gone either way once this throws - the lookup or the write
    // failed, nothing was stored. The return value's only job from here is to
    // decide whether the raw text gets a second chance to be read as a source
    // URL, and short-circuiting it is the safe choice: a reply that happens to
    // contain a link must not start a job nobody asked for.
    console.error(
      `[feedback] could not record reply from ${userId}:`,
      error instanceof Error ? error.message : error
    );
    return "failed";
  }
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

  // The job id arrives from the client, so ownership is checked at the row -
  // otherwise a guessed id would re-arm a stranger's delivery. A refusal is
  // logged rather than answered: the press was already acknowledged above, and
  // there is nothing honest to say to someone pressing another user's button.
  if (query.data.startsWith("resend:")) {
    const jobId = query.data.slice("resend:".length);
    const user = await resolveTelegramUser(query.from);
    const rearmed = await rearmDeliveryForResend(jobId, user.id);
    if (!rearmed) {
      console.warn(`[delivery] resend refused for job ${jobId}: not this user's`);
    }
    return;
  }

  // Ahead of the switch below: feedback callbacks carry a clip id, so there is
  // no finite set of literals to enumerate as cases.
  if (query.data.startsWith("fb:") || query.data.startsWith("fr:")) {
    const user = await resolveTelegramUser(query.from);
    await handleFeedbackCallback(
      client,
      {
        chatId: query.message.chat.id,
        messageId: query.message.message_id,
        userId: user.id,
        data: query.data,
      },
      dict
    );
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
    case CALLBACK_SUBTITLES_TOGGLE: {
      await handleSubtitlesToggle(client, query, dict);
      return;
    }
    case CALLBACK_PLANS_OPEN: {
      // Same view the 💳 Plans menu button renders, in the same chat.
      const account = await prisma.user.findUnique({
        where: { telegramId: String(query.from.id) },
        select: { id: true },
      });
      await sendPlansView(client, query.message, dict, config, account);
      return;
    }
    default:
      return;
  }
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
        // A failure on OUR side, recorded where it can be counted. In a console
        // line it was indistinguishable from somebody changing their mind, and
        // those are the two possibilities the revenue question turns on.
        await recordFunnelEvent("bot", telegramId, FUNNEL_EVENTS.CHECKOUT_ERROR);
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
    // The pay link is now in their hands. Recorded here rather than at the
    // order insert so the reused-fresh-order path counts too - a second tap
    // within fifteen minutes is the same intent and creates no new row.
    await recordFunnelEvent("bot", telegramId, FUNNEL_EVENTS.CHECKOUT_STARTED);
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
  // Moved here from the first screen's "I already have an account" button when
  // that screen was removed. Same event name, same question - how many people
  // join a web account to a Telegram one - so the series is not split in two.
  // This function is the single place a link is started from inside the bot:
  // both /link and the Settings button land on it.
  await recordFunnelEvent(
    "bot",
    from.id,
    FUNNEL_EVENTS.LINK_ACCOUNT,
    from.language_code
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
  | { kind: "src"; code: string }
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
  // A campaign tag: t.me/clipclapio_bot?start=src_<slug>. Everything unrecognised used to fall
  // through to null and vanish, which made a bought placement indistinguishable from an organic
  // arrival. Sanitised here because the slug becomes part of a database key.
  if (trimmed.startsWith("src_")) {
    const code = sanitiseCampaignSlug(trimmed.slice("src_".length).trim());
    if (code) return { kind: "src", code };
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
  // Seconds may be 0 when Telegram sends no duration metadata. The USD figure
  // never is: estimatedFreeCostUsd floors an unmeasured submission at the flat
  // per-run charge, so the monthly ceiling sees the run while it is in flight
  // rather than only once the download stage measures it.
  const seconds = durationSec && durationSec > 0 ? Math.round(durationSec) : 0;
  return { seconds, estimatedCostUsd: estimatedFreeCostUsd(seconds) };
}

/** The same source again. Says so, hands the clips back when there are any,
 *  and files the refusal - a resend that never became a job must not read on
 *  /admin as a `video_submitted` with nothing after it.
 *
 *  Three of the first fifteen outside users did this (one link three times,
 *  two files twice each); every repeat was a full paid run for clips they
 *  already had. A finished job's clips come back from Telegram's cache by
 *  file_id - no download, no upload, no minutes; clips that never reached the
 *  chat (no file_id) are simply not among them. */
async function answerDuplicate(
  client: TelegramClient,
  chatId: number | string,
  from: TelegramUser,
  dict: Dict,
  dup: DuplicateJob,
  detail: RefusalDetail
): Promise<void> {
  if (dup.kind === "active") {
    await client.sendMessage(chatId, dict.duplicateActive);
    await recordUploadRefusal(
      "bot",
      from.id,
      "DUPLICATE",
      { ...detail, priorJobId: dup.job.id, priorStatus: dup.job.status },
      from.language_code
    );
    return;
  }
  const cached = dup.clips.filter((c) => c.telegramFileId);
  await client.sendMessage(chatId, dict.duplicateDone(cached.length));

  // Clips this user has already judged keep their answer: re-asking would put
  // live buttons over a settled verdict. Keyed on clipId alone - not scoped to
  // this user - because the filter would be redundant rather than unavailable:
  // findDuplicateJob already scoped `cached` to this user's own clips, and
  // recordClipFeedback only ever writes a row for the clip's owner, so any row
  // found here is this user's.
  const feedbackOn = isClipFeedbackEnabled("bot");
  const alreadyRated = feedbackOn
    ? new Set(
        (
          await prisma.clipFeedback.findMany({
            where: {
              clipId: { in: cached.map((c) => c.id) },
              // A reply-only note also creates a row, with an empty-string
              // verdict - see recordClipFeedback's create arm. That is not a
              // judgement, so those clips must still get buttons.
              verdict: { not: "" },
            },
            select: { clipId: true },
          })
        ).map((r) => r.clipId)
      )
    : new Set<string>();

  let resent = 0;
  for (const clip of cached) {
    try {
      // Undefined, not an empty keyboard: Telegram renders an empty
      // inline_keyboard as a stray blank row under the video.
      const markup =
        feedbackOn && !alreadyRated.has(clip.id)
          ? verdictKeyboard(clip.id, dict)
          : undefined;
      const sent = await client.sendVideo(
        chatId,
        clip.telegramFileId as string,
        clip.title ?? undefined,
        markup
      );
      // The send succeeded; count it before doing anything else that could
      // throw, so a downstream failure cannot masquerade as a failed send.
      resent += 1;

      // The resend is a NEW message, so the reply anchor moves to it: a reply
      // to the copy the user is actually looking at must find the clip. The
      // old message stays in the chat as a dead anchor, which degrades to the
      // "could not match that to a clip" reply rather than a false confirmation.
      //
      // Its own catch: the clip IS in the chat by now, and a failure to move
      // the anchor must not be logged as a failed send or subtracted from the
      // resent count. The cost of losing it is one reply that answers "could
      // not match that to a clip" instead of recording a note.
      if (sent?.message_id) {
        try {
          await prisma.clip.update({
            where: { id: clip.id },
            data: { telegramMessageId: sent.message_id },
          });
        } catch (error) {
          console.warn(
            `[duplicate] anchor not moved for clip ${clip.id}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
    } catch (error) {
      // One clip's failure costs only itself, same rule as delivery.
      console.warn(`[duplicate] could not re-send clip ${clip.id}:`, error);
    }
  }
  await recordUploadRefusal(
    "bot",
    from.id,
    "DUPLICATE",
    { ...detail, priorJobId: dup.job.id, priorStatus: dup.job.status, resent },
    from.language_code
  );
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
  // Before the blocker and long before the Telegram download and the R2
  // upload: a resend costs nothing to recognise from file_unique_id alone.
  const fingerprint = telegramSourceFingerprint(source.fileUniqueId);
  const duplicate = await jobService.findDuplicateJob(user.id, fingerprint);
  if (duplicate) {
    await answerDuplicate(client, message.chat.id, from, dict, duplicate, {
      source: "file",
      durationSec: source.duration,
      fingerprint,
    });
    return;
  }
  const blockedReason = await getSubmissionBlocker(user.id, dict, source.duration, subject);
  if (blockedReason) {
    await client.sendMessage(message.chat.id, dict.blocked(blockedReason), {
      replyMarkup: blockedKeyboard(dict),
    });
    return;
  }

  // The ack goes out only after the blocker check: no neutral ("received,
  // checking...") copy exists for this path, and telling someone we are
  // "Uploading your video..." right before refusing them is worse than the
  // telemetry write landing a beat before the first reply.
  //
  // Its message_id is kept because this same message becomes the live progress
  // board once the job exists - one message that mutates, rather than
  // "Uploading..." followed by "Queued" and then six minutes of silence. Sent as
  // a reply to the user's own video so the whole exchange is one thread, which
  // is what gives a job its identity on a plan that allows two at once.
  const ack = await sendProgressAnchor(client, message, dict);

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

  // THE OBJECT WE UPLOADED, until a Job row takes ownership of it.
  //
  // R2 cleanup used to hang off one specific return value - the
  // `concurrent_limit` branch below - so every other way out of this function
  // leaked the file. That was not theoretical: a held advisory lock made
  // createJob THROW, and a thrown submission left several megabytes in the
  // bucket that nothing would ever collect, because the retention sweep works
  // from job rows and there was no job row. Any new refusal status would have
  // leaked the same way by default, which is the deeper problem: the cleanup
  // was attached to one outcome instead of to the absence of an owner.
  //
  // Cleared only once createJob has returned a job. After that the object
  // belongs to that job and deleting it here would break a run that is starting.
  let unownedKey: string | undefined;

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
    // Marked BEFORE createJob, not after: the throw this protects against comes
    // out of createJob itself.
    unownedKey = sourceKey;

    const created = await jobService.createJob({
      userId: user.id,
      sourceKey,
      sourceFingerprint: fingerprint,
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

    // The blocker above already counted in-flight jobs, but it counted them
    // outside any lock and several seconds earlier - the Telegram download and
    // the R2 upload sit in between. createJob's locked count is the one that
    // decides; this branch is what the user sees when the two disagree, which is
    // exactly the case where two videos arrive at once.
    if (created.status === "concurrent_limit") {
      await client.sendMessage(
        message.chat.id,
        dict.blocked(
          dict.planConcurrentLimit(created.inFlight, created.limit)
        ),
        { replyMarkup: blockedKeyboard(dict) }
      );
      // The locked count is the one that decides, so it is the one that has to
      // be counted. The advisory check earlier may have recorded this already;
      // the upsert bumps `occurrences` rather than writing a second row, which
      // is the shape the funnel wants - people, not presses.
      await recordUploadRefusal(
        "bot",
        from.id,
        "CONCURRENT",
        { source: "file", inFlight: created.inFlight, limit: created.limit },
        from.language_code
      );
      return;
    }

    if (created.status === "busy") {
      await client.sendMessage(message.chat.id, dict.blocked(dict.submitBusy), {
        replyMarkup: blockedKeyboard(dict),
      });
      await recordUploadRefusal(
        "bot",
        from.id,
        "BUSY",
        { source: "file" },
        from.language_code
      );
      return;
    }
    const job = created.job;
    // The job owns the object from here. Everything after this line may fail
    // without the file being collectable - it is the source the download stage
    // is about to fetch.
    unownedKey = undefined;

    await createTelegramDelivery({
      jobId: job.id,
      userId: user.id,
      chatId: String(message.chat.id),
      progressMessageId: ack,
    });

    await showQueuedBoard(client, message.chat.id, ack, dict);
    if (created.status === "queued") {
      await client.sendMessage(
        message.chat.id,
        dict.queuedBehind(created.position)
      );
      await recordFunnelEvent(
        "bot",
        from.id,
        FUNNEL_EVENTS.VIDEO_QUEUED,
        from.language_code
      );
    }
    if (isShortSource(source.duration)) {
      await client.sendMessage(message.chat.id, dict.shortSourceNotice);
    }
  } finally {
    await rm(tempPath, { force: true });
    if (unownedKey) {
      // Best effort, and never fatal: the object is a few megabytes we chose to
      // store before we knew the answer, while throwing here would replace
      // whatever actually went wrong with an R2 error, or turn a plain refusal
      // into "your video broke".
      await deleteFile(unownedKey).catch((error) => {
        console.error(
          `[handleVideo] could not remove ${unownedKey} after a submission that never became a job:`,
          error
        );
      });
    }
  }
}

/**
 * The one message this job will keep editing, sent as a reply to the video.
 *
 * Returns its message_id, or undefined if the send failed - in which case the
 * job still runs and still delivers, it just narrates nothing. A board is a
 * courtesy and may never be a precondition.
 */
async function sendProgressAnchor(
  client: TelegramClient,
  message: TelegramMessage,
  dict: Dict
): Promise<number | undefined> {
  try {
    const sent = await client.sendMessage(message.chat.id, dict.uploading, {
      replyToMessageId: message.message_id,
    });
    return sent?.message_id;
  } catch (error) {
    console.error(
      "[progress] could not send the progress anchor:",
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}

/**
 * Turns the upload acknowledgement into the board, in its queued state.
 *
 * Replaces the second message the chat used to get ("Queued. I'll send the clips
 * back here when rendering finishes."), so a submission now costs one message
 * instead of two and that message stays useful for the whole run.
 *
 * Falls back to sending `queued` as its own message when there is no board to
 * edit, so a failed anchor still leaves the user told what is happening.
 */
async function showQueuedBoard(
  client: TelegramClient,
  chatId: number | string,
  progressMessageId: number | undefined,
  dict: Dict
) {
  if (progressMessageId === undefined) {
    await client.sendMessage(chatId, dict.queued).catch(() => undefined);
    return;
  }
  await client
    .editMessageText(
      chatId,
      progressMessageId,
      renderProgressBoard(dict, "PENDING")
    )
    .catch((error) => {
      console.error(
        "[progress] could not draw the queued board:",
        error instanceof Error ? error.message : error
      );
    });
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
    // "Try a different URL" is actively harmful advice for a YouTube link: the
    // refusal is against this host's IP, so the next YouTube link fails too.
    // The four bot users who ever pasted links took that advice and retried
    // 5, 3, 2 and 2 times before leaving. Only the fourth thought to upload a
    // file - and that job produced 12 clips, so the product was never the
    // problem. Name the cause and point at the path that works.
    //
    // Deliberately NOT gated on probe.reason: a YouTube link that times out or
    // returns no duration is still a YouTube link the user cannot fix by
    // pasting another one. Only the host decides which copy they get.
    await client.sendMessage(
      message.chat.id,
      isYouTubeUrl(url) ? dict.urlYouTubeUnavailable : dict.urlAccessFailed
    );

    // THE HOLE THAT COST US A REAL USER'S STORY.
    //
    // On 2026-07-29 a Telegram user submitted four links in ten seconds and the
    // funnel recorded four `video_submitted` rows and nothing else - no
    // refusal, no account, no job. Everyone read that as "the free budget
    // refused them" and went looking at the free-tier gate. It was this return:
    // all four links failed the probe, and this branch sits BEFORE the account
    // is created and before getSubmissionBlocker, which is where every other
    // bot refusal is recorded. `PROBE_FAILED` has existed in the shared enum
    // since the funnel was built and only the web route ever emitted it, so
    // `upload_rejected_probe_failed` read as permanently zero on `bot`.
    //
    // "probe-unavailable" is excluded on purpose, exactly as the web route
    // excludes it: yt-dlp missing from the container is our fault, and filing
    // it as a refusal the submitter caused would hide an outage inside a
    // perfectly ordinary-looking bad-link count. source-probe has already
    // logged its own greppable line for that case; this one names the surface.
    if (probe.reason === "probe-unavailable") {
      console.error(
        `[bot] URL probe unavailable for telegram ${from.id} - the link was ` +
          `refused without ever being measured`
      );
      return;
    }

    // Greppable, and it carries the reason. Four silent failures in ten seconds
    // left nothing in the logs either, so there was no way to tell a dead link
    // from a site that blocks us from a timeout.
    console.warn(
      `[bot] url probe failed (${probe.reason}) for telegram ${from.id}`
    );
    // The detail is the whole point: for four weeks the reason lived in the
    // line above and died with the container, and "yt-dlp-error" on its own
    // said nothing anyway - the URL, its host, yt-dlp's last ERROR line and
    // what the rotation answered are what a diagnosis needs.
    await recordUploadRefusal(
      "bot",
      from.id,
      "PROBE_FAILED",
      {
        source: "url",
        url,
        host: refusalHost(url),
        reason: probe.reason,
        error: probe.error,
        rotation: probe.rotation,
      },
      from.language_code
    );
    return;
  }

  const user = await resolveTelegramUser(from);
  const subject = { telegramId: from.id, locale: from.language_code };
  // After the probe (it is the account, not the link, that decides whether
  // this is a repeat) and before the blocker: a resent link that is already
  // running or already clipped must not be answered with a balance.
  const fingerprint = urlSourceFingerprint(url);
  const duplicate = await jobService.findDuplicateJob(user.id, fingerprint);
  if (duplicate) {
    await answerDuplicate(client, message.chat.id, from, dict, duplicate, {
      source: "url",
      url,
      durationSec: Math.round(probe.durationSec),
      fingerprint,
    });
    return;
  }
  const blockedReason = await getSubmissionBlocker(user.id, dict, probe.durationSec, subject);
  if (blockedReason) {
    await client.sendMessage(message.chat.id, dict.blocked(blockedReason), {
      replyMarkup: blockedKeyboard(dict),
    });
    return;
  }

  // Int column, float probe. YouTube happens to answer whole seconds, which is
  // why this never bit in prod, but archive.org and friends answer 596.46 and
  // prisma.job.create rejects a Float for an Int - the link would die with an
  // unhandled error after the user had already been told we were checking it.
  const probedSec = Math.round(probe.durationSec);

  const created = await jobService.createJob({
    userId: user.id,
    sourceUrl: url,
    sourceFingerprint: fingerprint,
    originalFilename: probe.title,
    subtitles: user.subtitlesEnabled,
    sourceDurationSec: probedSec,
    freeCharge: freeChargeFor(user, probedSec),
  });

  if (created.status === "concurrent_limit") {
    await client.sendMessage(
      message.chat.id,
      dict.blocked(dict.planConcurrentLimit(created.inFlight, created.limit)),
      { replyMarkup: blockedKeyboard(dict) }
    );
    await recordUploadRefusal(
      "bot",
      from.id,
      "CONCURRENT",
      {
        source: "url",
        durationSec: probedSec,
        inFlight: created.inFlight,
        limit: created.limit,
      },
      from.language_code
    );
    return;
  }

  // No R2 object to clean up on this path - a link is not uploaded anywhere -
  // but the refusal still has to be said and counted, or the funnel shows a
  // `video_submitted` with nothing after it.
  if (created.status === "busy") {
    await client.sendMessage(message.chat.id, dict.blocked(dict.submitBusy), {
      replyMarkup: blockedKeyboard(dict),
    });
    await recordUploadRefusal(
      "bot",
      from.id,
      "BUSY",
      { source: "url", durationSec: probedSec },
      from.language_code
    );
    return;
  }
  const job = created.job;

  const ack = await sendProgressAnchor(client, message, dict);

  await createTelegramDelivery({
    jobId: job.id,
    userId: user.id,
    chatId: String(message.chat.id),
    progressMessageId: ack,
  });

  await showQueuedBoard(client, message.chat.id, ack, dict);
  if (created.status === "queued") {
    await client.sendMessage(
      message.chat.id,
      dict.queuedBehind(created.position)
    );
    await recordFunnelEvent(
      "bot",
      from.id,
      FUNNEL_EVENTS.VIDEO_QUEUED,
      from.language_code
    );
  }
  if (isShortSource(probedSec)) {
    await client.sendMessage(message.chat.id, dict.shortSourceNotice);
  }
}

/**
 * The bot's single door to a User row - and the single place `signed_up` is
 * recorded.
 *
 * Every handler that needs an account goes through here, so putting the event
 * beside the insert catches all three ways one gets minted: the "New account"
 * button, a `ref_` deep link that bypasses the onboarding screen, and a first
 * message that is neither. `first_screen_new_account` counts one of those doors
 * and cannot stand in for the others.
 *
 * Recorded after the row exists and never before: recordFunnelEvent does not
 * throw, so this cannot cost anyone their account.
 */
async function resolveTelegramUser(from: TelegramUser): Promise<User> {
  const { user, created } = await getOrCreateTelegramUser({
    id: from.id,
    firstName: from.first_name,
    lastName: from.last_name,
    username: from.username,
    languageCode: from.language_code,
  });
  if (created) {
    await recordFunnelEvent(
      "bot",
      from.id,
      FUNNEL_EVENTS.SIGNED_UP,
      from.language_code
    );
  }
  return user;
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
  const recordRejection = (code: UploadRejectionCode, detail: RefusalDetail = {}) =>
    subject
      ? recordUploadRefusal(
          "bot",
          subject.telegramId,
          code,
          { durationSec, ...detail },
          subject.locale
        )
      : Promise.resolve();

  // Under the engine floor: nothing to cut, whatever the plan. First among the
  // duration gates on purpose - a 30-second video from an exhausted trial
  // account is refused for being 30 seconds, which is the sentence that
  // teaches them what the product wants; "your minutes ran out" would not.
  if (isBelowSourceFloor(durationSec)) {
    await recordRejection("TOO_SHORT", { minSec: SOURCE_FLOOR.minDurationSec });
    return dict.sourceTooShort;
  }

  if (
    durationMinutes > 0 &&
    durationMinutes > limits.maxSourceDurationMinutes
  ) {
    if (user.plan === "NONE") {
      await recordRejection("FREE_SOURCE_TOO_LONG", {
        maxMinutes: limits.maxSourceDurationMinutes,
      });
      return dict.freeSourceTooLong(
        limits.maxSourceDurationMinutes,
        STARTER_WEEKLY.maxSourceDurationMinutes
      );
    }
    await recordRejection("TOO_LONG", {
      maxMinutes: limits.maxSourceDurationMinutes,
    });
    return dict.planSourceTooLong(limits.maxSourceDurationMinutes);
  }

  const submission = await canSubmitJob(userId, durationMinutes);
  if (!submission.allowed) {
    await recordRejection(submission.code, {
      // What the gate saw, per code: the balance for FREE_EXHAUSTED, the
      // period usage for QUOTA, the phase for LIFECYCLE. Undefined fields are
      // dropped by the ledger.
      remainingSec: submission.trial?.remainingSeconds,
      lifetimeSec: submission.trial?.lifetimeSeconds,
      usedMinutes: submission.quota?.usedMinutes,
      limitMinutes: submission.quota?.limitMinutes,
      topUpMinutes: submission.quota?.topUpMinutes,
      phase: submission.phase,
    });
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
    await recordRejection("DAILY_LIMIT", {
      jobsToday,
      limit: limits.maxJobsPerDay,
    });
    return dict.planDailyLimit(limits.maxJobsPerDay);
  }

  // Advisory only, and only while the queue is OFF. With SUBMISSION_QUEUE=on,
  // "at capacity" is an acceptance (queued), not a refusal, and only
  // createJob's locked count may decide that - it is the one that creates the
  // row and picks the position. Refusing here as well would make the queue
  // unreachable from the bot: every second video would die at this check
  // before createJob ever got the chance to queue it instead, and the bot is
  // the surface with real submit traffic. So this whole block is skipped when
  // the flag is on - no count, no CONCURRENT ledger row - and createJob is
  // left to answer on its own.
  //
  // A cost this skip accepts ON PURPOSE: with the queue on, a second video's
  // Telegram download and R2 upload now happen BEFORE createJob decides
  // queued-vs-created - the spend this check used to avoid. That is not an
  // oversight: a queued job needs its source in R2 to run at all, so the
  // upload is work the queue was going to do anyway, just earlier.
  if (!submissionQueueEnabled()) {
    // The count that actually enforces the limit when the queue is off is the
    // one createJob takes under a per-user lock; this one is here so a second
    // video gets the localised refusal before we spend a Telegram download
    // and an R2 upload on it. enqueuedAt: { not: null } matches createJob's
    // own definition of in-flight - the two counts must agree on what
    // "in-flight" means or they disagree exactly at the boundary this check
    // exists to guard.
    const inFlight = await prisma.job.count({
      where: {
        userId,
        status: { in: [...ACTIVE_JOB_STATUSES] },
        enqueuedAt: { not: null },
      },
    });
    if (inFlight >= limits.concurrentJobsLimit) {
      await recordRejection("CONCURRENT", {
        inFlight,
        limit: limits.concurrentJobsLimit,
      });
      return dict.planConcurrentLimit(inFlight, limits.concurrentJobsLimit);
    }
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
