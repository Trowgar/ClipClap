import type { TelegramClient } from "./telegram-client";
import { DEFAULT_LOCALE, LOCALES, t, type Locale } from "./i18n";

export interface ProfileSyncSummary {
  /** Fields whose remote value differed and were rewritten. */
  updated: number;
  /** Fields already carrying the right value - the steady state. */
  current: number;
  /** Fields whose read AND write both failed. */
  failed: number;
}

type Commands = ReadonlyArray<{ command: string; description: string }>;

function sameCommands(a: Commands | undefined, b: Commands): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every(
    (cmd, i) =>
      cmd.command === b[i]!.command && cmd.description === b[i]!.description
  );
}

/**
 * Pushes the bot's profile to Telegram: start-page description, the short
 * description shown in search and link previews, and the slash-command menu.
 *
 * WRITES ONLY WHAT DIFFERS, and that is the whole point of the shape below.
 *
 * This used to write all 21 values - 7 slots x 3 fields - on every single boot.
 * Telegram rate-limits the setMy* family hard: measured here as "Too Many
 * Requests: retry after 156" on all three methods at once. Because the bot runs
 * under tsx watch, every source edit is a boot, so an afternoon of copy edits
 * fired several hundred writes and left the profile half-updated - four locales
 * on the new text, two still on the old, which is worse than either. The
 * getMy* family absorbed dozens of calls over that same session without one
 * 429, so a read is the cheap way to find out whether a write is needed at all.
 *
 * In the steady state this now performs 21 reads and ZERO writes.
 *
 * A read that throws does NOT skip the write. We only know a value is already
 * correct by having read it; not knowing has to mean "write it", or a
 * transient read failure would silently leave stale copy in place forever.
 *
 * `undefined` leads the slot list on purpose, and it is not a seventh language.
 * Telegram resolves each field by the user's CLIENT language and falls back to
 * the entry stored with an EMPTY language_code when that language has none of
 * its own. The loop used to run over LOCALES alone, so that fallback slot was
 * never written at all: a user whose Telegram is set to German, Turkish, Polish,
 * French or anything else outside our six opened the bot to a start page with NO
 * description and an EMPTY command menu. Confirmed against getMyDescription and
 * getMyCommands, which answered "" and [] for the default slot and for de/fr.
 *
 * The default pass runs first so the fallback is in place before any localised
 * override lands on top of it, and it writes DEFAULT_LOCALE's words - the
 * fallback has to say something, and English is what a reader outside the six is
 * likeliest to follow.
 */
export async function configureBotProfile(
  client: TelegramClient
): Promise<ProfileSyncSummary> {
  const summary: ProfileSyncSummary = { updated: 0, current: 0, failed: 0 };
  const slots: Array<Locale | undefined> = [undefined, ...LOCALES];

  for (const locale of slots) {
    const dict = t(locale ?? DEFAULT_LOCALE);
    const label = locale ?? "(default)";

    await syncField(
      summary,
      label,
      "description",
      () => client.getMyDescription(locale).then((r) => r?.description),
      dict.botDescription,
      (value) => client.setMyDescription(value, locale)
    );

    await syncField(
      summary,
      label,
      "short description",
      () =>
        client
          .getMyShortDescription(locale)
          .then((r) => r?.short_description),
      dict.botShortDescription,
      (value) => client.setMyShortDescription(value, locale)
    );

    await syncField(
      summary,
      label,
      "commands",
      () => client.getMyCommands(locale),
      dict.commands,
      (value) => client.setMyCommands(value, locale),
      sameCommands
    );
  }

  return summary;
}

async function syncField<T>(
  summary: ProfileSyncSummary,
  label: string,
  field: string,
  read: () => Promise<T | undefined>,
  wanted: T,
  write: (value: T) => Promise<unknown>,
  equal: (remote: T | undefined, wanted: T) => boolean = (a, b) => a === b
): Promise<void> {
  let remote: T | undefined;
  try {
    remote = await read();
    if (equal(remote, wanted)) {
      summary.current += 1;
      return;
    }
  } catch (error) {
    // Deliberately falls through to the write - see the note above on why a
    // failed read may not be read as "already correct".
    console.warn(
      `Bot profile read failed for ${label}/${field}; writing anyway:`,
      error instanceof Error ? error.message : error
    );
  }

  try {
    await write(wanted);
    summary.updated += 1;
  } catch (error) {
    summary.failed += 1;
    console.warn(
      `Bot profile write failed for ${label}/${field}:`,
      error instanceof Error ? error.message : error
    );
  }
}
