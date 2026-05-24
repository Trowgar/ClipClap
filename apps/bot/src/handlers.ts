import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  canSubmitJob,
  createBotInitiatedLink,
  createTelegramDelivery,
  findOrCreateTelegramUser,
  getPlanLimits,
  getPresignedDownloadUrl,
  jobService,
  markTelegramDeliveryFailed,
  markTelegramDeliverySent,
  prisma,
  redeemLinkFromBot,
  telegramDeliveryService,
  uploadFile,
} from "@clipfast/shared";
import type { User } from "@prisma/client";
import type { TelegramClient } from "./telegram-client";
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
export const CALLBACK_LANG_AUTO = "lang_auto";

export function parseLangCallback(
  data: string | undefined
): "en" | "ru" | "auto" | null {
  if (!data) return null;
  if (data === CALLBACK_LANG_EN) return "en";
  if (data === CALLBACK_LANG_RU) return "ru";
  if (data === CALLBACK_LANG_AUTO) return "auto";
  return null;
}

export type MenuAction = "plans" | "account" | "help" | "language";

export function matchMenuAction(text: string): MenuAction | null {
  for (const loc of ["en", "ru"] as const) {
    const d = t(loc);
    if (text === d.menuPlans) return "plans";
    if (text === d.menuAccount) return "account";
    if (text === d.menuHelp) return "help";
    if (text === d.menuLanguage) return "language";
  }
  return null;
}

function buildMainMenu(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.menuPlans }, { text: dict.menuAccount }],
      [{ text: dict.menuHelp }, { text: dict.menuLanguage }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}

export interface BotRuntimeConfig {
  appUrl: string;
  tributeUrls: {
    starterWeekly?: string;
    starter?: string;
    plus?: string;
    max?: string;
  };
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

  const menuAction = parseMenuCommand(text) ?? matchMenuAction(text);
  if (menuAction) {
    await handleMenuAction(client, message, menuAction, dict, config, existing);
    return;
  }

  const source = getVideoSource(message);
  if (!source) {
    await client.sendMessage(message.chat.id, dict.sendVideoHint);
    return;
  }

  await handleVideo(client, message, from, source, dict, config);
}

function parseMenuCommand(text: string): MenuAction | null {
  const m = /^\/(plans|account|help)(@\S+)?(\s|$)/.exec(text);
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
    case "plans": {
      const keyboard = plansKeyboard(dict, config);
      await client.sendMessage(
        message.chat.id,
        dict.welcomeNeedsPlan(config.appUrl),
        keyboard ? { replyMarkup: keyboard } : undefined
      );
      return;
    }
    case "account": {
      const text = await renderAccountText(dict, existing?.id);
      await client.sendMessage(message.chat.id, text);
      return;
    }
    case "help": {
      await client.sendMessage(message.chat.id, dict.helpText(config.appUrl));
      return;
    }
    case "language": {
      await client.sendMessage(message.chat.id, dict.languageMenuPrompt, {
        replyMarkup: languageKeyboard(dict),
      });
      return;
    }
  }
}

async function renderAccountText(
  dict: Dict,
  userId: string | undefined
): Promise<string> {
  if (!userId) {
    return dict.accountText({
      plan: "NONE",
      billingCycle: null,
      periodEnd: null,
      clipsTotal: 0,
    });
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, billingCycle: true, currentPeriodEnd: true },
  });
  const clipsTotal = await prisma.clip.count({ where: { userId } });
  const periodEndIso = user?.currentPeriodEnd;
  return dict.accountText({
    plan: user?.plan ?? "NONE",
    billingCycle: user?.billingCycle ?? null,
    periodEnd: periodEndIso
      ? periodEndIso.toISOString().slice(0, 10)
      : null,
    clipsTotal,
  });
}

