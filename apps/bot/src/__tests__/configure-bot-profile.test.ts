import { describe, expect, it, vi } from "vitest";
import { configureBotProfile } from "../setup";
import { DEFAULT_LOCALE, LOCALES, t, type Locale } from "../i18n";

/** A bot whose profile is blank, so every field differs and every write fires. */
function makeStubClient() {
  return {
    setMyDescription: vi.fn().mockResolvedValue(true),
    setMyShortDescription: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
    getMyDescription: vi.fn().mockResolvedValue({ description: "" }),
    getMyShortDescription: vi.fn().mockResolvedValue({ short_description: "" }),
    getMyCommands: vi.fn().mockResolvedValue([]),
  };
}

/** A bot already carrying exactly what the dictionaries say - the steady state
 *  after one successful sync, which is what every subsequent boot should find. */
function makeInSyncClient() {
  return {
    setMyDescription: vi.fn().mockResolvedValue(true),
    setMyShortDescription: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
    // async, not a bare object: configureBotProfile chains .then() onto the
    // reads, so a synchronous stub throws, the read is treated as failed, and
    // the write fires anyway - which is correct production behaviour and would
    // silently make this test assert nothing.
    getMyDescription: vi.fn(async (lang?: Locale) => ({
      description: t(lang ?? DEFAULT_LOCALE).botDescription,
    })),
    getMyShortDescription: vi.fn(async (lang?: Locale) => ({
      short_description: t(lang ?? DEFAULT_LOCALE).botShortDescription,
    })),
    getMyCommands: vi.fn(async (lang?: Locale) =>
      t(lang ?? DEFAULT_LOCALE).commands
    ),
  };
}

describe("configureBotProfile", () => {
  // Driven off LOCALES rather than a pair of literals: a language added to the
  // registry but missing from the Telegram profile sync shows up as an English
  // description and command list in a client set to that language, which no
  // other test would catch.
  it("syncs description, short description and commands for every locale", async () => {
    const client = makeStubClient();
    await configureBotProfile(client as never);

    // LOCALES + 1: the six languages plus the language-neutral default slot.
    expect(client.setMyDescription).toHaveBeenCalledTimes(LOCALES.length + 1);
    expect(client.setMyShortDescription).toHaveBeenCalledTimes(
      LOCALES.length + 1
    );
    expect(client.setMyCommands).toHaveBeenCalledTimes(LOCALES.length + 1);

    for (const loc of LOCALES) {
      expect(client.setMyDescription).toHaveBeenCalledWith(
        t(loc).botDescription,
        loc
      );
      expect(client.setMyShortDescription).toHaveBeenCalledWith(
        t(loc).botShortDescription,
        loc
      );
      expect(client.setMyCommands).toHaveBeenCalledWith(t(loc).commands, loc);
    }
  });

  // The regression this file exists to hold shut. Telegram falls back to the
  // entry stored with an EMPTY language_code, and nothing wrote it: a client set
  // to German, Turkish, Polish or anything else outside LOCALES got a start page
  // with no description and an empty slash-command menu. Verified live against
  // getMyDescription, which answered "" for language_code= and for de and fr.
  //
  // Asserted with an explicit `undefined` rather than by counting calls, because
  // a future locale added to the registry would keep a count-only test green
  // while the fallback slot went unwritten again.
  it("writes the language-neutral default slot with the default locale's words", async () => {
    const client = makeStubClient();
    await configureBotProfile(client as never);

    expect(client.setMyDescription).toHaveBeenCalledWith(
      t(DEFAULT_LOCALE).botDescription,
      undefined
    );
    expect(client.setMyShortDescription).toHaveBeenCalledWith(
      t(DEFAULT_LOCALE).botShortDescription,
      undefined
    );
    expect(client.setMyCommands).toHaveBeenCalledWith(
      t(DEFAULT_LOCALE).commands,
      undefined
    );
  });

  // What keeps the profile out of Telegram's rate limiter. The sync runs on
  // every boot and the bot boots on every source edit under tsx watch; writing
  // all 21 values each time is what produced "Too Many Requests: retry after
  // 156" on all three setters and left four locales updated and two stale.
  it("writes nothing when every field already matches", async () => {
    const client = makeInSyncClient();
    const summary = await configureBotProfile(client as never);

    expect(client.setMyDescription).not.toHaveBeenCalled();
    expect(client.setMyShortDescription).not.toHaveBeenCalled();
    expect(client.setMyCommands).not.toHaveBeenCalled();

    expect(summary).toEqual({
      updated: 0,
      current: (LOCALES.length + 1) * 3,
      failed: 0,
    });
  });

  // A read that throws must NOT be read as "already correct" - otherwise one
  // flaky request leaves stale copy live until someone notices by eye.
  it("still writes when the read fails", async () => {
    const client = makeStubClient();
    client.getMyDescription = vi
      .fn()
      .mockRejectedValue(new Error("network")) as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await configureBotProfile(client as never);

    expect(client.setMyDescription).toHaveBeenCalledTimes(LOCALES.length + 1);
    warn.mockRestore();
  });

  it("does not throw when the client fails - counts it and logs a warning", async () => {
    const client = makeStubClient();
    client.setMyDescription = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(true) as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const summary = await configureBotProfile(client as never);

    expect(summary.failed).toBe(1);
    expect(summary.updated).toBe((LOCALES.length + 1) * 3 - 1);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
