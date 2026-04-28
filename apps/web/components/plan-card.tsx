"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { Plan, BillingCycle } from "@prisma/client";
import { api } from "@/lib/api";

interface CycleOption {
  label: string;
  cycle: BillingCycle;
  priceUsd: number;
  minutes: number;
}

interface PlanCardProps {
  name: string;
  planKey: Exclude<Plan, "NONE">;
  cycleOptions: CycleOption[];
  features: string[];
  current?: boolean;
  currentCycle?: BillingCycle | null;
  highlighted?: boolean;
}

export function PlanCard({
  name,
  planKey,
  cycleOptions,
  features,
  current,
  currentCycle,
  highlighted,
}: PlanCardProps) {
  const [selectedCycle, setSelectedCycle] = useState<BillingCycle>(
    cycleOptions[0]?.cycle ?? "MONTHLY"
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = cycleOptions.find((c) => c.cycle === selectedCycle) ?? cycleOptions[0];
  const isCurrent = current && currentCycle === selectedCycle;

  const onSubscribe = async () => {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api.billing.checkout(planKey, selectedCycle);
      if (url) window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={`relative rounded-2xl border p-6 transition-colors ${
        highlighted
          ? "border-white/20 bg-white/[0.03]"
          : "border-white/[0.06] bg-white/[0.01]"
      }`}
    >
      {highlighted && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-white px-3 py-0.5 text-[11px] font-semibold text-black">
          Popular
        </span>
      )}
      <h3 className="font-semibold text-white">{name}</h3>

      {cycleOptions.length > 1 && (
        <div className="mt-3 inline-flex gap-1 rounded-md bg-white/[0.04] p-1">
          {cycleOptions.map((c) => (
            <button
              key={c.cycle}
              onClick={() => setSelectedCycle(c.cycle)}
              className={`rounded px-3 py-1 text-xs transition-colors ${
                selectedCycle === c.cycle
                  ? "bg-white/[0.12] text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <p className="mt-4">
        <span className="text-3xl font-bold tabular-nums text-white">${selected.priceUsd}</span>
        <span className="text-sm text-neutral-500">
          /{selected.cycle === "WEEKLY" ? "week" : "month"}
        </span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{selected.minutes} minutes</p>

      <ul className="mt-5 space-y-2 text-sm text-neutral-400">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500" />
            {f}
          </li>
        ))}
      </ul>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <button
        onClick={onSubscribe}
        disabled={loading || isCurrent}
        className={`mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-60 ${
          isCurrent
            ? "cursor-not-allowed bg-white/[0.04] text-neutral-500"
            : highlighted
              ? "bg-white text-black hover:bg-neutral-200"
              : "bg-white/[0.06] text-white hover:bg-white/[0.1]"
        }`}
      >
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {isCurrent ? "Current plan" : loading ? "Loading…" : "Subscribe"}
      </button>
    </div>
  );
}
