import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  buildClipCaption,
  cancelShopOrder,
  canSubmitJob,
  createBotInitiatedLink,
  createShopOrder,
  createTelegramDelivery,
  findOrCreateTelegramUser,
  getPlanLimits,
  getPresignedDownloadUrl,
  getTributeCatalogEntry,
  getUsageForUser,
  jobService,
  markTelegramDeliveryFailed,
  markTelegramDeliverySent,
  prisma,
  redeemLinkFromBot,
  telegramDeliveryService,
  uploadFile,
} from "@clipclap/shared";
import type { User } from "@prisma/client";
import type { TelegramClient } from "./telegram-client";
import { extractVideoUrl, probeVideoUrl } from "./url-probe";
import {
  detectLocale,
  parseLangCommand,
  t,
  type Dict,
  type Locale,
} from "./i18n";
import type {
  InlineKeyboardMarkup,
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

export const CALLBACK_LANG_EN = "lang_en";
export const CALLBACK_LANG_RU = "lang_ru";

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

export function parseLangCallback(data: string | undefined): "en" | "ru" | null {
  if (!data) return null;
  if (data === CALLBACK_LANG_EN) return "en";
  if (data === CALLBACK_LANG_RU) return "ru";
  return null;
}

export type MenuAction = "account" | "help" | "settings" | "affiliate" | "plans";

export function matchMenuAction(text: string): MenuAction | null {
  for (const loc of ["en", "ru"] as const) {
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
  for (const loc of ["en", "ru"] as const) {
    const d = t(loc);
    if (text === d.settingsLangBtn) return "lang";
    if (text === d.settingsVideoBtn) return "video";
    if (text === d.settingsBackBtn) return "menu";
  }
  return null;
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
    select: { id: true, telegramLocale: true },
  });

  const locale = detectLocale(existing?.telegramLocale ?? from.language_code);
  const dict = t(locale);

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
    await client.sendMessage(message.chat.id, dict.welcomeBack, {
      replyMarkup: buildMainMenu(dict),
    });
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

  const source = getVideoSource(message);
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
      await client.sendMessage(message.chat.id, dict.helpText(config.appUrl));
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
        replyMarkup: languageKeyboard(dict),
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
      await client.sendMessage(message.chat.id, dict.welcomeBack, {
        replyMarkup: buildMainMenu(dict),
      });
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
      billingCycle: null,
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
  const billingCycle = usage.billingCycle
    ? usage.billingCycle.toLowerCase()
    : null;

  const text = dict.accountText({
    plan: usage.plan,
    billingCycle,
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

export async function deliverReadyTelegramJobs(
  client: TelegramClient,
  appUrl: string
) {
  const deliveries = await telegramDeliveryService.getPendingTelegramDeliveries();

  for (const delivery of deliveries) {
    try {
      const locale = await getUserLocale(delivery.userId);
      const dict = t(locale);

      if (delivery.job.status === "FAILED") {
        await client.sendMessage(
          delivery.chatId,
          dict.processingFailed(delivery.job.error || "Unknown error")
        );
        await markTelegramDeliveryFailed(
          delivery.id,
          delivery.job.error || "Job failed"
        );
        continue;
      }

      if (delivery.job.clips.length === 0) {
        await client.sendMessage(
          delivery.chatId,
          dict.doneNoClips(delivery.job.noClipsReason ?? "NO_VIABLE_MOMENTS")
        );
        await markTelegramDeliverySent(delivery.id);
        continue;
      }

      await client.sendMessage(
        delivery.chatId,
        dict.done(delivery.job.clips.length)
      );

      for (const clip of delivery.job.clips) {
        const url = await getPresignedDownloadUrl(clip.storageKey);
        const caption = buildClipCaption({
          title: clip.title,
          description: clip.description,
          lowQuality: clip.lowQuality,
          lowQualityNote: dict.lowQualityNote,
        });
        await client.sendVideo(delivery.chatId, url, caption, {
          inline_keyboard: [
            [
              {
                text: dict.editInBrowserBtn,
                url: `${appUrl}/dashboard/editor?clip=${clip.id}`,
              },
            ],
          ],
        });
      }

      await markTelegramDeliverySent(delivery.id);
    } catch (error) {
      await markTelegramDeliveryFailed(
        delivery.id,
        error instanceof Error ? error.message : "Delivery failed"
      );
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
      await client.sendMessage(message.chat.id, dict.menuHint, {
        replyMarkup: buildMainMenu(dict),
      });
      return; // bypass the two-button onboarding screen (deep-link)
    }
    // existing user: fall through to the normal welcome flow below
  }

  if (!existing) {
    await client.sendMessage(message.chat.id, dict.welcomeFirstChoice, {
      replyMarkup: firstChoiceKeyboard(dict),
    });
    return;
  }

  const from = message.from!;
  const user = await resolveTelegramUser(from);
  const usage = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  if (usage.plan === "NONE") {
    // The persistent menu (below) carries the 💳 Plans button; welcomeNeedsPlan
    // nudges the user to it, so no inline plan buttons here.
    await client.sendMessage(message.chat.id, dict.welcomeNeedsPlan, {
      replyMarkup: buildMainMenu(dict),
    });
    return;
  }

  await client.sendMessage(message.chat.id, dict.welcomeBack, {
    replyMarkup: buildMainMenu(dict),
  });
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
      await client
        .sendMessage(query.message.chat.id, dict.menuHint, {
          replyMarkup: buildMainMenu(dict),
        })
        .catch(() => undefined);
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
      return;
    }
    case CALLBACK_LANG_EN:
    case CALLBACK_LANG_RU: {
      const choice = parseLangCallback(query.data)!;
      const ack = await applyLangChoice(query.from, choice);
      await client
        .editMessageText(query.message.chat.id, query.message.message_id, ack)
        .catch(() => undefined);
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

export function languageKeyboard(dict: Dict): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.langBtnEn, callback_data: CALLBACK_LANG_EN }],
      [{ text: dict.langBtnRu, callback_data: CALLBACK_LANG_RU }],
    ],
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
  choice: "en" | "ru"
): Promise<string> {
  const user = await resolveTelegramUser(from);
  await prisma.user.update({
    where: { id: user.id },
    data: { telegramLocale: choice },
  });
  const dict = t(choice);
  return choice === "en" ? dict.langSetEn : dict.langSetRu;
}

