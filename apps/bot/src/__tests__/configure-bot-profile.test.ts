import { describe, expect, it, vi } from "vitest";
import { configureBotProfile } from "../setup";
import { LOCALES, t } from "../i18n";

function makeStubClient() {
  return {
    setMyDescription: vi.fn().mockResolvedValue(true),
    setMyShortDescription: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
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

    expect(client.setMyDescription).toHaveBeenCalledTimes(LOCALES.length);
    expect(client.setMyShortDescription).toHaveBeenCalledTimes(LOCALES.length);
    expect(client.setMyCommands).toHaveBeenCalledTimes(LOCALES.length);

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

  it("does not throw when the client fails - logs a warning instead", async () => {
    const client = {
      setMyDescription: vi
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue(true),
      setMyShortDescription: vi.fn().mockResolvedValue(true),
      setMyCommands: vi.fn().mockResolvedValue(true),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(configureBotProfile(client as never)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