export async function deliverReadyTelegramJobs(client: TelegramClient) {
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

      await client.sendMessage(
        delivery.chatId,
        dict.done(delivery.job.clips.length)
      );

      for (const clip of delivery.job.clips) {
        const url = await getPresignedDownloadUrl(clip.storageKey);
        await client.sendVideo(delivery.chatId, url, clip.title);
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
    const keyboard = plansKeyboard(dict, config);
    await client.sendMessage(
      message.chat.id,
      dict.welcomeNeedsPlan(config.appUrl),
      keyboard ? { replyMarkup: keyboard } : undefined
    );
    // Attach the persistent reply menu in a separate follow-up so the user has
    // access to Account/Help/Language even before they pick a plan.
    await client.sendMessage(message.chat.id, dict.menuHint, {
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

  switch (query.data) {
    case CALLBACK_NEW_ACCOUNT: {
      await resolveTelegramUser(query.from);
      const keyboard = plansKeyboard(dict, config);
      await client
        .editMessageText(
          query.message.chat.id,
          query.message.message_id,
          dict.newAccountCreated(config.appUrl),
          keyboard ? { replyMarkup: keyboard } : undefined
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
    case CALLBACK_LANG_RU:
    case CALLBACK_LANG_AUTO: {
      const choice = parseLangCallback(query.data)!;
      const ack = await applyLangChoice(query.from, choice);
      await client
        .editMessageText(
          query.message.chat.id,
          query.message.message_id,
          ack
        )
        .catch(() => undefined);
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

function languageKeyboard(dict: Dict): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.langBtnEn, callback_data: CALLBACK_LANG_EN }],
      [{ text: dict.langBtnRu, callback_data: CALLBACK_LANG_RU }],
      [{ text: dict.langBtnAuto, callback_data: CALLBACK_LANG_AUTO }],
    ],
  };
}

export function plansKeyboard(
  dict: Dict,
  config: BotRuntimeConfig
): InlineKeyboardMarkup | null {
  const rows: { text: string; url: string }[][] = [];
  if (config.tributeUrls.starterWeekly) {
    rows.push([
      { text: dict.planStarterWeeklyBtn, url: config.tributeUrls.starterWeekly },
    ]);
  }
  if (config.tributeUrls.starter) {
    rows.push([{ text: dict.planStarterBtn, url: config.tributeUrls.starter }]);
  }
  if (config.tributeUrls.plus) {
    rows.push([{ text: dict.planPlusBtn, url: config.tributeUrls.plus }]);
  }
  if (config.tributeUrls.max) {
    rows.push([{ text: dict.planMaxBtn, url: config.tributeUrls.max }]);
  }
  if (rows.length === 0) return null;
  return { inline_keyboard: rows };
}

async function applyLangChoice(
  from: TelegramUser,
  choice: "en" | "ru" | "auto"
): Promise<string> {
  const user = await resolveTelegramUser(from);
  const stored: string | null = choice === "auto" ? null : choice;
  await prisma.user.update({
    where: { id: user.id },
    data: { telegramLocale: stored },
  });

  const effectiveLocale: Locale =
    choice === "en"
      ? "en"
      : choice === "ru"
        ? "ru"
        : detectLocale(from.language_code);
  const dict = t(effectiveLocale);

  const ack =
    choice === "en"
      ? dict.langSetEn
      : choice === "ru"
        ? dict.langSetRu
        : dict.langSetAuto;

  return ack;
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

type StartPayload = { kind: "link"; code: string } | null;

export function parseStartPayload(text: string): StartPayload {
  const trimmed = text.replace(/^\/start(@\S+)?\s*/, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("link_")) {
    const code = trimmed.slice("link_".length).trim();
    if (code) return { kind: "link", code };
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
      dict.blocked(blockedReason, config.appUrl)
    );
    return;
  }

  console.log("[handleVideo] source", {
    fileId: source.fileId,
    fileSize: source.fileSize,
    duration: source.duration,
    mimeType: source.mimeType,
    fileName: source.fileName,
    limit: TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  });

  if (
    typeof source.fileSize === "number" &&
    source.fileSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES
  ) {
    console.warn("[handleVideo] pre-check rejected: file_size exceeds limit");
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
      subtitles: true,
      subtitlePreset: "tiktok",
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
