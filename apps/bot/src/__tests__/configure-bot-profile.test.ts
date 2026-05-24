import { describe, expect, it, vi } from "vitest";
import { configureBotProfile } from "../setup";
import { t } from "../i18n";

function makeStubClient() {
  return {
    setMyDescription: vi.fn().mockResolvedValue(true),
    setMyShortDescription: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
  };
}

describe("configureBotProfile", () => {
  it("syncs description, short description and commands for en and ru", async () => {
    const client = makeStubClient();
    await configureBotProfile(client as never);

    expect(client.setMyDescription).toHaveBeenCalledTimes(2);
    expect(client.setMyDescription).toHaveBeenCalledWith(
      t("en").botDescription,
      "en"
    );
    expect(client.setMyDescription).toHaveBeenCalledWith(
      t("ru").botDescription,
      "ru"
    );

    expect(client.setMyShortDescription).toHaveBeenCalledTimes(2);
    expect(client.setMyShortDescription).toHaveBeenCalledWith(
      t("en").botShortDescription,
      "en"
    );
    expect(client.setMyShortDescription).toHaveBeenCalledWith(
      t("ru").botShortDescription,
      "ru"
    );

    expect(client.setMyCommands).toHaveBeenCalledTimes(2);
    expect(client.setMyCommands).toHaveBeenCalledWith(t("en").commands, "en");
    expect(client.setMyCommands).toHaveBeenCalledWith(t("ru").commands, "ru");
  });

  it("does not throw when the client fails — logs a warning instead", async () => {
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
