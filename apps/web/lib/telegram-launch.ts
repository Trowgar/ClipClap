/**
 * Reads the `initData` Telegram puts in the Mini App launch URL.
 *
 * Telegram opens a Mini App at `<url>#tgWebAppData=<encoded>&tgWebAppVersion=…`,
 * where the value is the initData query string percent-encoded exactly once.
 * telegram-web-app.js does nothing more than this to produce `WebApp.initData`.
 *
 * We parse the fragment ourselves rather than loading that script, because the
 * script is fetched from telegram.org - a host that is blocked on some of the
 * networks our admin actually uses. When it fails to load `window.Telegram`
 * never exists, and the page it gates stays blank forever with no error.
 */
export function initDataFromLaunchHash(hash: string): string {
  return hashParam(hash, "tgWebAppData");
}

/**
 * Whether this page was opened by Telegram at all.
 *
 * Telegram always decorates the fragment with `tgWebAppVersion`,
 * `tgWebAppPlatform` and `tgWebAppThemeParams` - even on a re-open that carries
 * no `tgWebAppData`. That makes them the reliable "we are inside a Mini App"
 * signal, and the only condition under which the gate may say anything out
 * loud: a plain browser visit still has to render nothing.
 */
export function isTelegramLaunch(hash: string): boolean {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw
    .split("&")
    .some((pair) => /^tgWebApp[A-Za-z]*=/.test(pair));
}

function hashParam(hash: string, name: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const PREFIX = `${name}=`;

  for (const pair of raw.split("&")) {
    if (!pair.startsWith(PREFIX)) continue;
    // decodeURIComponent, NOT URLSearchParams: the latter decodes a literal `+`
    // to a space, and `+` survives encodeURIComponent unescaped. A display name
    // containing one would come through mangled and fail the signature check.
    try {
      return decodeURIComponent(pair.slice(PREFIX.length));
    } catch {
      return "";
    }
  }
  return "";
}
