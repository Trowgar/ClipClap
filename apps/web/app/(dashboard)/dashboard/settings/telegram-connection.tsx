"use client";

import { useCallback, useState } from "react";
import { Send } from "lucide-react";
import { useRouter } from "next/navigation";

interface Props {
  telegramId: string | null;
}

type Status =
  | "idle"
  | "linking"
  | "linked"
  | "unlinking"
  | "deep-linking"
  | "error";

interface RedeemResponse {
  status: string;
  mergedJobs?: number;
  mergedClips?: number;
}

export function TelegramConnection({ telegramId }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleRedeem = useCallback(async () => {
    const trimmed = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(trimmed)) {
      setStatus("error");
      setMessage("Enter the 6-character code from the bot.");
      return;
    }

    setStatus("linking");
    setMessage(null);

    try {
      const res = await fetch("/api/auth/telegram/link/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const data: RedeemResponse = await res.json();

      if (res.ok && (data.status === "linked" || data.status === "already_linked")) {
        const merged = data.mergedClips ?? 0;
        setStatus("linked");
        setMessage(
          merged > 0
            ? `Telegram connected. Imported ${merged} clip${merged === 1 ? "" : "s"} from your bot history.`
            : "Telegram connected to your account."
        );
        setCode("");
        refresh();
        return;
      }

      setStatus("error");
      setMessage(redeemErrorMessage(data.status));
    } catch {
      setStatus("error");
      setMessage("Could not reach the server. Try again.");
    }
  }, [code, refresh]);

  const handleDeepLink = useCallback(async () => {
    setStatus("deep-linking");
    setMessage(null);

    try {
      const res = await fetch("/api/auth/telegram/link/deep-link", {
        method: "POST",
      });
      const data = await res.json();

      if (!res.ok || !data.url) {
        setStatus("error");
        setMessage(
          data.error === "Telegram bot is not configured"
            ? "Telegram bot is not configured yet."
            : "Could not generate a link."
        );
        return;
      }

      window.open(data.url, "_blank", "noopener,noreferrer");
      setStatus("idle");
      setMessage("Approve the link inside Telegram, then this page will refresh on your next reload.");
    } catch {
      setStatus("error");
      setMessage("Could not reach the server. Try again.");
    }
  }, []);

  const handleUnlink = useCallback(async () => {
    setStatus("unlinking");
    setMessage(null);

    try {
      const res = await fetch("/api/auth/telegram/unlink", { method: "POST" });
      if (!res.ok) {
        setStatus("error");
        setMessage("Could not unlink. Try again.");
        return;
      }
      setStatus("idle");
      setMessage(null);
      refresh();
    } catch {
      setStatus("error");
      setMessage("Could not reach the server. Try again.");
    }
  }, [refresh]);

  if (telegramId) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2AABEE]/15">
              <Send className="h-4 w-4 text-[#2AABEE]" />
            </div>
            <div>
              <p className="text-sm font-medium">Telegram connected</p>
              <p className="text-xs text-muted-foreground">
                Telegram ID: {telegramId}
              </p>
            </div>
          </div>
          <button
            onClick={handleUnlink}
            disabled={status === "unlinking"}
            className="rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-white/[0.08] disabled:opacity-40"
          >
            {status === "unlinking" ? "Unlinking..." : "Unlink"}
          </button>
        </div>
        {message ? (
          <p className="text-sm text-muted-foreground">{message}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm">
          Connect Telegram to send clips from the bot and sign in with one
          tap.
        </p>
        <button
          onClick={handleDeepLink}
          disabled={status === "deep-linking"}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-[#2AABEE]/30 bg-[#2AABEE]/10 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-[#2AABEE]/15 disabled:opacity-40"
        >
          <Send className="h-4 w-4 text-[#2AABEE]" />
          {status === "deep-linking" ? "Opening Telegram..." : "Connect via Telegram"}
        </button>
      </div>

      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium">Have a code from the bot?</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Type /link in the bot to get a 6-character code, then paste it here.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="ABC123"
            maxLength={6}
            className="flex-1 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-2 text-sm uppercase tracking-widest text-white placeholder:text-neutral-600 outline-none focus:border-white/20"
          />
          <button
            onClick={handleRedeem}
            disabled={status === "linking" || code.trim().length === 0}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-all hover:bg-neutral-200 disabled:opacity-40"
          >
            {status === "linking" ? "Linking..." : "Link"}
          </button>
        </div>
      </div>

      {message ? (
        <p
          className={
            status === "error"
              ? "text-sm text-red-400"
              : "text-sm text-muted-foreground"
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

function redeemErrorMessage(status: string): string {
  switch (status) {
    case "expired":
      return "The code has expired. Generate a new one in the bot with /link.";
    case "consumed":
      return "This code has already been used.";
    case "invalid_code":
      return "Invalid code. Double-check the characters and try again.";
    case "wrong_direction":
      return "This code can't be redeemed here. Use the bot to redeem deep links.";
    case "target_already_linked":
      return "Your account is already linked to a different Telegram. Unlink it first.";
    default:
      return "Linking failed. Please try again.";
  }
}
