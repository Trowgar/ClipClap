import { prisma } from "../lib/prisma";
import { Prisma, type SupportMessage } from "@prisma/client";
import { getSupportChatId, sendTelegramMessage } from "./telegram-notification.service";

export type SupportDirection = "in" | "out";
export type SupportKind =
  | "text"
  /** Text sent with NO support session open - so it was never relayed to the
   *  owner and nobody has read it. This is where a reply to one of our own
   *  outbound messages lands: the bot answers "send me a video" and the
   *  sentence a customer actually wrote used to vanish. Recorded separately
   *  from "text" precisely so the two are never confused - one was seen by a
   *  human, the other was not. */
  | "loose_text"
  | "photo"
  | "document"
  | "video"
  | "voice"
  | "other";

/**
 * Records one side of a support exchange.
 *
 * NEVER THROWS, for the same reason `recordFunnelEvent` does not: this is called
 * on the path where a customer is talking to us, and a logging write that can
 * swallow that conversation is worse than having no log. Callers await it AFTER
 * the message has been relayed or delivered, never before.
 *
 * `text` is truncated at 4,000 characters - a Telegram message cannot exceed
 * 4,096 and the remainder is never the part worth keeping.
 */
export async function recordSupportMessage(params: {
  telegramId: string | number;
  direction: SupportDirection;
  text: string;
  kind?: SupportKind;
  userId?: string | null;
}): Promise<void> {
  try {
    await prisma.supportMessage.create({
      data: {
        telegramId: String(params.telegramId),
        direction: params.direction,
        text: (params.text ?? "").slice(0, 4000),
        kind: params.kind ?? "text",
        userId: params.userId ?? null,
      },
    });
  } catch (error) {
    // Includes the case where the Prisma client in this container predates the
    // migration and `supportMessage` is undefined - a synchronous TypeError,
    // which happens inside the try and is caught here too.
    console.error(
      `Support log: could not record ${params.direction} for ${params.telegramId}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/** One person's thread, oldest first. The operator reads this to answer. */
export async function supportThread(telegramId: string | number, take = 50) {
  return prisma.supportMessage.findMany({
    where: { telegramId: String(telegramId) },
    orderBy: { createdAt: "asc" },
    take,
  });
}

export class SupportRateLimitError extends Error {}

export interface WebSupportInput {
  userId: string;
  clientMessageId: string;
  text: string;
  contextPath?: string;
}

export interface WebReplyInput {
  userId: string;
  text: string;
  supportChatId: string;
  telegramMessageId: number;
}

const WEB_SUPPORT_RATE_LIMIT = 10;

export async function submitWebSupportMessage(input: WebSupportInput): Promise<SupportMessage> {
  const dedupeKey = `web:${input.userId}:${input.clientMessageId}`;
  let message = await prisma.supportMessage.findUnique({ where: { dedupeKey } });
  if (message?.deliveryStatus === "sent" || message?.deliveryStatus === "pending") return message;

  if (!message) {
    const recent = await prisma.supportMessage.count({ where: {
      userId: input.userId, surface: "web", direction: "in",
      createdAt: { gte: new Date(Date.now() - 60_000) },
    } });
    if (recent >= WEB_SUPPORT_RATE_LIMIT) throw new SupportRateLimitError("Too many support messages. Please wait a minute.");
    try {
      message = await prisma.supportMessage.create({ data: {
        userId: input.userId, telegramId: null, surface: "web", direction: "in",
        text: input.text, kind: "text", deliveryStatus: "pending", dedupeKey,
        contextPath: input.contextPath ?? null,
      } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      message = await prisma.supportMessage.findUniqueOrThrow({ where: { dedupeKey } });
      if (message.deliveryStatus !== "failed") return message;
    }
  }

  const [user, chatId] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } }),
    Promise.resolve(getSupportChatId()),
  ]);
  const label = [user?.name, user?.email ? `(${user.email})` : null]
    .filter(Boolean).join(" ").replace(/[\r\n]+/g, " ").slice(0, 160) || input.userId;
  const context = message.contextPath ? `\nContext: ${message.contextPath}` : "";
  const delivered = chatId
    ? await sendTelegramMessage(chatId, `🆕 #web${input.userId} ${label}${context}\n\n${message.text}`)
    : false;
  return prisma.supportMessage.update({
    where: { id: message.id }, data: { deliveryStatus: delivered ? "sent" : "failed" },
  });
}

export async function listWebSupportMessages(userId: string, take = 100): Promise<SupportMessage[]> {
  const rows = await prisma.supportMessage.findMany({
    where: { userId, surface: "web" }, orderBy: { createdAt: "desc" }, take,
  });
  return rows.reverse();
}

export async function storeWebSupportReply(input: WebReplyInput): Promise<{
  message: SupportMessage; created: boolean; shouldNotify: boolean;
}> {
  const dedupeKey = `web-reply:${input.supportChatId}:${input.telegramMessageId}`;
  const duplicate = await prisma.supportMessage.findUnique({ where: { dedupeKey } });
  if (duplicate) return { message: duplicate, created: false, shouldNotify: false };
  const olderUnread = await prisma.supportMessage.findFirst({ where: {
    userId: input.userId, surface: "web", direction: "out", readAt: null,
  } });
  try {
    const message = await prisma.supportMessage.create({ data: {
      userId: input.userId, telegramId: null, surface: "web", direction: "out",
      text: input.text, kind: "text", deliveryStatus: "sent", dedupeKey,
    } });
    return { message, created: true, shouldNotify: !olderUnread };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const message = await prisma.supportMessage.findUniqueOrThrow({ where: { dedupeKey } });
    return { message, created: false, shouldNotify: false };
  }
}

export async function markWebSupportRead(userId: string): Promise<number> {
  const result = await prisma.supportMessage.updateMany({
    where: { userId, surface: "web", direction: "out", readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

export function countUnreadWebSupport(userId: string): Promise<number> {
  return prisma.supportMessage.count({
    where: { userId, surface: "web", direction: "out", readAt: null },
  });
}

export async function markSupportEmailNotified(messageId: string): Promise<void> {
  await prisma.supportMessage.update({
    where: { id: messageId }, data: { emailNotifiedAt: new Date() },
  });
}