async function handleLang(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  choice: ReturnType<typeof parseLangCommand>,
  currentDict: Dict
) {
  if (choice === "usage" || choice === null) {
    await client.sendMessage(message.chat.id, currentDict.langUsage);
    return;
  }

  const ack = await applyLangChoice(from, choice);
  await client.sendMessage(message.chat.id, ack);
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

async function handleVideo(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  source: VideoSource,
  dict: Dict,
  config: BotRuntimeConfig
) {
  const user = await resolveTelegramUser(from);
  const blockedReason = await getSubmissionBlocker(user.id, source.duration);
  if (blockedReason) {
    await client.sendMessage(
      message.chat.id,
      dict.blocked(blockedReason)
    );
    return;
  }

  if (
    typeof source.fileSize === "number" &&
    source.fileSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES
  ) {
    await client.sendMessage(message.chat.id, dict.fileTooLarge(config.appUrl));
    return;
  }

  await client.sendMessage(message.chat.id, dict.uploading);

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

  const probe = await probeVideoUrl(url);
  if (!probe.ok) {
    await client.sendMessage(message.chat.id, dict.urlAccessFailed);
    return;
  }

  const user = await resolveTelegramUser(from);
  const blockedReason = await getSubmissionBlocker(user.id, probe.durationSec);
  if (blockedReason) {
    await client.sendMessage(
      message.chat.id,
      dict.blocked(blockedReason)
    );
    return;
  }

  const job = await jobService.createJob({
    userId: user.id,
    sourceUrl: url,
    originalFilename: probe.title,
    subtitles: user.subtitlesEnabled,
    sourceDurationSec: probe.durationSec,
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

async function getSubmissionBlocker(userId: string, durationSec?: number) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.plan === "NONE") {
    return "Active subscription required to process videos.";
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const durationMinutes =
    typeof durationSec === "number" && durationSec > 0
      ? Math.ceil(durationSec / 60)
      : 0;

  if (
    durationMinutes > 0 &&
    durationMinutes > limits.maxSourceDurationMinutes
  ) {
    return `Source exceeds max duration (${limits.maxSourceDurationMinutes} min).`;
  }

  const submission = await canSubmitJob(userId, durationMinutes);
  if (!submission.allowed) return submission.reason;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const jobsToday = await prisma.job.count({
    where: { userId, createdAt: { gte: dayStart } },
  });
  if (jobsToday >= limits.maxJobsPerDay) {
    return `Daily job limit reached (${limits.maxJobsPerDay}).`;
  }

  const inFlight = await prisma.job.count({
    where: { userId, status: { in: [...ACTIVE_STATUSES] } },
  });
  if (inFlight >= limits.concurrentJobsLimit) {
    return `You have ${inFlight} active jobs (limit: ${limits.concurrentJobsLimit}).`;
  }

  return null;
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
    )
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
