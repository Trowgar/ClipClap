import { prisma } from "../lib/prisma";

/**
 * Funnel steps at the very top of the Telegram bot.
 *
 * The bot's first screen offers two buttons and creates nothing until one is
 * pressed, so before this existed the only measurable point in the funnel was
 * "already an account". Three steps are enough to answer the question the
 * owner actually has - how many people reach the first screen, and how many
 * go past it - and no more than that is recorded: no message contents, no
 * per-press rows, no third-party analytics.
 *
 * The values are wire format. They are written to a String column and read by
 * hand in SQL, so they must not be renamed casually.
 */
export const BOT_FUNNEL_EVENTS = {
  /** The two-button screen was shown to somebody with no account yet. */
  FIRST_SCREEN: "start_first_screen",
  /** They pressed "New account" - past the screen, via the bot. */
  NEW_ACCOUNT: "first_screen_new_account",
  /** They pressed "Link account" - past the screen, via the web account. */
  LINK_ACCOUNT: "first_screen_link_account",
} as const;

export type BotFunnelEvent =
  (typeof BOT_FUNNEL_EVENTS)[keyof typeof BOT_FUNNEL_EVENTS];

/**
 * Records that `telegramId` reached `event`. Counts people, not presses: the
 * row is unique per (telegramId, event) and a repeat bumps `occurrences`.
 *
 * NEVER THROWS, and never rejects. This is called on a stranger's first
 * interaction with the product, and a telemetry write that can turn that
 * interaction into silence is worse than having no telemetry at all. The
 * swallow lives here rather than at each call site so no caller can forget
 * it - but it logs, so a suspiciously flat funnel can be traced to failing
 * writes instead of to a dead product.
 *
 * Callers must still await it AFTER the user has been answered, not before.
 */
export async function recordBotFunnelEvent(
  event: BotFunnelEvent,
  telegramId: string | number,
  locale?: string | null
): Promise<void> {
  try {
    const id = String(telegramId);
    await prisma.botFunnelEvent.upsert({
      where: { telegramId_event: { telegramId: id, event } },
      create: { telegramId: id, event, locale: locale ?? null },
      update: {
        occurrences: { increment: 1 },
        lastSeenAt: new Date(),
        // Someone who switched their Telegram language between visits: the
        // latest is the one that matters for what copy they are reading now.
        ...(locale ? { locale } : {}),
      },
    });
  } catch (error) {
    // Includes the case where the Prisma client in this container predates the
    // migration and `botFunnelEvent` is undefined - a synchronous TypeError,
    // caught here as well because the throw happens inside the try.
    console.error(
      `Funnel telemetry: could not record ${event} for ${telegramId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
