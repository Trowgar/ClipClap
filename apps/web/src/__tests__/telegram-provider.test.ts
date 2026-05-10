import { describe, expect, it } from "vitest";
import {
  TELEGRAM_OIDC_ISSUER,
  createTelegramProvider,
  mapTelegramProfile,
} from "../../lib/telegram-provider";

describe("telegram-provider", () => {
  it("maps Telegram OIDC profile using Telegram user id for bot matching", () => {
    const profile = mapTelegramProfile({
      sub: "oidc-subject",
      id: 12345,
      name: "Ada Lovelace",
      preferred_username: "ada",
      picture: "https://cdn.example/avatar.jpg",
    });

    expect(profile).toEqual({
      id: "12345",
      name: "Ada Lovelace",
      email: null,
      image: "https://cdn.example/avatar.jpg",
    });
  });

  it("falls back to OIDC subject when Telegram user id is absent", () => {
    const profile = mapTelegramProfile({
      sub: "oidc-subject",
      preferred_username: "ada",
    });

    expect(profile.id).toBe("oidc-subject");
    expect(profile.name).toBe("ada");
  });

  it("creates an OIDC provider with Telegram discovery and PKCE checks", () => {
    const provider = createTelegramProvider({
      clientId: "12345",
      clientSecret: "secret",
    });

    expect(provider).toEqual(
      expect.objectContaining({
        id: "telegram",
        name: "Telegram",
        type: "oidc",
        issuer: TELEGRAM_OIDC_ISSUER,
        clientId: "12345",
        clientSecret: "secret",
        checks: ["pkce", "state"],
        idToken: true,
      })
    );
    expect(provider.authorization).toEqual({
      params: { scope: "openid profile telegram:bot_access" },
    });
  });
});
