"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleNotch } from "@phosphor-icons/react";
import { useToast } from "@/hooks/use-toast";

/**
 * Accepts the affiliate terms (issues the referral code) then refreshes the
 * server component to reveal the dashboard.
 */
export function JoinAffiliate() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();

  async function join() {
    setLoading(true);
    try {
      const res = await fetch("/api/referrals/accept-terms", { method: "POST" });
      if (!res.ok) throw new Error("Request failed");
      startTransition(() => router.refresh());
    } catch {
      toast({ title: "Couldn't join. Please try again." });
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={join}
      disabled={loading}
      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
    >
      {loading && <CircleNotch weight="bold" className="h-3.5 w-3.5 animate-spin" />}
      Join the program
    </button>
  );
}
