"use client";

import { useEffect, useState } from "react";
import { initDataFromLaunchHash, isTelegramLaunch } from "@/lib/telegram-launch";

/** Where the launch credential is kept for the life of the webview session. */
const INIT_DATA_KEY = "cc_admin_initdata";

/** Set once we have reloaded on a successful /enter, so a cookie that does not
 *  take effect cannot bounce the page forever. Per tab, cleared when the Mini
 *  App is closed - which is exactly the retry the admin would do by hand. */
const RELOADED_KEY = "cc_admin_entered";

function readSession(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Private mode or a webview with storage disabled. We lose the re-open
    // survival and the loop guard, but the first launch still works.
  }
}

/**
 * The launch credential, from the URL on a first launch and from the session
 * afterwards.
 *
 * Telegram signs `tgWebAppData` into the fragment ONCE, when the Mini App is
 * first opened. Every later load in the same webview - our own reload after
 * sign-in, or Telegram re-opening a session it kept alive - arrives with
 * `tgWebAppVersion`, `tgWebAppPlatform` and `tgWebAppThemeParams` but no data at
 * all. Reading only the URL therefore worked exactly once and then went silent,
 * which is what left the admin page blank. telegram-web-app.js survives this by
 * stashing the value on first sight; so do we.
 */
function readInitData(): { initData: string; fresh: boolean } {
  const fromLaunch = initDataFromLaunchHash(window.location.hash);
  if (fromLaunch) {
    writeSession(INIT_DATA_KEY, fromLaunch);
    return { initData: fromLaunch, fresh: true };
  }
  return { initData: readSession(INIT_DATA_KEY), fresh: false };
}

function clearSession(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Same storage-disabled case as writeSession; nothing to undo.
  }
}

/** What to do when there is nothing usable left: only Telegram can mint a new
 *  auth_date, and it only does so for a genuinely new session. */
const REOPEN =
  "Close the Mini App completely and open it again from the Analytics button.";

/**
 * Rendered when the request carries neither an admin session nor the cookie.
 *
 * Inside Telegram it recovers initData, hands it to /api/admin/enter and reloads
 * into the real page. Outside Telegram the fragment is empty, so it renders
 * nothing and the page stays blank - the 404-equivalent that keeps this route
 * from advertising itself.
 */
export function MiniAppGate() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Anything we say is visible only to someone Telegram actually launched.
    const inTelegram = isTelegramLaunch(window.location.hash);
    const say = (message: string) => setError(inTelegram ? message : null);

    const { initData, fresh } = readInitData();
    if (!initData) {
      say(`Telegram did not pass sign-in data. ${REOPEN}`);
      return;
    }

    // A new launch is a clean slate. Without this, a loop guard left behind by
    // an earlier attempt in the same webview would reject the retry it exists
    // to make possible.
    if (fresh) clearSession(RELOADED_KEY);

    if (!fresh && readSession(RELOADED_KEY)) {
      // We already authenticated and reloaded, yet we are back at the gate: the
      // cookie is not surviving the round trip. Reloading again would spin.
      say(`Signed in, but the session cookie did not stick. ${REOPEN}`);
      return;
    }

    let cancelled = false;
    fetch("/api/admin/enter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData }),
    })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          // Either the sign-in aged out of its one-hour window or this account
          // is not an admin. The route refuses to say which, so neither do we.
          // Drop the stash either way: a refused credential never recovers.
          clearSession(INIT_DATA_KEY);
          say(`Sign-in was refused - it may have expired. ${REOPEN}`);
          return;
        }
        writeSession(RELOADED_KEY, "1");
        window.location.reload();
      })
      .catch(() => {
        if (!cancelled) say("Could not reach the server. Check the connection.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!error) return null;
  return (
    <div className="mx-auto max-w-xl p-5">
      <p className="text-sm opacity-80">{error}</p>
    </div>
  );
}
