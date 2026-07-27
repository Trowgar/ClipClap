"use client";

import { useEffect, useState } from "react";

/**
 * Rendered when the request carries neither an admin session nor the cookie.
 *
 * Inside Telegram it hands initData to /api/admin/enter and reloads into the
 * real page. In a plain browser window.Telegram is undefined, so it renders
 * nothing and the page stays blank.
 */
export function MiniAppGate() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // The Telegram script is injected below; poll briefly for it rather than
    // guessing when it has loaded.
    let tries = 0;
    const timer = setInterval(() => {
      const initData = (
        window as unknown as {
          Telegram?: { WebApp?: { initData?: string } };
        }
      ).Telegram?.WebApp?.initData;

      if (initData) {
        clearInterval(timer);
        fetch("/api/admin/enter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ initData }),
        })
          .then((r) => {
            // Reload only on success, so a rejected signature does not spin.
            if (r.ok) window.location.reload();
          })
          .catch(() => undefined);
        return;
      }
      if (++tries > 20) {
        clearInterval(timer);
        setReady(true);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <script src="https://telegram.org/js/telegram-web-app.js" async />
      {ready ? null : null}
    </>
  );
}
