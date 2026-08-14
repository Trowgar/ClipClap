"use client";

interface FreeTrialUsage {
  usedMinutes: number;
  limitMinutes: number;
}

interface UsageBarProps {
  used: number;
  limit: number;
  topup: number;
  plan: string;
  freeTrial?: FreeTrialUsage | null;
}

export function UsageBar({ used, limit, topup, plan, freeTrial }: UsageBarProps) {
  if (plan === "NONE" || limit === 0) {
    // The free allowance gets the same bar treatment as a paid plan - a dead
    // "No active plan" box told a free user nothing about the 60 lifetime
    // minutes they are actually holding (FREE_TIER, plans.ts).
    if (freeTrial && freeTrial.limitMinutes > 0) {
      const percent = Math.min(
        100,
        Math.round((freeTrial.usedMinutes / freeTrial.limitMinutes) * 100)
      );
      const critical = percent >= 90;
      return (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Free minutes</span>
            <span className="font-mono tabular-nums">
              {freeTrial.usedMinutes} / {freeTrial.limitMinutes}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded bg-white/[0.06]">
            <div
              className={`h-full transition-all ${critical ? "bg-red-500" : "bg-white/70"}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">
              Plan: <span className="text-foreground font-medium">Free</span>
            </span>
            <span className="text-muted-foreground">one-time</span>
          </div>
        </div>
      );
    }
    return (
      <div className="rounded-md border border-border p-3">
        <p className="text-xs text-muted-foreground">No active plan</p>
      </div>
    );
  }

  const percent = Math.min(100, Math.round((used / limit) * 100));
  const critical = percent >= 90;

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Minutes</span>
        <span className="font-mono tabular-nums">
          {used} / {limit}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-white/[0.06]">
        <div
          className={`h-full transition-all ${critical ? "bg-red-500" : "bg-white/70"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">
          Plan: <span className="text-foreground font-medium">{plan}</span>
        </span>
        {topup > 0 && (
          <span className="text-emerald-400">+{topup} top-up</span>
        )}
      </div>
    </div>
  );
}
