"use client";

import { useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type { TopupPack } from "@clipclap/shared";
import { api } from "@/lib/api";
import { trackConversion } from "@/lib/conversion";

interface TopupButtonProps {
  pack: TopupPack;
  minutes: number;
  priceUsd: number;
  requiredDurationSec?: number;
  remainingMinutes?: number;
  maxSourceDurationMinutes?: number;
  enabled?: boolean;
}

export function TopupButton({ pack, minutes, priceUsd, requiredDurationSec, remainingMinutes,
  maxSourceDurationMinutes, enabled = true }: TopupButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let unavailable: string | null = enabled ? null : "An active, unexpired subscription is required to buy minutes.";
  if (!unavailable && requiredDurationSec !== undefined) {
    if (!Number.isFinite(requiredDurationSec) || requiredDurationSec <= 0) {
      unavailable = "The source duration is invalid. Check your video before buying.";
    } else if (maxSourceDurationMinutes === undefined || !Number.isFinite(maxSourceDurationMinutes) || maxSourceDurationMinutes <= 0 ||
      remainingMinutes === undefined || !Number.isFinite(remainingMinutes)) {
      unavailable = "Refresh your balance and source limit before buying minutes.";
    } else if (requiredDurationSec > maxSourceDurationMinutes * 60) {
      unavailable = `Top-ups cannot raise the ${maxSourceDurationMinutes}-minute source limit. Use a shorter source.`;
    } else if (requiredDurationSec > (remainingMinutes + minutes) * 60) {
      unavailable = "This pack plus your balance does not cover this video. Choose a larger pack.";
    }
  }

  const onBuy = async () => {
    if (loading || unavailable) return;
    setLoading(true);
    setError(null);
    try {
      trackConversion("checkout_clicked", { placement: "plans", pack, durationSec: requiredDurationSec });
      const { url } = await api.billing.topup(pack, requiredDurationSec);
      if (url) window.location.href = url;
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
        {unavailable && <p className="mt-1 text-xs text-muted-foreground">{unavailable}</p>}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <button
        onClick={onBuy}
        disabled={loading || unavailable !== null}
        className="inline-flex items-center gap-2 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-neutral-200 disabled:opacity-60"
      >
        {loading && <CircleNotch weight="bold" className="h-3.5 w-3.5 animate-spin" />}
        Buy
      </button>
    </div>
  );
}
