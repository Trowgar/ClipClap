import type { TelegramClient } from "./telegram-client";
import { t, type Locale } from "./i18n";

const LOCALES: Locale[] = ["en", "ru"];

export async function configureBotProfile(client: TelegramClient): Promise<void> {
  for (const locale of LOCALES) {
    const dict = t(locale);
    try {
      await client.setMyDescription(dict.botDescription, locale);
      await client.setMyShortDescription(dict.botShortDescription, locale);
      await client.setMyCommands(dict.commands, locale);
    } catch (error) {
      console.warn(
        `Bot profile sync failed for locale=${locale}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}
