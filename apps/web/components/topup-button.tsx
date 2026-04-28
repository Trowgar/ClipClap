"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

interface TopupButtonProps {
  pack: "SMALL" | "LARGE";
  minutes: number;
  priceUsd: number;
}

export function TopupButton({ pack, minutes, priceUsd }: TopupButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onBuy = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/billing/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed to start checkout");
      if (data.url) window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Top-up failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-white/[0.01] p-4">
      <div>
        <p className="font-medium">+{minutes} minutes</p>
        <p className="text-xs text-muted-foreground">${priceUsd} one-time</p>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <button
        onClick={onBuy}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-neutral-200 disabled:opacity-60"
      >
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Buy
      </button>
    </div>
  );
}
