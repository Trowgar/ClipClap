import type { OAuthConfig } from "@auth/core/providers";

export const TELEGRAM_OIDC_ISSUER = "https://oauth.telegram.org";
export const TELEGRAM_AUTH_SCOPE = "openid profile telegram:bot_access";

export interface TelegramOidcProfile {
  sub?: string;
  id?: string | number;
  name?: string;
  preferred_username?: string;
  picture?: string;
}

export function getTelegramProfileId(profile: TelegramOidcProfile): string {
  const id = profile.id ?? profile.sub;
  if (!id) throw new Error("Telegram profile is missing id");
  return String(id);
}

export function mapTelegramProfile(profile: TelegramOidcProfile) {
  return {
    id: getTelegramProfileId(profile),
    name: profile.name ?? profile.preferred_username ?? "Telegram User",
    email: null,
    image: profile.picture ?? null,
  };
}

export function createTelegramProvider({
  clientId,
  clientSecret,
}: {
  clientId: string;
  clientSecret: string;
}): OAuthConfig<TelegramOidcProfile> {
  return {
    id: "telegram",
    name: "Telegram",
    type: "oidc",
    issuer: TELEGRAM_OIDC_ISSUER,
    clientId,
    clientSecret,
    checks: ["pkce", "state"],
    idToken: true,
    authorization: {
      params: {
        scope: TELEGRAM_AUTH_SCOPE,
      },
    },
    profile: mapTelegramProfile,
  };
}
