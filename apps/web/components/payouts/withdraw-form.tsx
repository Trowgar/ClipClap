"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleNotch } from "@phosphor-icons/react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const METHODS = [
  { value: "USDT_TRC20", label: "USDT (TRC20)" },
  { value: "USDT_ERC20", label: "USDT (ERC20)" },
  { value: "BTC", label: "Bitcoin" },
  { value: "ETH", label: "Ethereum" },
  { value: "USDC", label: "USDC" },
];

export function WithdrawForm({ availableUsd, minUsd }: { availableUsd: number; minUsd: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [method, setMethod] = useState("USDT_TRC20");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const belowMin = availableUsd < minUsd;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/payouts/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, destination, amountUsd: Number(amount) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Couldn't submit");
        return;
      }
      toast({ title: "Withdrawal requested, under review" });
      startTransition(() => router.refresh());
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (belowMin) {
    return (
      <p className="text-sm text-muted-foreground">
        You need at least ${minUsd.toFixed(2)} available to withdraw.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-xs text-muted-foreground">Method</div>
        <div className="flex flex-wrap gap-2">
          {METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMethod(m.value)}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm transition-colors",
                method === m.value
                  ? "border-foreground text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <input
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        placeholder="Destination address"
        spellCheck={false}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
      />
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        placeholder={`Amount ($${minUsd} - $${availableUsd.toFixed(2)})`}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm tabular-nums"
      />
      <button
        type="button"
        onClick={submit}
        disabled={submitting || !destination.trim() || !amount}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {submitting && <CircleNotch weight="bold" className="h-3.5 w-3.5 animate-spin" />}
        Withdraw
      </button>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
