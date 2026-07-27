import type { OAuthConfig } from "@auth/core/providers";

export const TELEGRAM_OIDC_ISSUER = "https://oauth.telegram.org";
export const TELEGRAM_AUTH_SCOPE = "openid profile telegram:bot_access";

const TELEGRAM_DISCOVERY_PATH = "/.well-known/openid-configuration";

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

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

/**
 * Telegram's OIDC discovery document (oauth.telegram.org) omits
 * `userinfo_endpoint` - identity claims are delivered inside the id_token
 * instead. @auth/core's handleOAuth hard-requires `as.userinfo_endpoint` on the
 * discovery path and throws `CallbackRouteError: Authorization server did not
 * provide a userinfo endpoint` BEFORE it ever reads the id_token, so every
 * Telegram web login died with `?error=Configuration`.
 *
 * Because the provider is `idToken: true`, @auth/core takes the profile straight
 * from the validated id_token and never actually calls userinfo. So we patch a
 * placeholder `userinfo_endpoint` into the discovery response purely to satisfy
 * the assertion; the endpoint is never requested. Staying on the discovery path
 * (rather than hard-coding token/userinfo URLs) keeps the real `jwks_uri` and
 * `id_token_signing_alg_values_supported`, so id_token validation is unaffected.
 *
 * Wired onto the provider via the `customFetch` symbol in `auth.ts` (that symbol
 * must come from next-auth, whose import graph can't be pulled into unit tests -
 * so the fetch stays here, symbol-free and testable).
 */
export async function telegramDiscoveryFetch(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const response = await fetch(...args);

  const url = new URL(requestUrl(args[0]), TELEGRAM_OIDC_ISSUER);
  if (!url.pathname.endsWith(TELEGRAM_DISCOVERY_PATH) || !response.ok) {
    return response;
  }

  const metadata = await response.clone().json();
  if (metadata.userinfo_endpoint) return response;

  return Response.json({
    ...metadata,
    userinfo_endpoint: `${TELEGRAM_OIDC_ISSUER}/me`,
  });
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
    checks: ["pkce"],
    idToken: true,
    authorization: {
      params: {
        scope: TELEGRAM_AUTH_SCOPE,
      },
    },
    profile: mapTelegramProfile,
  };
}
