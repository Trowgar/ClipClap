import { prisma } from "../lib/prisma";

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
